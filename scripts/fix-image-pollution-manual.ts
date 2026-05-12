// Tier 3 interactive manual fix CLI for Phase 16 (SPEC R5, R10, R11).
// Reads tmp/image-pollution-manual-queue-{date}.tsv (Plan 03 output).
// Walks operator through each row; verifier-after-fix on every `r` replacement.
// D-13: choice menu fixed; D-19: `d` requires literal DELETE.
// T-16-01: every Drive write uses origFileId !== newFileId compare-before-trash.
// D-15 resume-from-trail: loadProcessedPids silently skips terminal-operation pids.
// R10 OR-path: --re-audit triggers post-fix audit AND computes BR_WRITE coverage
//   from today's trail; R10 SATISFIED when re-audit=0 OR coverage=100%.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import {
  createDriveClient,
  extractFileId,
  downloadFromDrive,
  trashDriveFile,
  uploadToDrive,
} from '../src/sheets/drive.js';
import { writeUpdates } from '../src/sheets/writer.js';
import { columnToLetter } from '../src/sheets/column-map.js';
import { verifySameProduct } from '../src/lib/verify-same-product.js';
import { resolveSupplierCanonical } from '../src/lib/supplier-canonical.js';
import {
  appendTrailRow,
  getOrCreateTrailRunId,
  loadProcessedPids,
} from '../src/lib/image-pollution-trail.js';
import { logger } from '../src/lib/logger.js';
import type { sheets_v4, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManualQueueRow {
  pid: string;
  pollution_class: string;
  affected_columns: string[];
  current_drive_urls: string[];
  front_image_screenshot_link: string;
  suggested_action: string;
}

export interface RunManualFixArgs {
  queueFile?: string;
  reAudit: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface RunManualFixDeps {
  args: RunManualFixArgs;
  sheetsClient: sheets_v4.Sheets;
  driveClient: drive_v3.Drive;
  openai: OpenAI;
  // DI seam for mocked readline. Tests pass scriptedPrompt(answers).
  promptFn: (q: string) => Promise<string>;
  readRawRowsFn: (
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tab: string,
  ) => Promise<string[][]>;
  downloadFromDriveFn: typeof downloadFromDrive;
  uploadToDriveFn: typeof uploadToDrive;
  trashDriveFileFn: typeof trashDriveFile;
  writeUpdatesFn: typeof writeUpdates;
  verifySameProductFn: typeof verifySameProduct;
  supplierCanonicalFn: typeof resolveSupplierCanonical;
  appendTrailRowFn: typeof appendTrailRow;
  loadProcessedPidsFn: typeof loadProcessedPids;
  // R10 OR-path helpers (revision iter 1).
  runAuditFn?: (args: { reAudit: true }) => Promise<{ pollutedCount: number }>;
  loadOriginalAuditPidsFn?: (date: string) => Promise<Set<string>>;
  loadBrWritePidsFromTrailFn?: (date: string) => Promise<Set<string>>;
  spreadsheetId: string;
  sheetName: string;
  // Test-only override — bypass parseManualQueueTsv + queue file discovery.
  manualQueueOverride?: ManualQueueRow[];
}

export interface RunManualFixResult {
  resolved: number;
  skipped: number;
  accepted: number;
  quit: boolean;
  // R10 status string (only filled when --re-audit ran).
  reAudit?: {
    pollutedCount: number;
    brWriteCovered: number;
    originalPolluted: number;
    coveragePct: number;
    status: 'SATISFIED' | 'PARTIAL';
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Manual Image Pollution Fix CLI — Phase 16 Plan 04 (Tier 3)

Reads tmp/image-pollution-manual-queue-{date}.tsv (produced by Plan 03's
fix orchestrator) and walks each row interactively.

Per-row choices (D-13):
  [r]eplace        Replace with operator-supplied URL (verifier-after-fix runs)
  [s]kip           Skip — log MANUAL_SKIP, no mutation
  [a]ccept-as-is   Accept current image — log MANUAL_ACCEPT, no mutation
  [d]elete         Blank BR cell + trash Drive file (literal DELETE required)
  [v]iew           Print full pid context, then re-prompt
  [q]uit           Save & exit (per-row trail fsync from Plan 01 ensures resume)

Usage:
  npx tsx scripts/fix-image-pollution-manual.ts                       # newest queue
  npx tsx scripts/fix-image-pollution-manual.ts --queue-file path/to.tsv
  npx tsx scripts/fix-image-pollution-manual.ts --re-audit            # post-loop re-audit
  npx tsx scripts/fix-image-pollution-manual.ts --dry-run

Env vars required (real-network run):
  OPENAI_API_KEY, GOOGLE_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY
`);
}

// ---------------------------------------------------------------------------
// Default raw-row reader (mirrors scripts/fix-image-pollution.ts:defaultReadRawRows)
// ---------------------------------------------------------------------------

export async function defaultReadRawRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tab: string,
): Promise<string[][]> {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'`,
  });
  return (resp.data.values ?? []) as string[][];
}

// ---------------------------------------------------------------------------
// parseManualQueueTsv — parse the Plan 03 manual queue TSV (6-col schema)
// ---------------------------------------------------------------------------

export async function parseManualQueueTsv(
  path: string,
): Promise<ManualQueueRow[]> {
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    logger.warn(`[fix-image-pollution-manual] could not read queue TSV ${path}: ${err}`);
    return [];
  }
  const out: ManualQueueRow[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.startsWith('pid\t')) continue; // header
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    out.push({
      pid: cols[0],
      pollution_class: cols[1],
      affected_columns: cols[2]
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
      current_drive_urls: cols[3]
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
      front_image_screenshot_link: cols[4] ?? '',
      suggested_action: cols[5] ?? '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// promptForChoice — loop until a valid letter is entered
// ---------------------------------------------------------------------------

export async function promptForChoice(
  promptFn: (q: string) => Promise<string>,
  prompt: string,
  validChoices: string[],
): Promise<string> {
  // Hard cap on retries to prevent test infinite loops if scripted answers
  // run out (the scripted helper will throw before we hit this anyway).
  for (let i = 0; i < 100; i++) {
    const answer = (await promptFn(prompt)).trim().toLowerCase();
    if (validChoices.includes(answer)) return answer;
    console.log(
      `Invalid choice. Expected one of: ${validChoices.join(', ')}`,
    );
  }
  throw new Error('promptForChoice: exceeded 100 retries');
}

// ---------------------------------------------------------------------------
// BR row index map — re-derive (pid → row-index, columnName → col-index)
// ---------------------------------------------------------------------------

interface BrIndex {
  headerMap: Record<string, number>;
  rowByPid: Map<string, { rowIndex0: number; row: string[] }>;
}

function buildBrIndex(rawRows: string[][]): BrIndex {
  const headerMap: Record<string, number> = {};
  const rowByPid = new Map<string, { rowIndex0: number; row: string[] }>();
  if (rawRows.length === 0) {
    return { headerMap, rowByPid };
  }
  rawRows[0].forEach((h, i) => {
    headerMap[h] = i;
  });
  const pidIdx = headerMap['productId'] ?? -1;
  if (pidIdx < 0) return { headerMap, rowByPid };
  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;
    const pid = String(row[pidIdx] ?? '').trim();
    if (!pid) continue;
    if (!rowByPid.has(pid)) {
      rowByPid.set(pid, { rowIndex0: i, row });
    }
  }
  return { headerMap, rowByPid };
}

// ---------------------------------------------------------------------------
// handleManualRow — per-row prompt loop with branches for each choice letter
// ---------------------------------------------------------------------------

type HandleRowOutcome = 'resolved' | 'skipped' | 'accepted' | 'quit';

export async function handleManualRow(
  row: ManualQueueRow,
  brIndex: BrIndex,
  deps: RunManualFixDeps,
  runId: string,
): Promise<HandleRowOutcome> {
  const brEntry = brIndex.rowByPid.get(row.pid);

  // Print pid context (RESEARCH lines 540-543 + D-13 — visual ergonomics).
  console.log(`\n--- pid: ${row.pid} (${row.pollution_class}) ---`);
  console.log(`  Affected columns: ${row.affected_columns.join(', ')}`);
  for (const url of row.current_drive_urls) {
    const fid = extractFileId(url);
    console.log(`  ${fid ? `https://drive.google.com/uc?id=${fid}` : url}`);
  }
  if (row.front_image_screenshot_link) {
    console.log(`  Front screenshot: ${row.front_image_screenshot_link}`);
  }
  if (row.suggested_action) {
    console.log(`  Suggested action: ${row.suggested_action}`);
  }

  const choice = await promptForChoice(
    deps.promptFn,
    '[r]eplace | [s]kip | [a]ccept-as-is | [d]elete | [v]iew | [q]uit: ',
    ['r', 's', 'a', 'd', 'v', 'q'],
  );

  // -------------------------------------------------------------------------
  // `s` — log MANUAL_SKIP; no mutations; R11: NOT resolved (no BR_WRITE).
  // -------------------------------------------------------------------------
  if (choice === 's') {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_SKIP',
      column_or_path: row.affected_columns.join(','),
      old_value: row.current_drive_urls.join(','),
      new_value: '',
      tier: 3,
      run_id: runId,
      notes: 'operator skipped',
    });
    return 'skipped';
  }

  // -------------------------------------------------------------------------
  // `a` — log MANUAL_ACCEPT; no mutations; R11: NOT resolved.
  // -------------------------------------------------------------------------
  if (choice === 'a') {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_ACCEPT',
      column_or_path: row.affected_columns.join(','),
      old_value: row.current_drive_urls.join(','),
      new_value: '',
      tier: 3,
      run_id: runId,
      notes: 'operator accepted as-is',
    });
    return 'accepted';
  }

  // -------------------------------------------------------------------------
  // `q` — save & exit. Per-row trail fsync from Plan 01 handles durability.
  // -------------------------------------------------------------------------
  if (choice === 'q') {
    return 'quit';
  }

  // -------------------------------------------------------------------------
  // `v` — print every cell of the pid's BR row + recurse into handleManualRow.
  // -------------------------------------------------------------------------
  if (choice === 'v') {
    console.log(`\n  === Full BR row for ${row.pid} ===`);
    if (brEntry) {
      const headers = Object.keys(brIndex.headerMap);
      const interesting = [
        'productId',
        'colorName',
        'styleID',
        'productName',
        'FrontImage',
        'BackImage',
        'DirectSideImage',
        'ModelFrontImage',
        'ModelSideImage',
        'ModelBackImage',
      ];
      for (const h of interesting) {
        const idx = brIndex.headerMap[h];
        if (idx === undefined) continue;
        const val = String(brEntry.row[idx] ?? '');
        console.log(`    ${h}: ${val}`);
      }
      // Spread remaining headers as a single line for context completeness.
      const dumped = new Set(interesting);
      for (const h of headers) {
        if (dumped.has(h)) continue;
        const idx = brIndex.headerMap[h];
        const val = String(brEntry.row[idx] ?? '');
        if (val) console.log(`    ${h}: ${val}`);
      }
    } else {
      console.log(`    (BR row not found for ${row.pid})`);
    }
    // Re-prompt the same pid (recurse).
    return handleManualRow(row, brIndex, deps, runId);
  }

  // -------------------------------------------------------------------------
  // `d` — blank BR cell + trash Drive file. Literal DELETE confirmation gates.
  // -------------------------------------------------------------------------
  if (choice === 'd') {
    const confirm = (await deps.promptFn('Type DELETE to confirm: ')).trim();
    if (confirm !== 'DELETE') {
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid: row.pid,
        operation: 'MANUAL_SKIP',
        column_or_path: row.affected_columns.join(','),
        old_value: row.current_drive_urls.join(','),
        new_value: '',
        tier: 3,
        run_id: runId,
        notes: 'delete aborted — confirmation mismatch',
      });
      return 'skipped';
    }
    if (!brEntry) {
      logger.warn(
        `[fix-image-pollution-manual] no BR row for ${row.pid} — cannot delete`,
      );
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid: row.pid,
        operation: 'MANUAL_SKIP',
        column_or_path: row.affected_columns.join(','),
        old_value: row.current_drive_urls.join(','),
        new_value: '',
        tier: 3,
        run_id: runId,
        notes: 'delete aborted — BR row not found',
      });
      return 'skipped';
    }
    // Iterate each affected column: blank cell + trash file.
    for (let i = 0; i < row.affected_columns.length; i++) {
      const col = row.affected_columns[i];
      const currentUrl = row.current_drive_urls[i] ?? '';
      const colIdx = brIndex.headerMap[col];
      if (colIdx === undefined) {
        logger.warn(`[fix-image-pollution-manual] column ${col} not in header`);
        continue;
      }
      const range = `'${deps.sheetName}'!${columnToLetter(colIdx)}${brEntry.rowIndex0 + 1}`;
      if (!deps.args.dryRun) {
        try {
          await deps.writeUpdatesFn(deps.sheetsClient, deps.spreadsheetId, [
            { range, values: [['']] },
          ]);
        } catch (err) {
          logger.warn(
            `[fix-image-pollution-manual] writeUpdates blank failed for ${row.pid}/${col}: ${err}`,
          );
        }
      }
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid: row.pid,
        operation: 'BR_WRITE',
        column_or_path: col,
        old_value: currentUrl,
        new_value: '',
        tier: 3,
        run_id: runId,
        notes: 'operator deleted in manual queue',
      });
      const origFileId = extractFileId(currentUrl);
      if (origFileId) {
        try {
          await deps.trashDriveFileFn(deps.driveClient, origFileId);
        } catch (err) {
          logger.warn(
            `[fix-image-pollution-manual] trashDriveFile failed for ${row.pid}: ${err}`,
          );
        }
        await deps.appendTrailRowFn({
          timestamp_iso: new Date().toISOString(),
          pid: row.pid,
          operation: 'DRIVE_DELETE',
          column_or_path: origFileId,
          old_value: origFileId,
          new_value: '',
          tier: 3,
          run_id: runId,
          notes: 'operator deleted in manual queue',
        });
      }
    }
    return 'resolved';
  }

  // -------------------------------------------------------------------------
  // `r` — replace with operator-supplied URL. Verifier-after-fix gates commit.
  // -------------------------------------------------------------------------
  if (choice === 'r') {
    return await handleReplace(row, brIndex, deps, runId);
  }

  // Should be unreachable due to promptForChoice validation.
  return 'skipped';
}

