/**
 * Cleanup companion to scripts/seed-checkpoint-test-data.ts.
 *
 * Removes the artifacts of the Phase 16 Plan 04 Task 2 operator checkpoint:
 *   - Trashes any Drive files still present under supplier folder CHECKPOINT-TEST
 *   - Trashes any Drive files still present under MANUAL/<CHECKPOINT-TEST-pid>/
 *     (Phase 17 B-3 — handleReplace hardcodes supplierCode='MANUAL', so the
 *     checkpoint flow scatters orphan files there too.)
 *   - Deletes the 2 CHECKPOINT-TEST-001 / CHECKPOINT-TEST-002 rows from Bestsellers-Ready
 *
 * Idempotent — safe to run multiple times.
 *
 * Run: NODE_OPTIONS=--use-system-ca npx tsx scripts/cleanup-checkpoint-test-data.ts
 */

import { fileURLToPath } from 'url';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient, trashDriveFile } from '../src/sheets/drive.js';

const SHEET_NAME = 'Bestsellers-Ready';
const SUPPLIER_PREFIX = 'CHECKPOINT-TEST';
export const TEST_PIDS = ['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002'];
// Mirrors the default in src/sheets/drive.ts so this script targets the same root.
const ROOT_FOLDER_ID =
  process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

async function findSupplierFolderId(
  drive: ReturnType<typeof createDriveClient>,
): Promise<string | null> {
  const q = `'${ROOT_FOLDER_ID}' in parents and name = '${SUPPLIER_PREFIX}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id ?? null;
}

/**
 * Locate the root `MANUAL/` folder under the configured Drive images root.
 *
 * Phase 16's checkpoint flow uploads FORCE-replacement images via
 * `scripts/fix-image-pollution-manual.ts` `handleReplace`, which hardcodes
 * `supplierCode='MANUAL'`. The result: leftover files for the test pids land
 * under `MANUAL/CHECKPOINT-TEST-001/` and `MANUAL/CHECKPOINT-TEST-002/`,
 * NOT under `CHECKPOINT-TEST/`. We look up `MANUAL/` so the cleanup can
 * descend into the per-pid subfolders.
 *
 * Returns null if the folder doesn't exist — common on accounts that haven't
 * yet run an operator FORCE-replace.
 */
async function findManualFolderId(
  drive: ReturnType<typeof createDriveClient>,
): Promise<string | null> {
  const q = `'${ROOT_FOLDER_ID}' in parents and name = 'MANUAL' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id ?? null;
}

