/**
 * Cleanup companion to scripts/seed-checkpoint-test-data.ts.
 *
 * Removes the artifacts of the Phase 16 Plan 04 Task 2 operator checkpoint:
 *   - Trashes any Drive files still present under supplier folder CHECKPOINT-TEST
 *   - Deletes the 2 CHECKPOINT-TEST-001 / CHECKPOINT-TEST-002 rows from Bestsellers-Ready
 *
 * Idempotent — safe to run multiple times.
 *
 * Run: NODE_OPTIONS=--use-system-ca npx tsx scripts/cleanup-checkpoint-test-data.ts
 */

import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient, trashDriveFile } from '../src/sheets/drive.js';

const SHEET_NAME = 'Bestsellers-Ready';
const SUPPLIER_PREFIX = 'CHECKPOINT-TEST';
const TEST_PIDS = ['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002'];
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
): Promise<number> {
  const folderId = await findSupplierFolderId(drive);
  if (!folderId) {
    console.log(`[cleanup] no CHECKPOINT-TEST/ Drive folder found — nothing to trash`);
    return 0;
  }
  const files = await listAllDescendantFiles(drive, folderId);
  console.log(`[cleanup] found ${files.length} files under CHECKPOINT-TEST/`);
  let trashed = 0;
  for (const f of files) {
    try {
      await trashDriveFile(drive, f.id);
      console.log(`[cleanup]   trashed ${f.name} (${f.id})`);
      trashed++;
    } catch (err) {
      console.warn(`[cleanup]   FAILED to trash ${f.name} (${f.id}): ${err}`);
    }
  }
  // Also trash the (now-empty) CHECKPOINT-TEST folder + its subfolders.
  try {
    await trashDriveFile(drive, folderId);
    console.log(`[cleanup]   trashed parent folder CHECKPOINT-TEST/ (${folderId})`);
  } catch (err) {
    console.warn(`[cleanup]   could not trash parent folder: ${err}`);
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

async function main(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('Missing GOOGLE_SPREADSHEET_ID');
    process.exit(1);
  }

  const sheets = createSheetsClient();
  const drive = createDriveClient();

  console.log('[cleanup] trashing CHECKPOINT-TEST/ Drive files…');
  const trashed = await trashAllCheckpointFiles(drive);

  console.log(`[cleanup] deleting CHECKPOINT-TEST-* rows from '${SHEET_NAME}'…`);
  const deleted = await deleteBrRows(sheets, spreadsheetId);

  console.log('');
  console.log('===== CLEANUP COMPLETE =====');
  console.log(`  Drive files trashed: ${trashed}`);
  console.log(`  BR rows deleted:     ${deleted}`);
}

main().catch((err) => {
  console.error('[cleanup] FAILED:', err);
  process.exit(1);
});