// ---------------------------------------------------------------------------
// `r` choice handler — operator URL prompt, verifier-after-fix, optional FORCE.
// Split into a helper to keep handleManualRow readable + enable test isolation.
// ---------------------------------------------------------------------------

async function handleReplace(
  row: ManualQueueRow,
  brIndex: BrIndex,
  deps: RunManualFixDeps,
  runId: string,
): Promise<HandleRowOutcome> {
  const brEntry = brIndex.rowByPid.get(row.pid);
  if (!brEntry) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_SKIP',
      column_or_path: row.affected_columns.join(','),
      old_value: row.current_drive_urls.join(','),
      new_value: '',
      tier: 3,
      run_id: runId,
      notes: 'replace aborted — BR row not found',
    });
    return 'skipped';
  }

  // Prompt for new URL / fileId. T-16-09 (paste error tolerance): empty → re-ask.
  let newInputRaw = '';
  for (let i = 0; i < 5; i++) {
    newInputRaw = (await deps.promptFn('New URL or fileId: ')).trim();
    if (newInputRaw) break;
  }
  if (!newInputRaw) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_SKIP',
      column_or_path: row.affected_columns.join(','),
      old_value: row.current_drive_urls.join(','),
      new_value: '',
      tier: 3,
      run_id: runId,
      notes: 'replace aborted — empty URL',
    });
    return 'skipped';
  }
  // Accept bare fileId OR Drive URL (RESEARCH line 552 fallback).
  const newFileId = extractFileId(newInputRaw) ?? newInputRaw;

  // Apply replacement to the FIRST affected column (the row's primary fix
  // target). If multiple columns are listed, operator should run replace
  // per-column; the queue typically lists one primary per row.
  const col = row.affected_columns[0] ?? 'FrontImage';
  const currentUrl = row.current_drive_urls[0] ?? '';

  // Download the operator's candidate.
  let candidateBuf: Buffer;
  try {
    candidateBuf = await deps.downloadFromDriveFn(deps.driveClient, newFileId);
  } catch (err) {
    logger.warn(
      `[fix-image-pollution-manual] candidate download failed for ${row.pid}/${col}: ${err}`,
    );
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_SKIP',
      column_or_path: col,
      old_value: currentUrl,
      new_value: newFileId,
      tier: 3,
      run_id: runId,
      notes: `candidate download failed: ${err}`,
    });
    return 'skipped';
  }

  // Determine SoT (source-of-truth) reference buffer.
  // - FrontImage: try supplier canonical first (the truth); fall back to skip
  //   the verifier altogether (D-17 tautology — operator-trusted).
  // - Else: SoT = current BR FrontImage downloaded from Drive.
  let sotBuf: Buffer | null = null;
  let verifyForceNotes = '';
  if (col === 'FrontImage') {
    try {
      const canonical = await deps.supplierCanonicalFn(row.pid);
      if (canonical) {
        // Download canonical via Drive helper if it's a Drive URL, otherwise
        // skip verifier (no easy way to fetch arbitrary HTTP from this helper
        // without a separate downloadImage dep — the operator-trusted path
        // applies).
        const canonicalFid = extractFileId(canonical.url);
        if (canonicalFid) {
          try {
            sotBuf = await deps.downloadFromDriveFn(
              deps.driveClient,
              canonicalFid,
            );
          } catch {
            sotBuf = null;
          }
        }
      }
    } catch {
      sotBuf = null;
    }
  } else {
    const frontUrl = String(
      brEntry.row[brIndex.headerMap['FrontImage'] ?? -1] ?? '',
    );
    const frontFid = extractFileId(frontUrl);
    if (frontFid) {
      try {
        sotBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
      } catch {
        sotBuf = null;
      }
    }
  }

  // Run verifier-after-fix (when SoT is available). Skip when not (D-17 path).
  let verifierMatched = true;
  let verifierReason = 'verifier_skipped_no_sot';
  if (sotBuf !== null) {
    let verifyResult: { match: boolean; reason: string };
    try {
      verifyResult = await deps.verifySameProductFn(
        deps.openai,
        candidateBuf,
        sotBuf,
      );
    } catch (err) {
      logger.warn(
        `[fix-image-pollution-manual] verifier crashed for ${row.pid}/${col}: ${err}`,
      );
      verifyResult = { match: false, reason: 'verifier crashed — false-reject' };
    }
    verifierMatched = verifyResult.match;
    verifierReason = verifyResult.reason;
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: verifyResult.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
      column_or_path: col,
      old_value: currentUrl,
      new_value: newFileId,
      tier: 3,
      run_id: runId,
      notes: verifyResult.reason,
    });
  }

  // Secondary prompt on verifier fail: [r]etry | [s]kip | [f]orce.
  if (!verifierMatched) {
    const retry = await promptForChoice(
      deps.promptFn,
      `Verifier rejected: ${verifierReason}. [r]etry | [s]kip | [f]orce (FORCE typed literally): `,
      ['r', 's', 'f'],
    );
    if (retry === 'r') {
      // Re-prompt the entire row (recurse via handleManualRow so operator can
      // pick a different choice if they want).
      return handleManualRow(row, brIndex, deps, runId);
    }
    if (retry === 's') {
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid: row.pid,
        operation: 'MANUAL_SKIP',
        column_or_path: col,
        old_value: currentUrl,
        new_value: newFileId,
        tier: 3,
        run_id: runId,
        notes: 'operator skipped after verifier fail',
      });
      return 'skipped';
    }
    // retry === 'f' — require literal FORCE typing.
    const force = (await deps.promptFn('Type FORCE to confirm: ')).trim();
    if (force !== 'FORCE') {
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid: row.pid,
        operation: 'MANUAL_SKIP',
        column_or_path: col,
        old_value: currentUrl,
        new_value: newFileId,
        tier: 3,
        run_id: runId,
        notes: 'delete aborted — confirmation mismatch',
      });
      return 'skipped';
    }
    verifyForceNotes = `operator forced override of verifier fail: ${verifierReason}`;
  }

  // Commit block — T-16-01 compare-before-trash.
  const origFileId = extractFileId(currentUrl);
  const filename = `${row.pid}_${col}.png`;
  const supplierCode = 'MANUAL';
  const styleId = row.pid;
  let newUrl: string;
  try {
    newUrl = await deps.uploadToDriveFn(
      deps.driveClient,
      candidateBuf,
      filename,
      supplierCode,
      styleId,
    );
  } catch (err) {
    logger.warn(
      `[fix-image-pollution-manual] uploadToDrive failed for ${row.pid}/${col}: ${err}`,
    );
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'MANUAL_SKIP',
      column_or_path: col,
      old_value: currentUrl,
      new_value: newFileId,
      tier: 3,
      run_id: runId,
      notes: `uploadToDrive failed: ${err}`,
    });
    return 'skipped';
  }
  const newFileIdFromUpload = extractFileId(newUrl);

  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid: row.pid,
    operation: 'DRIVE_UPLOAD',
    column_or_path: newFileIdFromUpload ?? newUrl,
    old_value: origFileId ?? '',
    new_value: newFileIdFromUpload ?? '',
    tier: 3,
    run_id: runId,
    notes: `uploaded ${filename}`,
  });

  // T-16-01: only trash when fileIds genuinely differ.
  if (
    origFileId &&
    newFileIdFromUpload &&
    origFileId !== newFileIdFromUpload
  ) {
    try {
      await deps.trashDriveFileFn(deps.driveClient, origFileId);
    } catch (err) {
      logger.warn(
        `[fix-image-pollution-manual] trashDriveFile failed for ${row.pid}: ${err}`,
      );
    }
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid: row.pid,
      operation: 'DRIVE_DELETE',
      column_or_path: origFileId,
      old_value: origFileId,
      new_value: '',
      tier: 3,
      run_id: runId,
      notes: `replaced by ${newFileIdFromUpload}`,
    });
  }
  // T-16-01: else branch — uploadToDrive updated in-place. NEVER trash.

  // BR write (single-cell range).
  const colIdx = brIndex.headerMap[col];
  if (colIdx === undefined) {
    logger.warn(
      `[fix-image-pollution-manual] column ${col} not in header for ${row.pid}`,
    );
    return 'skipped';
  }
  const range = `'${deps.sheetName}'!${columnToLetter(colIdx)}${brEntry.rowIndex0 + 1}`;
  if (!deps.args.dryRun) {
    try {
      await deps.writeUpdatesFn(deps.sheetsClient, deps.spreadsheetId, [
        { range, values: [[newUrl]] },
      ]);
    } catch (err) {
      logger.warn(
        `[fix-image-pollution-manual] writeUpdates failed for ${row.pid}/${col}: ${err}`,
      );
    }
  }
  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid: row.pid,
    operation: 'BR_WRITE',
    column_or_path: col,
    old_value: currentUrl,
    new_value: newUrl,
    tier: 3,
    run_id: runId,
    notes: verifyForceNotes,
  });

  return 'resolved';
}