async function listAllDescendantFiles(
  drive: ReturnType<typeof createDriveClient>,
  folderId: string,
): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const stack = [folderId];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    let pageToken: string | undefined;
    do {
      const r = await drive.files.list({
        q: `'${parent}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of r.data.files ?? []) {
        if (!f.id || !f.name) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          stack.push(f.id);
        } else {
          out.push({ id: f.id, name: f.name });
        }
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return out;
}

async function trashAllCheckpointFiles(
  drive: ReturnType<typeof createDriveClient>,
  deps: {
    findSupplierFolderIdFn: (d: ReturnType<typeof createDriveClient>) => Promise<string | null>;
    listAllDescendantFilesFn: (
      d: ReturnType<typeof createDriveClient>,
      folderId: string,
    ) => Promise<{ id: string; name: string }[]>;
    trashDriveFileFn: typeof trashDriveFile;
  },
): Promise<number> {
  const folderId = await deps.findSupplierFolderIdFn(drive);
  if (!folderId) {
    console.log(`[cleanup] no CHECKPOINT-TEST/ Drive folder found — nothing to trash`);
    return 0;
  }
  const files = await deps.listAllDescendantFilesFn(drive, folderId);
  console.log(`[cleanup] found ${files.length} files under CHECKPOINT-TEST/`);
  let trashed = 0;
  for (const f of files) {
    try {
      await deps.trashDriveFileFn(drive, f.id);
      console.log(`[cleanup]   trashed ${f.name} (${f.id})`);
      trashed++;
    } catch (err) {
      console.warn(`[cleanup]   FAILED to trash ${f.name} (${f.id}): ${err}`);
    }
  }
  // Also trash the (now-empty) CHECKPOINT-TEST folder + its subfolders.
  try {
    await deps.trashDriveFileFn(drive, folderId);
    console.log(`[cleanup]   trashed parent folder CHECKPOINT-TEST/ (${folderId})`);
  } catch (err) {
    console.warn(`[cleanup]   could not trash parent folder: ${err}`);
  }
  return trashed;
}

/**
 * Phase 17 B-3 — scan MANUAL/ for per-checkpoint-pid subfolders and trash
 * their contents.
 *
 * Threat T-17-23: only enumerate `MANUAL/<exact-test-pid>/` subfolders.
 *   The per-pid lookup queries `name = '<TEST_PID>'` with an exact match, so
 *   real operator FORCE-replace folders (e.g., `MANUAL/S05610/`) are never
 *   touched.
 *
 * Threat T-17-24: trash only the per-pid subfolder, NEVER the `MANUAL/`
 *   parent. Operators may have other real per-pid folders living under
 *   `MANUAL/`; trashing the parent would destroy unrelated production data.
 *
 * Returns the number of descendant files trashed (per-pid folder count is
 * not included).
 */
async function trashCheckpointArtifactsInManualFolder(
  drive: ReturnType<typeof createDriveClient>,
  deps: {
    findManualFolderIdFn: (d: ReturnType<typeof createDriveClient>) => Promise<string | null>;
    listAllDescendantFilesFn: (
      d: ReturnType<typeof createDriveClient>,
      folderId: string,
    ) => Promise<{ id: string; name: string }[]>;
    trashDriveFileFn: typeof trashDriveFile;
  },
): Promise<number> {
  const manualId = await deps.findManualFolderIdFn(drive);
  if (!manualId) {
    console.log('[cleanup] no MANUAL/ Drive folder found — nothing to trash');
    return 0;
  }
  let trashed = 0;
  for (const pid of TEST_PIDS) {
    // T-17-23 mitigation: exact-match `name = '<TEST_PID>'`. No recursion into
    // unrelated MANUAL/ subfolders.
    const r = await drive.files.list({
      q: `'${manualId}' in parents and name = '${pid}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const pidFolder = r.data.files?.[0]?.id;
    if (!pidFolder) continue;
    const descendants = await deps.listAllDescendantFilesFn(drive, pidFolder);
    for (const f of descendants) {
      try {
        await deps.trashDriveFileFn(drive, f.id);
        console.log(`[cleanup]   MANUAL/ trashed ${f.name} (${f.id})`);
        trashed++;
      } catch (err) {
        console.warn(`[cleanup]   FAILED to trash ${f.name} (${f.id}): ${err}`);
      }
    }
    // T-17-24 mitigation: trash ONLY the per-pid subfolder, NEVER the
    // MANUAL/ root.
    try {
      await deps.trashDriveFileFn(drive, pidFolder);
      console.log(`[cleanup]   MANUAL/ trashed folder ${pid} (${pidFolder})`);
    } catch (err) {
      console.warn(`[cleanup]   could not trash MANUAL/${pid}: ${err}`);
    }
  }
  return trashed;
}

async function deleteBrRows(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
): Promise<number> {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'`,
  });
  const rows = (resp.data.values ?? []) as string[][];
  if (rows.length === 0) {
    console.log(`[cleanup] '${SHEET_NAME}' is empty — nothing to delete`);
    return 0;
  }
  const headers = rows[0];
  const pidIdx = headers.indexOf('productId');
  if (pidIdx < 0) {
    console.warn(`[cleanup] productId column not found in '${SHEET_NAME}' — skipping row delete`);
    return 0;
  }
  // Collect 0-based row indices (in sheet coords) for the test pids. Sort descending
  // so deleteDimension index math stays correct across multiple deletes.
  const targets: { pid: string; sheetRow0: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const pid = (rows[i][pidIdx] ?? '').trim();
    if (TEST_PIDS.includes(pid)) {
      targets.push({ pid, sheetRow0: i });
    }
  }
  if (targets.length === 0) {
    console.log(`[cleanup] no CHECKPOINT-TEST-* rows found in '${SHEET_NAME}'`);
    return 0;
  }

  // Need sheetId for batchUpdate.deleteDimension.
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) {
    console.warn(`[cleanup] could not resolve sheetId for '${SHEET_NAME}' — skipping row delete`);
    return 0;
  }

  targets.sort((a, b) => b.sheetRow0 - a.sheetRow0);
  for (const t of targets) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: t.sheetRow0,
                endIndex: t.sheetRow0 + 1,
              },
            },
          },
        ],
      },
    });
    console.log(`[cleanup]   deleted BR row for ${t.pid} (sheet row ${t.sheetRow0 + 1})`);
  }
  return targets.length;
}

