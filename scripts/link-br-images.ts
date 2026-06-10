/**
 * Deterministic Drive→BR image linker (Phase 18-02).
 *
 * Enumerates each supplier/pid Drive folder, parses canonical filenames
 * via the 18-01 parser, joins to BR rows by (productId, normalizeColor),
 * and overwrites the 7 image columns (3 existing + 4 new) with canonical
 * Drive URLs.
 *
 * Default mode: --dry-run (emits diff TSV + miss TSV, writes NOTHING to sheet).
 * Live mode:    --apply  (backs up first, adds absent columns, writes via writeUpdates).
 *
 * Usage:
 *   npx tsx scripts/link-br-images.ts [--dry-run] [--apply] [--supplier <CODE>]
 *
 * Safety invariants:
 *   - Never-blank (D-08): if no Drive file matches (pid,color,role), existing cell is unchanged.
 *   - Idempotent (D-11/OPS-02): a second --apply with identical Drive state produces 0 net changes.
 *   - Header re-read (D-06/OPS-03): column indices are computed from a live header read AFTER
 *     any appendDimension, never from a stale in-memory snapshot.
 *   - Row-1 guard (P5): every emitted range must target sheetRow >= 2.
 *   - URL form: project-canonical `https://drive.google.com/uc?id=<fileId>` — consistent with
 *     uploadToDrive (src/sheets/drive.ts:279) and write-model-urls.ts:181.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient } from '../src/sheets/drive.js';
import { writeUpdates } from '../src/sheets/writer.js';
import { columnToLetter } from '../src/sheets/column-map.js';
import type { EnrichmentUpdate } from '../src/sheets/types.js';
import {
  parseCanonicalFilename,
  normalizeColor,
  ROLE_TO_COLUMN,
  CANONICAL_ROLES,
} from './lib/br-image-parser.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const TAB     = 'Bestsellers-Ready';

/** The 4 new columns this script adds to BR (D-05). */
const NEW_COLUMNS = ['RightSide', 'ModelFront', 'ModelSide', 'ModelBack'] as const;