// ---------------------------------------------------------------------------
// Locate newest manual queue TSV if --queue-file not provided
// ---------------------------------------------------------------------------

function findLatestManualQueueTsv(): string | null {
  if (!existsSync('tmp')) return null;
  let candidates: string[] = [];
  try {
    candidates = readdirSync('tmp').filter((f) =>
      /^image-pollution-manual-queue-\d{4}-\d{2}-\d{2}.*\.tsv$/.test(f),
    );
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return `tmp/${candidates[candidates.length - 1]}`;
}

// ---------------------------------------------------------------------------
// R10 OR-path BR_WRITE coverage helpers
// ---------------------------------------------------------------------------

/**
 * Load every pid from the most recent original audit TSV (not a re-audit).
 * Used by the R10 OR-path to compute denominator = original polluted count.
 */
export async function defaultLoadOriginalAuditPids(
  date: string,
): Promise<Set<string>> {
  const path = `tmp/image-pollution-audit-${date}.tsv`;
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('pid\t')) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const cls = cols[1];
    if (cls === 'info') continue;
    out.add(cols[0]);
  }
  return out;
}

/**
 * Load pids with at least one BR_WRITE trail row in today's trail TSV.
 * Numerator of the R10 OR-path coverage ratio.
 */
export async function defaultLoadBrWritePidsFromTrail(
  date: string,
): Promise<Set<string>> {
  const path = `tmp/image-pollution-fix-trail-${date}.tsv`;
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split('\n').slice(1); // drop header
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const pid = cols[1];
    const operation = cols[2];
    if (operation === 'BR_WRITE') out.add(pid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main runner — read queue, walk rows, optional re-audit + R10 coverage
// ---------------------------------------------------------------------------

export async function runManualFix(
  deps: RunManualFixDeps,
): Promise<RunManualFixResult> {
  const runId = getOrCreateTrailRunId();
  const date = new Date().toISOString().slice(0, 10);

  // 1. Source queue rows: injected (tests) or parsed from disk.
  let queueRows: ManualQueueRow[];
  if (deps.manualQueueOverride !== undefined) {
    queueRows = deps.manualQueueOverride;
  } else {
    const queuePath = deps.args.queueFile ?? findLatestManualQueueTsv();
    if (!queuePath) {
      logger.warn(
        '[fix-image-pollution-manual] no manual queue TSV found in tmp/ — nothing to do',
      );
      queueRows = [];
    } else {
      queueRows = await parseManualQueueTsv(queuePath);
    }
  }

  // 2. Resume-from-trail (D-15): skip pids already terminal in today's trail.
  const processedPids = await deps.loadProcessedPidsFn();
  const todoRows = queueRows.filter((r) => !processedPids.has(r.pid));

  // 3. Read BR raw rows once.
  const rawRows = await deps.readRawRowsFn(
    deps.sheetsClient,
    deps.spreadsheetId,
    deps.sheetName,
  );
  const brIndex = buildBrIndex(rawRows);

  // 4. Walk each row interactively (strictly single-threaded).
  let resolved = 0;
  let skipped = 0;
  let accepted = 0;
  let quit = false;
  for (const row of todoRows) {
    let outcome: HandleRowOutcome;
    try {
      outcome = await handleManualRow(row, brIndex, deps, runId);
    } catch (err) {
      logger.warn(
        `[fix-image-pollution-manual] handleManualRow crashed for ${row.pid}: ${err}`,
      );
      outcome = 'skipped';
    }
    if (outcome === 'resolved') resolved++;
    else if (outcome === 'skipped') skipped++;
    else if (outcome === 'accepted') accepted++;
    else if (outcome === 'quit') {
      quit = true;
      break;
    }
  }

  console.log('\n=== Manual Fix Summary ===');
  console.log(
    `  Resolved (BR_WRITE):    ${resolved}\n` +
      `  Skipped (MANUAL_SKIP):  ${skipped}\n` +
      `  Accepted (MANUAL_ACC):  ${accepted}\n` +
      `  Quit early:             ${quit}`,
  );

  // 5. Optional --re-audit + R10 OR-path BR_WRITE coverage.
  let reAuditSummary: RunManualFixResult['reAudit'];
  if (deps.args.reAudit && deps.runAuditFn) {
    const auditResult = await deps.runAuditFn({ reAudit: true });
    const loadOriginal =
      deps.loadOriginalAuditPidsFn ?? defaultLoadOriginalAuditPids;
    const loadBrWrite =
      deps.loadBrWritePidsFromTrailFn ?? defaultLoadBrWritePidsFromTrail;
    const originalPids = await loadOriginal(date);
    const brWritePids = await loadBrWrite(date);
    const originalPolluted = originalPids.size;
    let brWriteCovered = 0;
    for (const p of originalPids) {
      if (brWritePids.has(p)) brWriteCovered++;
    }
    const coveragePct =
      originalPolluted > 0 ? (brWriteCovered / originalPolluted) * 100 : 100;
    const status: 'SATISFIED' | 'PARTIAL' =
      auditResult.pollutedCount === 0 || coveragePct === 100
        ? 'SATISFIED'
        : 'PARTIAL';
    reAuditSummary = {
      pollutedCount: auditResult.pollutedCount,
      brWriteCovered,
      originalPolluted,
      coveragePct,
      status,
    };
    console.log(
      `RE-AUDIT: ${auditResult.pollutedCount} pids still polluted ` +
        `(or ${brWriteCovered}/${originalPolluted} = ${coveragePct.toFixed(1)}% BR_WRITE coverage). ` +
        `R10 status: ${status} ` +
        `(pollutedCount=${auditResult.pollutedCount}, coverage=${coveragePct.toFixed(1)}%)`,
    );
  }

  return { resolved, skipped, accepted, quit, reAudit: reAuditSummary };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'queue-file': { type: 'string' },
      're-audit': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    showHelp();
    return;
  }

  const required = [
    'OPENAI_API_KEY',
    'GOOGLE_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const args: RunManualFixArgs = {
    queueFile: values['queue-file'] as string | undefined,
    reAudit: values['re-audit'] === true,
    dryRun: values['dry-run'] === true,
    help: false,
  };

  const sheetsClient = createSheetsClient();
  const driveClient = createDriveClient();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
  });

  const rl = createInterface({ input, output });
  const promptFn = (q: string): Promise<string> => rl.question(q);

  try {
    await runManualFix({
      args,
      sheetsClient,
      driveClient,
      openai,
      promptFn,
      readRawRowsFn: defaultReadRawRows,
      downloadFromDriveFn: downloadFromDrive,
      uploadToDriveFn: uploadToDrive,
      trashDriveFileFn: trashDriveFile,
      writeUpdatesFn: writeUpdates,
      verifySameProductFn: verifySameProduct,
      supplierCanonicalFn: resolveSupplierCanonical,
      appendTrailRowFn: appendTrailRow,
      loadProcessedPidsFn: loadProcessedPids,
      loadOriginalAuditPidsFn: defaultLoadOriginalAuditPids,
      loadBrWritePidsFromTrailFn: defaultLoadBrWritePidsFromTrail,
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
      sheetName: 'Bestsellers-Ready',
    });
  } finally {
    rl.close();
  }
}

const isDirectRun = process.argv[1]
  ?.replace(/\\/g, '/')
  .includes('fix-image-pollution-manual');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