/**
 * DI seam for testing: callers pass in already-constructed clients + the
 * helper functions. The production entry point (`main`) wires concrete
 * implementations; tests inject vi.fn() mocks.
 */
export interface CleanupDeps {
  driveClient: ReturnType<typeof createDriveClient>;
  sheetsClient: ReturnType<typeof createSheetsClient>;
  trashDriveFileFn: typeof trashDriveFile;
  findSupplierFolderIdFn: (drive: ReturnType<typeof createDriveClient>) => Promise<string | null>;
  findManualFolderIdFn: (drive: ReturnType<typeof createDriveClient>) => Promise<string | null>;
  listAllDescendantFilesFn: (
    drive: ReturnType<typeof createDriveClient>,
    folderId: string,
  ) => Promise<{ id: string; name: string }[]>;
  deleteBrRowsFn: (
    sheets: ReturnType<typeof createSheetsClient>,
    spreadsheetId: string,
  ) => Promise<number>;
  spreadsheetId?: string;
}

export interface CleanupResult {
  ctTrashed: number;
  manualTrashed: number;
  brRowsDeleted: number;
}

export async function runCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  console.log('[cleanup] scanning CHECKPOINT-TEST/ ...');
  const ctTrashed = await trashAllCheckpointFiles(deps.driveClient, {
    findSupplierFolderIdFn: deps.findSupplierFolderIdFn,
    listAllDescendantFilesFn: deps.listAllDescendantFilesFn,
    trashDriveFileFn: deps.trashDriveFileFn,
  });
  console.log(`  CHECKPOINT-TEST/ files trashed: ${ctTrashed}`);

  console.log('[cleanup] scanning MANUAL/<pid>/ for checkpoint leftovers...');
  const manualTrashed = await trashCheckpointArtifactsInManualFolder(deps.driveClient, {
    findManualFolderIdFn: deps.findManualFolderIdFn,
    listAllDescendantFilesFn: deps.listAllDescendantFilesFn,
    trashDriveFileFn: deps.trashDriveFileFn,
  });
  console.log(`  MANUAL/ leftover files trashed: ${manualTrashed}`);

  let brRowsDeleted = 0;
  if (deps.spreadsheetId) {
    brRowsDeleted = await deps.deleteBrRowsFn(deps.sheetsClient, deps.spreadsheetId);
  }
  return { ctTrashed, manualTrashed, brRowsDeleted };
}

async function main(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('Missing GOOGLE_SPREADSHEET_ID');
    process.exit(1);
  }

  const sheets = createSheetsClient();
  const drive = createDriveClient();

  const result = await runCleanup({
    driveClient: drive,
    sheetsClient: sheets,
    trashDriveFileFn: trashDriveFile,
    findSupplierFolderIdFn: findSupplierFolderId,
    findManualFolderIdFn: findManualFolderId,
    listAllDescendantFilesFn: listAllDescendantFiles,
    deleteBrRowsFn: deleteBrRows,
    spreadsheetId,
  });

  console.log('');
  console.log('===== CLEANUP COMPLETE =====');
  console.log(`  CHECKPOINT-TEST/ files trashed: ${result.ctTrashed}`);
  console.log(`  MANUAL/ files trashed:          ${result.manualTrashed}`);
  console.log(`  BR rows deleted:                ${result.brRowsDeleted}`);
}

// Only run main() when invoked directly (CLI), not when imported by tests.
// This pattern matches Node's standard `import.meta.url === path-of-entry`.
const isDirectInvocation =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  main().catch((err) => {
    console.error('[cleanup] FAILED:', err);
    process.exit(1);
  });
}