/** All 7 target column names in BR (3 existing + 4 new). */
const ALL_IMAGE_COLUMNS = [
  'FrontImage',
  'BackImage',
  'DirectSideImage',
  ...NEW_COLUMNS,
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A row describing one cell that will be changed. Written to the diff TSV. */
export interface DiffRow {
  pid: string;
  color: string;
  role: string;
  range: string;
  oldUrl: string;
  newUrl: string;
}

/** A row describing a (pid,color,role) with no matching Drive file. Written to the miss TSV. */
export interface MissRow {
  pid: string;
  color: string;
  role: string;
  existingValue: string;
  reason: 'no-drive-file';
}

/** End-of-run counters (P13 required summary). */
export interface PlanStats {
  written_new: number;
  overwritten_changed: number;
  skipped_already_current: number;
  misses: number;
  skipped_no_pid: number;
}

/** All outputs of buildPlan. */
export interface PlanResult {
  updates: EnrichmentUpdate[];
  diff: DiffRow[];
  misses: MissRow[];
  stats: PlanStats;
}

/** Parameters for buildPlan (dependency-injected for testability). */
export interface BuildPlanArgs {
  /** Live header row (string[]). */
  headers: string[];
  /** Data rows from values.get (string[][]). Row 0 maps to sheetRow 2 (ri+2). */
  dataRows: string[][];
  /**
   * Drive file index: pid → normColor → role → fileId.
   * pid is stored trimmed+uppercased. normColor is normalizeColor(color).
   */
  driveIndex: Map<string, Map<string, Map<string, string>>>;
  /** 0-based column index of the productId header in `headers`. */
  idColIdx: number;
  /** 0-based column index of the colorName header in `headers`. */
  colorColIdx: number;
  /** Produce the canonical URL for a given fileId. */
  urlForFileId: (fileId: string) => string;
  /** Sheet tab name, used in the range string (e.g. `'Bestsellers-Ready'!D2`). */
  tab: string;
}

// ─── Pure core: buildPlan ─────────────────────────────────────────────────────

/**
 * Build the full write plan for one Drive→BR sync pass.
 *
 * Pure function — no Drive or Sheets calls. The driveIndex and urlForFileId
 * are injected so this function is 100% testable without network access.
 *
 * Implements:
 *   - IMG-01 / D-02..D-05: overwrite 7 image columns per matched (pid,color)
 *   - D-08 never-blank: if no Drive file, leave cell unchanged + log miss
 *   - D-11 / OPS-02: if cell already equals canonical URL, skip (delta-only)
 *   - P5 row-1 guard: sheetRow = ri + 2; assert >= 2 before emitting range
 *   - P13 PlanStats: all 5 counters filled
 */
export function buildPlan(args: BuildPlanArgs): PlanResult {
  const { headers, dataRows, driveIndex, idColIdx, colorColIdx, urlForFileId, tab } = args;

  const updates: EnrichmentUpdate[] = [];
  const diff: DiffRow[] = [];
  const misses: MissRow[] = [];
  const stats: PlanStats = {
    written_new: 0,
    overwritten_changed: 0,
    skipped_already_current: 0,
    misses: 0,
    skipped_no_pid: 0,
  };

  // Build header-name → column-index map once.
  const headerIdx = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    headerIdx.set(headers[i], i);
  }

  for (let ri = 0; ri < dataRows.length; ri++) {
    const row = dataRows[ri];

    // P5: sheetRow = ri + 2 (row 0 in dataRows = sheet row 2, because row 1 is the header).
    const sheetRow = ri + 2;
    if (sheetRow < 2) {
      // Defensive guard — should never happen given ri >= 0, but checked explicitly per P5.
      throw new Error(`[link-br-images] Row-1 guard violated: ri=${ri} → sheetRow=${sheetRow}`);
    }

    const rawPid   = row[idColIdx]    ?? '';
    const rawColor = row[colorColIdx] ?? '';

    // Skip rows with no productId.
    const pid = rawPid.trim().toUpperCase();
    if (!pid) {
      stats.skipped_no_pid++;
      continue;
    }

    const normColor = normalizeColor(rawColor);

    // Look up all files for this (pid, normColor) in the Drive index.
    const colorMap = driveIndex.get(pid)?.get(normColor);

    // Process every role via ROLE_TO_COLUMN (D-02..D-05).
    for (const role of CANONICAL_ROLES) {
      const columnName = ROLE_TO_COLUMN[role];
      const colIdx = headerIdx.get(columnName);

      // If this column doesn't exist in the current header, skip it.
      if (colIdx === undefined) continue;

      const existingValue = (row[colIdx] ?? '').trim();
      const fileId = colorMap?.get(role);

      if (!fileId) {
        // D-08 never-blank: no Drive file for this (pid,color,role).
        // Only log a miss if the cell already has content — there's something to protect.
        if (existingValue) {
          misses.push({
            pid,
            color: rawColor,
            role,
            existingValue,
            reason: 'no-drive-file',
          });
          stats.misses++;
        }
        // Regardless, emit no update (never write empty string over a good value).
        continue;
      }

      const newUrl = urlForFileId(fileId);

      // D-11 / OPS-02 idempotency: if the cell already holds the canonical URL, skip.
      if (existingValue === newUrl) {
        stats.skipped_already_current++;
        continue;
      }

      // Emit the update.
      const colLetter = columnToLetter(colIdx);
      const range = `'${tab}'!${colLetter}${sheetRow}`;

      updates.push({ range, values: [[newUrl]] });

      diff.push({ pid, color: rawColor, role, range, oldUrl: existingValue, newUrl });

      if (existingValue === '') {
        stats.written_new++;
      } else {
        stats.overwritten_changed++;
      }
    }
  }

  return { updates, diff, misses, stats };
}

// ─── URL helper ───────────────────────────────────────────────────────────────

/**
 * Produce the project-canonical Drive view URL for a fileId.
 *
 * This form (`uc?id=<fileId>`) is consistent with `uploadToDrive` in
 * src/sheets/drive.ts (line 279) and write-model-urls.ts (line 181) —
 * it is what every other BR image cell already uses.
 */
export function urlForFileId(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}`;
}

// ─── Drive scan helpers ───────────────────────────────────────────────────────

/** Timeout for all Drive API calls (ms). Mirrors DRIVE_TIMEOUT_MS in drive.ts. */
const DRIVE_TIMEOUT_MS = 30_000;
/** Retry budget: 2 retries (3 total attempts). */
const DRIVE_RETRY_MAX = 2;

/** Detect timeout-shaped errors (mirrors isTimeoutError in src/sheets/drive.ts). */
function isTimeoutError(err: unknown): boolean {
  const code = (err as { code?: string | number })?.code;
  const msg  = (err as Error)?.message ?? '';
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT'    ||
    code === 'ERR_CANCELED' ||
    code === 'ENOTFOUND'    ||
    code === 'ECONNRESET'   ||
    code === 'EAI_AGAIN'    ||
    msg.includes('aborted')  ||
    msg.includes('timeout')  ||
    msg.includes('canceled') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNRESET')
  );
}

/** Drive retry wrapper (T-18-06: bounded latency, not exported from drive.ts). */
async function withLocalDriveRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DRIVE_RETRY_MAX; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTimeoutError(err)) throw err;
      console.warn(`[link-br-images] ${label} timeout (attempt ${attempt + 1}/${DRIVE_RETRY_MAX + 1})`);
    }
  }
  throw lastErr ?? new Error(`[link-br-images] ${label} failed after retries`);
}

/** List immediate subfolder children of a parent Drive folder. */
async function listSubfolders(
  drive: drive_v3.Drive,
  parentId: string,
): Promise<{ id: string; name: string }[]> {
  const folders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await withLocalDriveRetry(
      () => drive.files.list(
        {
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        { timeout: DRIVE_TIMEOUT_MS },
      ),
      `listSubfolders parent=${parentId}`,
    );
    for (const f of resp.data.files ?? []) {
      if (f.id && f.name) folders.push({ id: f.id, name: f.name });
    }
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);
  return folders;
}

/**
 * Paginate files.list for a pid folder, parse canonical filenames,
 * and accumulate into a role→fileId map for the given (pid, normColor).
 *
 * Returns Map<normColor, Map<role, fileId>> for all files in the folder.
 */
async function scanPidFolder(
  drive: drive_v3.Drive,
  folderId: string,
  pid: string,
): Promise<Map<string, Map<string, string>>> {
  // normColor → role → fileId
  const result = new Map<string, Map<string, string>>();

  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const resp = await withLocalDriveRetry(
      () => drive.files.list(
        {
          q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 200,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        { timeout: DRIVE_TIMEOUT_MS },
      ),
      `scanPidFolder folder=${folderId} pid=${pid} page=${pageCount + 1}`,
    );
    pageCount++;

    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name) continue;
      const parsed = parseCanonicalFilename(f.name, pid);
      if (!parsed) continue; // non-canonical or malformed — skip silently

      const normColor = normalizeColor(parsed.color);
      if (!result.has(normColor)) result.set(normColor, new Map());

      const roleMap = result.get(normColor)!;
      if (roleMap.has(parsed.role)) {
        // Dedup: first-seen wins; log collision so operator can investigate.
        console.warn(
          `[link-br-images] Collision: pid=${pid} normColor=${normColor} role=${parsed.role} ` +
          `existing=${roleMap.get(parsed.role)} duplicate=${f.id} (${f.name}) — first-seen wins`,
        );
      } else {
        roleMap.set(parsed.role, f.id);
      }
    }

    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  return result;
}

/**
 * Enumerate all supplier subfolders, then all pid subfolders within each supplier.
 * Build the full Drive index: Map<pid, Map<normColor, Map<role, fileId>>>.
 *
 * @param supplierFilter - Optional supplier folder name filter (--supplier flag).
 */
async function buildDriveIndex(
  drive: drive_v3.Drive,
  rootFolderId: string,
  supplierFilter?: string,
): Promise<Map<string, Map<string, Map<string, string>>>> {
  const driveIndex = new Map<string, Map<string, Map<string, string>>>();

  const supplierFolders = await listSubfolders(drive, rootFolderId);
  console.log(`[drive] Found ${supplierFolders.length} supplier folder(s)`);

  for (const supplier of supplierFolders) {
    if (supplierFilter && supplier.name.toUpperCase() !== supplierFilter.toUpperCase()) {
      continue;
    }

    const pidFolders = await listSubfolders(drive, supplier.id);
    console.log(`[drive]   ${supplier.name}: scanning ${pidFolders.length} pid folder(s)...`);

    for (const pidFolder of pidFolders) {
      const pid = pidFolder.name.trim().toUpperCase();
      if (!pid) continue;

      const colorRoleMap = await scanPidFolder(drive, pidFolder.id, pidFolder.name);

      if (colorRoleMap.size > 0) {
        // Merge into the shared index (multiple supplier folders shouldn't share pids,
        // but defensive merge keeps first-seen per (pid,normColor,role)).
        if (!driveIndex.has(pid)) {
          driveIndex.set(pid, colorRoleMap);
        } else {
          const existing = driveIndex.get(pid)!;
          for (const [normColor, roleMap] of colorRoleMap) {
            if (!existing.has(normColor)) {
              existing.set(normColor, roleMap);
            } else {
              const existingRoleMap = existing.get(normColor)!;
              for (const [role, fileId] of roleMap) {
                if (!existingRoleMap.has(role)) existingRoleMap.set(role, fileId);
              }
            }
          }
        }
      }
    }
  }

  return driveIndex;
}

// ─── TSV writers ──────────────────────────────────────────────────────────────

function writeDiffTsv(filepath: string, rows: DiffRow[]): void {
  const header = 'pid\tcolor\trole\trange\toldUrl\tnewUrl\n';
  const body   = rows.map(r =>
    `${r.pid}\t${r.color}\t${r.role}\t${r.range}\t${r.oldUrl}\t${r.newUrl}`
  ).join('\n');
  fs.writeFileSync(filepath, header + body, 'utf8');
}

function writeMissTsv(filepath: string, rows: MissRow[]): void {
  const header = 'pid\tcolor\trole\texistingValue\treason\n';
  const body   = rows.map(r =>
    `${r.pid}\t${r.color}\t${r.role}\t${r.existingValue}\t${r.reason}`
  ).join('\n');
  fs.writeFileSync(filepath, header + body, 'utf8');
}

function writeBackupTsv(
  filepath: string,
  headers: string[],
  dataRows: string[][],
  idColIdx: number,
  colorColIdx: number,
  imageColIndices: number[],
): void {
  const imageHeaders = imageColIndices.map(i => headers[i] ?? `col${i}`);
  const tsvHeader = ['pid', 'color', ...imageHeaders].join('\t') + '\n';

  const lines: string[] = [];
  for (const row of dataRows) {
    const pid   = (row[idColIdx]    ?? '').trim().toUpperCase();
    const color = (row[colorColIdx] ?? '').trim();
    if (!pid) continue;
    const cells = imageColIndices.map(i => row[i] ?? '');
    lines.push([pid, color, ...cells].join('\t'));
  }
  fs.writeFileSync(filepath, tsvHeader + lines.join('\n'), 'utf8');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── CLI args ──────────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const dryRun    = !applyMode; // default is dry-run
  const supplierArgIdx = args.indexOf('--supplier');
  const supplierFilter = supplierArgIdx >= 0 ? args[supplierArgIdx + 1] : undefined;

  // Special test-only flag: --supplier __NONE__ → enumerate nothing (fast smoke-test).
  const emptyRun = supplierFilter === '__NONE__';

  console.log(`=== link-br-images ${dryRun ? '[DRY RUN]' : '[APPLY]'} ===`);
  if (supplierFilter && !emptyRun) console.log(`Supplier filter: ${supplierFilter}`);
  if (emptyRun) console.log('Supplier filter: __NONE__ (empty smoke-test run)');

  // ── Sheets + Drive clients ────────────────────────────────────────────────
  const sheets    = createSheetsClient();
  const sheetsApi = google.sheets({
    version: 'v4',
    auth: (sheets as any).context._options.auth,
  });
  const drive     = createDriveClient();
  const rootFolderId = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID
    ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

  // ── Step 1: Build Drive index ─────────────────────────────────────────────
  let driveIndex: Map<string, Map<string, Map<string, string>>>;
  if (emptyRun) {
    driveIndex = new Map(); // no Drive enumeration for the empty smoke-test
    console.log('[drive] Empty smoke-test run — skipping Drive enumeration');
  } else {
    console.log('\n[drive] Enumerating Drive folders...');
    driveIndex = await buildDriveIndex(drive, rootFolderId, supplierFilter);
    console.log(`[drive] Index built: ${driveIndex.size} pid(s) found`);
  }

  // ── Step 2: Read live header row ──────────────────────────────────────────
  console.log('\n[sheets] Reading header row...');
  const headerResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'!1:1`,
  });
  let headers: string[] = (headerResp.data.values?.[0] ?? []).map((h: unknown) =>
    String(h ?? '').trim()
  );
  console.log(`[sheets] Header row: ${headers.length} column(s)`);

  // ── Step 3 (apply only): Add missing new columns, then RE-READ header ─────
  const sheetIdForAppend = await (async () => {
    if (!applyMode) return 0; // not needed in dry-run
    const meta = await sheetsApi.spreadsheets.get({
      spreadsheetId: MAIN_ID,
      fields: 'sheets.properties',
    });
    const tabMeta = meta.data.sheets?.find(s => s.properties?.title === TAB);
    return tabMeta?.properties?.sheetId ?? 0;
  })();

  if (applyMode) {
    const missingCols = NEW_COLUMNS.filter(c => !headers.includes(c));
    if (missingCols.length > 0) {
      console.log(`[sheets] Adding ${missingCols.length} new column(s): ${missingCols.join(', ')}`);

      // OPS-03/D-06: appendDimension first.
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: MAIN_ID,
        requestBody: {
          requests: [{
            appendDimension: {
              sheetId: sheetIdForAppend,
              dimension: 'COLUMNS',
              length: missingCols.length,
            },
          }],
        },
      });
      console.log(`[sheets] Appended ${missingCols.length} column(s) to grid`);

      // Write column headers into the new positions.
      // We use the OLD header length to derive the starting column — safe here because
      // we haven't re-read yet, but the column names were appended right after existing cols.
      const startIdx = headers.length;
      const headerUpdates: EnrichmentUpdate[] = missingCols.map((col, i) => ({
        range: `'${TAB}'!${columnToLetter(startIdx + i)}1`,
        values: [[col]],
      }));
      await writeUpdates(sheets, MAIN_ID, headerUpdates);

      // D-06/OPS-03: RE-READ the live header row BEFORE computing any data column indices.
      const freshHeaderResp = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: MAIN_ID,
        range: `'${TAB}'!1:1`,
      });
      headers = (freshHeaderResp.data.values?.[0] ?? []).map((h: unknown) =>
        String(h ?? '').trim()
      );
      console.log(`[sheets] Header re-read after append: ${headers.length} column(s)`);
    } else {
      console.log('[sheets] All 4 new columns already exist — no appendDimension needed');
    }
  }

  // Verify all 4 new columns exist by name (in dry-run we just report; in apply we added them above).
  const missingAfterCheck = NEW_COLUMNS.filter(c => !headers.includes(c));
  if (missingAfterCheck.length > 0 && applyMode) {
    throw new Error(`[link-br-images] New columns still missing after append: ${missingAfterCheck.join(', ')}`);
  }
  if (missingAfterCheck.length > 0 && dryRun) {
    console.log(`[dry-run] NOTE: ${missingAfterCheck.length} new column(s) not yet in sheet (will be added on --apply): ${missingAfterCheck.join(', ')}`);
  }

  // Resolve join-key column indices from the live header.
  const idColIdx    = headers.indexOf('productId');
  const colorColIdx = headers.indexOf('colorName');
  if (idColIdx === -1 || colorColIdx === -1) {
    throw new Error(`[link-br-images] Required columns not found in header: productId=${idColIdx}, colorName=${colorColIdx}`);
  }

  // ── Step 4: Read all BR data rows (raw, NOT readAllRows — Anti-Pattern 1) ──
  console.log('\n[sheets] Reading all data rows...');
  const dataResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'`,
  });
  const allRows = dataResp.data.values ?? [];
  // Row 0 is the header; dataRows start at row 1 (index 0 in dataRows → sheetRow 2).
  const dataRows = allRows.slice(1) as string[][];
  console.log(`[sheets] Data rows: ${dataRows.length}`);

  // ── Step 5: Build the write plan ─────────────────────────────────────────
  console.log('\n[plan] Building write plan...');
  const plan = buildPlan({
    headers,
    dataRows,
    driveIndex,
    idColIdx,
    colorColIdx,
    urlForFileId,
    tab: TAB,
  });

  // ── Step 6: Always emit diff TSV + miss TSV ───────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDir = path.resolve('tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const diffPath = path.join(tmpDir, `link-br-images-plan-${ts}.tsv`);
  const missPath = path.join(tmpDir, `link-br-images-misses-${ts}.tsv`);
  writeDiffTsv(diffPath, plan.diff);
  writeMissTsv(missPath, plan.misses);
  console.log(`\n[output] Diff TSV:  ${diffPath}`);
  console.log(`[output] Miss TSV:  ${missPath}`);

  // Print stats.
  const { stats } = plan;
  console.log('\n=== Plan Stats ===');
  console.log(`  written_new           : ${stats.written_new}`);
  console.log(`  overwritten_changed   : ${stats.overwritten_changed}`);
  console.log(`  skipped_already_current: ${stats.skipped_already_current}`);
  console.log(`  misses                : ${stats.misses}`);
  console.log(`  skipped_no_pid        : ${stats.skipped_no_pid}`);
  console.log(`  total updates planned : ${plan.updates.length}`);

  if (dryRun) {
    console.log('\n[DRY RUN] No writes to sheet. Pass --apply to execute.');
    return;
  }

  // ── Step 7 (apply only): Backup, then write ───────────────────────────────
  // D-10: backup BEFORE any sheet write.
  const backupPath = path.join(tmpDir, `br-image-backup-${ts}.tsv`);
  const imageColIndices = ALL_IMAGE_COLUMNS.map(col => headers.indexOf(col)).filter(i => i >= 0);
  writeBackupTsv(backupPath, headers, dataRows, idColIdx, colorColIdx, imageColIndices);
  console.log(`\n[backup] Written: ${backupPath}`);

  if (plan.updates.length === 0) {
    console.log('\n[apply] No changes to write — already current.');
    return;
  }

  console.log(`\n[apply] Writing ${plan.updates.length} update(s)...`);
  const written = await writeUpdates(sheets, MAIN_ID, plan.updates);
  console.log(`[apply] Done — ${written} cell(s) written.`);
}

main().catch(err => {
  console.error('[link-br-images] Fatal:', err.message ?? err);
  process.exit(1);
});
