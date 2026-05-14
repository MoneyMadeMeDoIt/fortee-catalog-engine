// Tier 1 + Tier 2 image pollution fix orchestrator for Phase 16 (SPEC R3, R4, R6, R8, R9).
// Reads tmp/image-pollution-audit-{date}.tsv; writes BR + Drive on verifier-passing fixes.
// R6 GATE: if manual queue > 20 after Tier 2, exits with code 2 (BLOCKED-QUEUE-OVERFLOW).
// T-16-01 mitigation: every Drive write compares origFileId vs newFileId BEFORE trashing.
// D-17 Exception: FrontImage tier-1 replacement SKIPS verifier-after-fix (tautological —
//   supplier canonical IS the source-of-truth). Trail logs `verifier_skipped_tautology`.
// D-21: Tier 1 must fully complete before Tier 2 starts (no cross-tier concurrency).
// Mirrors scripts/audit-garment-types.ts (CLI skeleton) + scripts/fetch-ss-images-fixed.ts
//   (read-update-write flow) per 16-PATTERNS.md.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
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
import { downloadImage } from '../src/shopify/image-standardizer.js';
import { generateGarmentView } from '../src/lib/ai-image-generator.js';
import { verifySameProduct } from '../src/lib/verify-same-product.js';
import { resolveSupplierCanonical } from '../src/lib/supplier-canonical.js';
import {
  appendTrailRow,
  getOrCreateTrailRunId,
  loadProcessedPids,
} from '../src/lib/image-pollution-trail.js';
import { logger } from '../src/lib/logger.js';
import type { sheets_v4, drive_v3 } from 'googleapis';
import type { CategoryGroup } from '../src/shopify/types.js';

// ---------------------------------------------------------------------------
// Phase 17 17-08 (B-4): OpenAI billing-hard-limit short-circuit for Tier 2.
//
// Module-scope flag set ONCE when the first billing_hard_limit_reached error
// is detected; subsequent pids in the same Tier 2 loop short-circuit without
// calling generateGarmentView. Resume safety is preserved by Task 1's
// loadProcessedPids (TIER2_BUDGET_EXHAUSTED is non-terminal).
// ---------------------------------------------------------------------------

let __billingExhausted = false;

/**
 * Test-only helper to reset the module-scope billing-exhausted flag between
 * test runs (the flag is process-global, so leak across `beforeEach` blocks
 * without an explicit reset).
 */
export function __resetBillingExhaustedForTest(): void {
  __billingExhausted = false;
}

/**
 * Returns true if `err` is the OpenAI typed billing-hard-limit error.
 * Primary check: `err.code === 'billing_hard_limit_reached'`. Fallback for
 * older SDK versions: substring match on err.message.
 */
function isBillingHardLimit(err: unknown): boolean {
  if (!(err instanceof OpenAI.BadRequestError)) return false;
  const code = (err as unknown as { code?: string }).code;
  if (code === 'billing_hard_limit_reached') return true;
  if (
    typeof err.message === 'string' &&
    err.message.includes('Billing hard limit has been reached')
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const POLLUTION_CLASSES = [
  'shared_url',
  'invalid_image_format',
  'content_mismatch',
  'model_pollution',
  'shape_drift',
] as const;
type PollutionClass = (typeof POLLUTION_CLASSES)[number];

export interface PollutionRow {
  pid: string;
  pollution_class: PollutionClass;
  affected_columns: string[];
  affected_drive_urls: string[];
  expected_supplier_url: string;
  recommended_fix_tier: 1 | 2 | 3;
  pass_detected_in: 1 | 2 | 3;
  notes: string;
}

export interface TierResult {
  pid: string;
  tier: 1 | 2 | 3;
  status: 'fixed' | 'verifier_rejected' | 'no_canonical' | 'cascade' | 'skipped';
  cascade: boolean;
}

export interface RunImagePollutionFixArgs {
  auditFile?: string;
  limit?: number;
  dryRun: boolean;
  pid?: string;
  tier1Only?: boolean;
  help: boolean;
}

export interface RunImagePollutionFixDeps {
  args: RunImagePollutionFixArgs;
  sheetsClient: sheets_v4.Sheets;
  driveClient: drive_v3.Drive;
  openai: OpenAI;
  readRawRowsFn: (
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tab: string,
  ) => Promise<string[][]>;
  downloadImageFn: typeof downloadImage;
  downloadFromDriveFn: typeof downloadFromDrive;
  supplierCanonicalFn: typeof resolveSupplierCanonical;
  verifySameProductFn: typeof verifySameProduct;
  generateGarmentViewFn: typeof generateGarmentView;
  uploadToDriveFn: typeof uploadToDrive;
  trashDriveFileFn: typeof trashDriveFile;
  writeUpdatesFn: typeof writeUpdates;
  appendTrailRowFn: typeof appendTrailRow;
  loadProcessedPidsFn: typeof loadProcessedPids;
  spreadsheetId: string;
  sheetName: string;
  // Test-only override: bypass parseAuditTsv when set.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auditRowsOverride?: PollutionRow[];
}

export interface RunImagePollutionFixResult {
  tier1Fixed: number;
  tier2Fixed: number;
  cascadedToTier3: number;
  manualQueueSize: number;
  manualQueuePath: string;
  summaryPath: string;
  status: 'OK' | 'OK-TIER1-ONLY' | 'BLOCKED-QUEUE-OVERFLOW' | 'BILLING_LIMIT_HIT';
  /** Count of pids that were short-circuited because OpenAI billing hard limit was hit. */
  tier2BudgetExhausted: number;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Image Pollution Fix Orchestrator — Phase 16 Plan 03

Reads tmp/image-pollution-audit-{date}.tsv. Runs Tier 1 (supplier fetch) then
Tier 2 (AI regen) sequentially. Writes the unresolved-pid manual queue TSV +
JSON summary. If manual queue > 20 (R6 hard cap), exits with code 2.

Usage:
  npx tsx scripts/fix-image-pollution.ts                     # newest audit TSV
  npx tsx scripts/fix-image-pollution.ts --audit-file path/to.tsv
  npx tsx scripts/fix-image-pollution.ts --pid S05610
  npx tsx scripts/fix-image-pollution.ts --dry-run
  npx tsx scripts/fix-image-pollution.ts --limit 10

Flags:
  --audit-file <path>  Explicit path to audit TSV (default: newest in tmp/)
  --pid <id>           Run only for one pid
  --limit N            Process at most N polluted pids
  --dry-run            Print pass plan; no mutations
  --help, -h           Show this help text

Env vars required (real-network run):
  OPENAI_API_KEY, GOOGLE_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY, SS_ACCOUNT_NUMBER, SS_API_KEY
`);
}

// ---------------------------------------------------------------------------
// Default raw-row reader — see scripts/audit-image-pollution.ts:154-164.
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
// parseAuditTsv — parse the Plan 02 audit TSV (D-09 header + 8-col body)
// ---------------------------------------------------------------------------

export async function parseAuditTsv(path: string): Promise<PollutionRow[]> {
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    logger.warn(`[fix-image-pollution] could not read audit TSV ${path}: ${err}`);
    return [];
  }
  const out: PollutionRow[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('pid\t')) continue;  // header row
    const cols = line.split('\t');
    if (cols.length < 8) continue;
    const cls = cols[1] as PollutionClass | 'info';
    // Skip Plan 02 informational rows (no_canonical_available — not polluted).
    if (cls === 'info') continue;
    if (!POLLUTION_CLASSES.includes(cls as PollutionClass)) continue;
    const tier = Number(cols[5]);
    const pass = Number(cols[6]);
    out.push({
      pid: cols[0],
      pollution_class: cls as PollutionClass,
      affected_columns: cols[2].split(',').map((x) => x.trim()).filter((x) => x.length > 0),
      affected_drive_urls: cols[3].split(',').map((x) => x.trim()).filter((x) => x.length > 0),
      expected_supplier_url: cols[4],
      recommended_fix_tier: (tier === 1 || tier === 2 || tier === 3 ? tier : 3) as 1 | 2 | 3,
      pass_detected_in: (pass === 1 || pass === 2 || pass === 3 ? pass : 1) as 1 | 2 | 3,
      notes: cols[7] ?? '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BR row index map — builds (productId → row-index, columnName → col-index)
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
      // Match audit script: dedup by productId — first occurrence wins.
      rowByPid.set(pid, { rowIndex0: i, row });
    }
  }
  return { headerMap, rowByPid };
}

// ---------------------------------------------------------------------------
// Helpers for filenames + category inference (lightweight — no DB lookup)
// ---------------------------------------------------------------------------

function makeFilename(pid: string, col: string, supplierPrefix: string): string {
  return `${supplierPrefix}_${pid}_${col}.png`;
}

function inferCategoryGroup(brRow: string[], headerMap: Record<string, number>): CategoryGroup {
  // Best-effort inference from baseCategory + productName for the Tier 2 generator.
  const baseCat = (brRow[headerMap['baseCategory'] ?? -1] ?? '').toLowerCase();
  const productName = (brRow[headerMap['productName'] ?? -1] ?? '').toLowerCase();
  const blob = `${baseCat} ${productName}`;
  if (/hoodie|pullover|hood/.test(blob)) return 'hoodies';
  if (/polo/.test(blob)) return 'polos';
  if (/crewneck|sweatshirt|sweater/.test(blob)) return 'crewnecks';
  if (/jacket|coat/.test(blob)) return 'jackets';
  return 'tops';
}

// Trivial CostTracker shim — Tier 2's generateGarmentView requires one but
// Plan 03 doesn't enforce a budget cap (D-24). Use a permissive in-memory
// tracker that always reports "can afford" and accumulates per-call cost.
class PermissiveCostTracker {
  spent = 0;
  get remaining(): number {
    return 1_000_000;
  }
  canAfford(_amount: number): boolean {
    void _amount;
    return true;
  }
  record(amount: number): void {
    this.spent += amount;
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — supplier fetch + verifier-after-fix (R3, R8, R9; D-17, D-18)
// ---------------------------------------------------------------------------

export async function tier1Fix(
  pid: string,
  polluted: PollutionRow,
  brIndex: BrIndex,
  deps: RunImagePollutionFixDeps,
  runId: string,
): Promise<TierResult> {
  const brEntry = brIndex.rowByPid.get(pid);
  if (!brEntry) {
    logger.warn(`[fix-image-pollution] no BR row for ${pid} — skip`);
    return { pid, tier: 1, status: 'skipped', cascade: true };
  }

  // Phase 17 17-02: extract BR row's colorName so the per-color resolver
  // returns the canonical URL for the matching variant (eliminates the
  // "same style, different color" verifier-fail class from 2026-05-14).
  const colorName = String(
    brEntry.row[brIndex.headerMap['colorName'] ?? -1] ?? '',
  );

  // 1. Resolve canonical
  let canonical: Awaited<ReturnType<typeof resolveSupplierCanonical>> = null;
  try {
    canonical = await deps.supplierCanonicalFn(pid, colorName);
  } catch (err) {
    logger.warn(`[fix-image-pollution] supplier-canonical crashed for ${pid}: ${err}`);
    canonical = null;
  }
  if (!canonical) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'SUPPLIER_FETCH',
      column_or_path: '',
      old_value: '',
      new_value: '',
      tier: 1,
      run_id: runId,
      notes: 'no canonical for tier 1',
    });
    return { pid, tier: 1, status: 'no_canonical', cascade: true };
  }

  // 2. Front-first ordering — process FrontImage BEFORE Back/Side so the new
  //    front becomes source-of-truth for any back/side verifier-after-fix in
  //    the same pid iteration (D-17).
  const sortedCols = [...polluted.affected_columns].sort((a, b) => {
    if (a === 'FrontImage') return -1;
    if (b === 'FrontImage') return 1;
    return 0;
  });

  const supplierPrefix = canonical.source === 'ss' ? 'SS' : 'CSW';
  const styleId = String(canonical.styleId ?? polluted.pid);

  // Track the per-pid evolving FrontImage URL (used as verifier source-of-truth
  // for non-Front columns). Start with the current BR value.
  const currentBrUrls: Record<string, string> = {};
  for (const col of Object.keys(brIndex.headerMap)) {
    const idx = brIndex.headerMap[col];
    currentBrUrls[col] = String(brEntry.row[idx] ?? '');
  }

  for (const col of sortedCols) {
    // Download supplier canonical buffer fresh each iteration (cheap; same URL).
    let newBuf: Buffer;
    try {
      newBuf = await deps.downloadImageFn(canonical.url);
    } catch (err) {
      logger.warn(`[fix-image-pollution] download supplier failed for ${pid}: ${err}`);
      return { pid, tier: 1, status: 'cascade', cascade: true };
    }

    if (col === 'FrontImage') {
      // D-17 Exception — verifier SKIPPED (supplier IS the truth, tautological).
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'SUPPLIER_FETCH',
        column_or_path: col,
        old_value: currentBrUrls[col] ?? '',
        new_value: canonical.url,
        tier: 1,
        run_id: runId,
        notes: 'verifier_skipped_tautology',
      });
    } else {
      // For Back/Side/Model — run verifier-after-fix against current FrontImage.
      const frontUrl = currentBrUrls['FrontImage'] ?? '';
      const frontFid = extractFileId(frontUrl);
      if (!frontFid) {
        logger.warn(`[fix-image-pollution] no front fileId for ${pid} — cascade`);
        await deps.appendTrailRowFn({
          timestamp_iso: new Date().toISOString(),
          pid,
          operation: 'VERIFIER_FAIL',
          column_or_path: col,
          old_value: currentBrUrls[col] ?? '',
          new_value: canonical.url,
          tier: 1,
          run_id: runId,
          notes: 'no front to verify against',
        });
        return { pid, tier: 1, status: 'cascade', cascade: true };
      }
      let frontBuf: Buffer;
      try {
        frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
      } catch (err) {
        logger.warn(`[fix-image-pollution] front download failed for ${pid}: ${err}`);
        return { pid, tier: 1, status: 'cascade', cascade: true };
      }
      let verifyResult: { match: boolean; reason: string };
      try {
        verifyResult = await deps.verifySameProductFn(deps.openai, newBuf, frontBuf);
      } catch (err) {
        logger.warn(`[fix-image-pollution] verifier crashed for ${pid}/${col}: ${err}`);
        verifyResult = { match: false, reason: 'verifier crashed — false-reject' };
      }
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: verifyResult.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
        column_or_path: col,
        old_value: currentBrUrls[col] ?? '',
        new_value: canonical.url,
        tier: 1,
        run_id: runId,
        notes: verifyResult.reason,
      });
      if (!verifyResult.match) {
        return { pid, tier: 1, status: 'verifier_rejected', cascade: true };
      }
    }

    // 3. Drive write with T-16-01 compare-before-trash.
    const origFileId = extractFileId(currentBrUrls[col] ?? '');
    const filename = makeFilename(pid, col, supplierPrefix);
    let newUrl: string;
    try {
      newUrl = await deps.uploadToDriveFn(
        deps.driveClient,
        newBuf,
        filename,
        supplierPrefix,
        styleId,
      );
    } catch (err) {
      logger.warn(`[fix-image-pollution] uploadToDrive failed for ${pid}/${col}: ${err}`);
      return { pid, tier: 1, status: 'cascade', cascade: true };
    }
    const newFileId = extractFileId(newUrl);

    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'DRIVE_UPLOAD',
      column_or_path: newFileId ?? newUrl,
      old_value: origFileId ?? '',
      new_value: newFileId ?? '',
      tier: 1,
      run_id: runId,
      notes: `uploaded ${filename}`,
    });

    if (origFileId && newFileId && origFileId !== newFileId) {
      try {
        await deps.trashDriveFileFn(deps.driveClient, origFileId);
      } catch (err) {
        logger.warn(`[fix-image-pollution] trashDriveFile failed for ${pid}: ${err}`);
      }
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'DRIVE_DELETE',
        column_or_path: origFileId,
        old_value: origFileId,
        new_value: '',
        tier: 1,
        run_id: runId,
        notes: `replaced by ${newFileId}`,
      });
    }
    // T-16-01: else branch — uploadToDrive updated in-place. NEVER trash.

    // 4. BR write (single-cell range)
    const colIdx = brIndex.headerMap[col];
    if (colIdx === undefined) {
      logger.warn(`[fix-image-pollution] column ${col} not in header for ${pid}`);
      return { pid, tier: 1, status: 'cascade', cascade: true };
    }
    const range = `'${deps.sheetName}'!${columnToLetter(colIdx)}${brEntry.rowIndex0 + 1}`;
    if (!deps.args.dryRun) {
      try {
        await deps.writeUpdatesFn(deps.sheetsClient, deps.spreadsheetId, [
          { range, values: [[newUrl]] },
        ]);
      } catch (err) {
        logger.warn(`[fix-image-pollution] writeUpdates failed for ${pid}/${col}: ${err}`);
        return { pid, tier: 1, status: 'cascade', cascade: true };
      }
    }
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'BR_WRITE',
      column_or_path: col,
      old_value: currentBrUrls[col] ?? '',
      new_value: newUrl,
      tier: 1,
      run_id: runId,
      notes: '',
    });

    // Update local in-memory state so subsequent columns (Back/Side) see the
    // newly-fixed Front as source-of-truth.
    currentBrUrls[col] = newUrl;
  }

  return { pid, tier: 1, status: 'fixed', cascade: false };
}

// ---------------------------------------------------------------------------
// Tier 2 — AI regen (R4; D-11, D-21). NO double verifier — generateGarmentView
// already runs Phase 15's verifier internally (src/lib/ai-image-generator.ts:392).
// ---------------------------------------------------------------------------

export async function tier2Fix(
  pid: string,
  polluted: PollutionRow,
  brIndex: BrIndex,
  deps: RunImagePollutionFixDeps,
  runId: string,
  costTracker: PermissiveCostTracker,
): Promise<TierResult> {
  const brEntry = brIndex.rowByPid.get(pid);
  if (!brEntry) {
    return { pid, tier: 2, status: 'skipped', cascade: true };
  }

  const frontUrl = String(brEntry.row[brIndex.headerMap['FrontImage'] ?? -1] ?? '');
  const frontFid = extractFileId(frontUrl);
  if (!frontFid) {
    return { pid, tier: 2, status: 'cascade', cascade: true };
  }
  let frontBuf: Buffer;
  try {
    frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
  } catch (err) {
    logger.warn(`[fix-image-pollution] tier2 front download failed for ${pid}: ${err}`);
    return { pid, tier: 2, status: 'cascade', cascade: true };
  }

  const supplierPrefix = 'AI';
  const styleId = pid;
  const garmentType = inferCategoryGroup(brEntry.row, brIndex.headerMap);
  const colorName = String(brEntry.row[brIndex.headerMap['colorName'] ?? -1] ?? '');
  const productName = String(brEntry.row[brIndex.headerMap['productName'] ?? -1] ?? '');

  for (const col of polluted.affected_columns) {
    if (col !== 'BackImage' && col !== 'DirectSideImage') {
      // Tier 2 only handles back/side regen. Front + Model cascade to Tier 3.
      return { pid, tier: 2, status: 'cascade', cascade: true };
    }
    const view: 'back' | 'side' = col === 'BackImage' ? 'back' : 'side';
    const currentUrl = String(brEntry.row[brIndex.headerMap[col] ?? -1] ?? '');

    let regen: Awaited<ReturnType<typeof generateGarmentView>> = null;
    try {
      regen = await deps.generateGarmentViewFn(
        frontBuf,
        view,
        garmentType,
        colorName,
        pid,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        costTracker as any,
        undefined,
        productName,
      );
    } catch (err) {
      // 17-08 (B-4): billing-hard-limit must propagate to the outer Tier 2
      // loop so the orchestrator can flip the __billingExhausted flag and
      // short-circuit the remaining pids. Other errors are swallowed here
      // (existing Phase 16 behavior) and the pid is marked verifier_rejected.
      if (isBillingHardLimit(err)) {
        throw err;
      }
      logger.warn(`[fix-image-pollution] generateGarmentView crashed for ${pid}/${view}: ${err}`);
      regen = null;
    }

    if (!regen) {
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'AI_REGEN',
        column_or_path: col,
        old_value: currentUrl,
        new_value: '',
        tier: 2,
        run_id: runId,
        notes: 'Tier 2 returned null — all candidates verifier-rejected',
      });
      return { pid, tier: 2, status: 'verifier_rejected', cascade: true };
    }

    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'AI_REGEN',
      column_or_path: col,
      old_value: currentUrl,
      new_value: '<buffer>',
      tier: 2,
      run_id: runId,
      notes: `Tier 2 success score=${regen.score}`,
    });

    // T-16-01 compare-before-trash, mirrored from Tier 1.
    const origFileId = extractFileId(currentUrl);
    const filename = makeFilename(pid, col, supplierPrefix);
    let newUrl: string;
    try {
      newUrl = await deps.uploadToDriveFn(
        deps.driveClient,
        regen.buffer,
        filename,
        supplierPrefix,
        styleId,
      );
    } catch (err) {
      logger.warn(`[fix-image-pollution] tier2 uploadToDrive failed for ${pid}/${col}: ${err}`);
      return { pid, tier: 2, status: 'cascade', cascade: true };
    }
    const newFileId = extractFileId(newUrl);

    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'DRIVE_UPLOAD',
      column_or_path: newFileId ?? newUrl,
      old_value: origFileId ?? '',
      new_value: newFileId ?? '',
      tier: 2,
      run_id: runId,
      notes: `uploaded ${filename}`,
    });

    if (origFileId && newFileId && origFileId !== newFileId) {
      try {
        await deps.trashDriveFileFn(deps.driveClient, origFileId);
      } catch (err) {
        logger.warn(`[fix-image-pollution] tier2 trashDriveFile failed for ${pid}: ${err}`);
      }
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'DRIVE_DELETE',
        column_or_path: origFileId,
        old_value: origFileId,
        new_value: '',
        tier: 2,
        run_id: runId,
        notes: `replaced by ${newFileId}`,
      });
    }

    const colIdx = brIndex.headerMap[col];
    if (colIdx === undefined) {
      return { pid, tier: 2, status: 'cascade', cascade: true };
    }
    const range = `'${deps.sheetName}'!${columnToLetter(colIdx)}${brEntry.rowIndex0 + 1}`;
    if (!deps.args.dryRun) {
      try {
        await deps.writeUpdatesFn(deps.sheetsClient, deps.spreadsheetId, [
          { range, values: [[newUrl]] },
        ]);
      } catch (err) {
        logger.warn(`[fix-image-pollution] tier2 writeUpdates failed for ${pid}/${col}: ${err}`);
        return { pid, tier: 2, status: 'cascade', cascade: true };
      }
    }
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'BR_WRITE',
      column_or_path: col,
      old_value: currentUrl,
      new_value: newUrl,
      tier: 2,
      run_id: runId,
      notes: '',
    });
  }

  return { pid, tier: 2, status: 'fixed', cascade: false };
}

// ---------------------------------------------------------------------------
// Manual queue TSV emission (R6 Tier 3 input)
// ---------------------------------------------------------------------------

function deriveSuggestedAction(cls: PollutionClass): string {
  if (cls === 'shape_drift') return 'delete + leave blank for next push regen';
  // content_mismatch | model_pollution | invalid_image_format | shared_url
  return 'replace with operator-picked URL';
}

function writeManualQueueTsv(
  path: string,
  pids: string[],
  pollutedByPid: Map<string, PollutionRow>,
  brIndex: BrIndex,
): void {
  const header =
    'pid\tpollution_class\taffected_columns\tcurrent_drive_urls\tfront_image_screenshot_link\tsuggested_action\n';
  const lines: string[] = [];
  for (const pid of pids) {
    const polluted = pollutedByPid.get(pid);
    if (!polluted) continue;
    const brEntry = brIndex.rowByPid.get(pid);
    const frontUrl = brEntry
      ? String(brEntry.row[brIndex.headerMap['FrontImage'] ?? -1] ?? '')
      : '';
    const frontFid = extractFileId(frontUrl);
    const screenshotLink = frontFid ? `https://drive.google.com/uc?id=${frontFid}` : '';
    lines.push(
      [
        polluted.pid,
        polluted.pollution_class,
        polluted.affected_columns.join(','),
        polluted.affected_drive_urls.join(','),
        screenshotLink,
        deriveSuggestedAction(polluted.pollution_class),
      ]
        .map((s) => String(s).replace(/[\t\n\r]+/g, ' '))
        .join('\t'),
    );
  }
  try {
    if (!existsSync('tmp')) {
      mkdirSync('tmp', { recursive: true });
    }
  } catch {
    // ignore
  }
  try {
    writeFileSync(path, header + lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  } catch (err) {
    logger.warn(`[fix-image-pollution] manual queue write failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Locate newest audit TSV in tmp/ if --audit-file not provided
// ---------------------------------------------------------------------------

function findLatestAuditTsv(): string | null {
  if (!existsSync('tmp')) return null;
  let candidates: string[] = [];
  try {
    candidates = readdirSync('tmp').filter(
      (f) => /^image-pollution-audit-\d{4}-\d{2}-\d{2}(-reaudit)?\.tsv$/.test(f),
    );
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return `tmp/${candidates[candidates.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Main runner — D-21 Tier 1 fully completes before Tier 2 starts
// ---------------------------------------------------------------------------

export async function runImagePollutionFix(
  deps: RunImagePollutionFixDeps,
): Promise<RunImagePollutionFixResult> {
  const runId = getOrCreateTrailRunId();
  const date = new Date().toISOString().slice(0, 10);
  const manualQueuePath = `tmp/image-pollution-manual-queue-${date}.tsv`;
  const summaryPath = `tmp/image-pollution-fix-summary-${date}.json`;

  // 1. Source the polluted rows: either injected (tests) or parsed from disk.
  let pollutedRows: PollutionRow[];
  if (deps.auditRowsOverride !== undefined) {
    pollutedRows = deps.auditRowsOverride;
  } else {
    const auditPath = deps.args.auditFile ?? findLatestAuditTsv();
    if (!auditPath) {
      logger.warn('[fix-image-pollution] no audit TSV found in tmp/ — nothing to do');
      pollutedRows = [];
    } else {
      pollutedRows = await parseAuditTsv(auditPath);
    }
  }

  // 2. Apply --pid filter and --limit slice.
  if (deps.args.pid) {
    pollutedRows = pollutedRows.filter((r) => r.pid === deps.args.pid);
  }
  if (deps.args.limit !== undefined && deps.args.limit > 0) {
    pollutedRows = pollutedRows.slice(0, deps.args.limit);
  }

  // 3. Resume-from-trail (D-15): skip pids already terminal in today's trail.
  const processedPids = await deps.loadProcessedPidsFn();
  const todoRows = pollutedRows.filter((r) => !processedPids.has(r.pid));
  const pollutedByPid = new Map<string, PollutionRow>();
  for (const r of todoRows) pollutedByPid.set(r.pid, r);

  // 4. Read BR raw rows once (Pitfall 1 — raw read; SheetRow lacks Model*).
  const rawRows = await deps.readRawRowsFn(
    deps.sheetsClient,
    deps.spreadsheetId,
    deps.sheetName,
  );
  const brIndex = buildBrIndex(rawRows);

  // 5. Tier 1 (sequential per-pid per D-20).
  const tier1Results: TierResult[] = [];
  for (const polluted of todoRows) {
    try {
      const result = await tier1Fix(polluted.pid, polluted, brIndex, deps, runId);
      tier1Results.push(result);
    } catch (err) {
      logger.warn(`[fix-image-pollution] Tier 1 crashed for ${polluted.pid}: ${err}`);
      tier1Results.push({
        pid: polluted.pid,
        tier: 1,
        status: 'cascade',
        cascade: true,
      });
    }
  }

  // D-21: Tier 1 fully complete BEFORE Tier 2 starts.
  // --tier1-only short-circuits Tier 2 entirely — used when OpenAI budget is
  // depleted or when the operator wants to take only the free supplier-fetch
  // wins this round.
  const cascadedToTier2 = deps.args.tier1Only
    ? []
    : tier1Results.filter((r) => r.cascade).map((r) => r.pid);

  // 6. Tier 2 — back/side AI regen for cascaded pids (only those with back/side
  //    pollution; pids with only FrontImage or Model* pollution cascade to Tier 3).
  const costTracker = new PermissiveCostTracker();
  const tier2Results: TierResult[] = [];
  // 17-08 (B-4): count pids short-circuited by the billing-hard-limit fast path.
  let tier2BudgetExhausted = 0;
  for (const pid of cascadedToTier2) {
    const polluted = pollutedByPid.get(pid);
    if (!polluted) {
      tier2Results.push({ pid, tier: 2, status: 'skipped', cascade: true });
      continue;
    }
    const hasBackOrSide = polluted.affected_columns.some(
      (c) => c === 'BackImage' || c === 'DirectSideImage',
    );
    if (!hasBackOrSide) {
      tier2Results.push({ pid, tier: 2, status: 'skipped', cascade: true });
      continue;
    }

    // 17-08 fast-path: if the billing-hard-limit flag was tripped earlier in
    // this loop, skip the API call entirely and emit a sentinel trail row.
    if (__billingExhausted) {
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'TIER2_BUDGET_EXHAUSTED',
        column_or_path: '',
        old_value: '',
        new_value: '',
        tier: 2,
        run_id: runId,
        notes: 'OpenAI billing hard limit reached \u2014 Tier 2 aborted',
      });
      tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
      tier2BudgetExhausted++;
      continue;
    }

    try {
      const result = await tier2Fix(pid, polluted, brIndex, deps, runId, costTracker);
      tier2Results.push(result);
    } catch (err) {
      if (isBillingHardLimit(err)) {
        // 17-08 first-detection: flip the flag, log ONCE, emit sentinel trail row.
        logger.warn(
          '[fix-image-pollution] OpenAI billing hard limit \u2014 aborting Tier 2',
        );
        __billingExhausted = true;
        await deps.appendTrailRowFn({
          timestamp_iso: new Date().toISOString(),
          pid,
          operation: 'TIER2_BUDGET_EXHAUSTED',
          column_or_path: '',
          old_value: '',
          new_value: '',
          tier: 2,
          run_id: runId,
          notes:
            'OpenAI billing hard limit reached \u2014 Tier 2 aborted (first detection)',
        });
        tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
        tier2BudgetExhausted++;
        continue;
      }
      logger.warn(`[fix-image-pollution] Tier 2 crashed for ${pid}: ${err}`);
      tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
    }
  }

  // 7. Build manual queue.
  const tier1FixedPids = new Set(
    tier1Results.filter((r) => r.status === 'fixed').map((r) => r.pid),
  );
  const tier2FixedPids = new Set(
    tier2Results.filter((r) => r.status === 'fixed').map((r) => r.pid),
  );
  const tier3Pids = todoRows
    .map((r) => r.pid)
    .filter((pid) => !tier1FixedPids.has(pid) && !tier2FixedPids.has(pid));

  writeManualQueueTsv(manualQueuePath, tier3Pids, pollutedByPid, brIndex);

  // 8. R6 hard cap.
  // In --tier1-only mode the manual queue is expected to be huge (the whole
  // point is to defer Tier 2/3); R6 does not apply.
  const manualQueueSize = tier3Pids.length;
  // 17-08 (B-4): BILLING_LIMIT_HIT takes precedence over R6 overflow because
  // the overflow is an artifact of the truncated Tier 2 — the operator's
  // remediation is 'top up billing and re-run', not 'broaden Tier 1/2 coverage'.
  const status: 'OK' | 'OK-TIER1-ONLY' | 'BLOCKED-QUEUE-OVERFLOW' | 'BILLING_LIMIT_HIT' = __billingExhausted
    ? 'BILLING_LIMIT_HIT'
    : deps.args.tier1Only
      ? 'OK-TIER1-ONLY'
      : manualQueueSize > 20
        ? 'BLOCKED-QUEUE-OVERFLOW'
        : 'OK';

  // 9. Summary JSON.
  const summary = {
    audit_run_id: runId,
    tier1_fixed: tier1FixedPids.size,
    tier2_fixed: tier2FixedPids.size,
    cascaded_to_tier3: manualQueueSize,
    manual_queue_size: manualQueueSize,
    manual_queue_path: manualQueuePath,
    total_cost_usd_estimate: Number(costTracker.spent.toFixed(4)),
    status,
    processed_pid_count: todoRows.length,
    // 17-08 (B-4): always emitted, zero when no billing hit occurred.
    tier2_budget_exhausted_count: tier2BudgetExhausted,
  };
  try {
    if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });
  } catch {
    // ignore
  }
  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    logger.warn(`[fix-image-pollution] summary write failed: ${err}`);
  }

  console.log('\n=== Image Pollution Fix Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (status === 'BLOCKED-QUEUE-OVERFLOW') {
    // R6 hard cap: manual_queue_size exceeded threshold of 20 — block phase
    // close and force operator to broaden Tier 1/2 coverage (Plan D-12).
    console.error(
      `BLOCKED-QUEUE-OVERFLOW: manual_queue_size=${manualQueueSize} exceeds R6 cap (20). ` +
        `Run --post-mortem for analysis. Plan D-12 scraper expansion.`,
    );
    process.exit(2);
  }

  return {
    tier1Fixed: tier1FixedPids.size,
    tier2Fixed: tier2FixedPids.size,
    cascadedToTier3: manualQueueSize,
    manualQueueSize,
    manualQueuePath,
    summaryPath,
    status,
    tier2BudgetExhausted,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'audit-file': { type: 'string' },
      pid: { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'tier1-only': { type: 'boolean', default: false },
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
    'SS_ACCOUNT_NUMBER',
    'SS_API_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const args: RunImagePollutionFixArgs = {
    auditFile: values['audit-file'] as string | undefined,
    pid: values.pid as string | undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    dryRun: values['dry-run'] === true,
    tier1Only: values['tier1-only'] === true,
    help: false,
  };

  const sheetsClient = createSheetsClient();
  const driveClient = createDriveClient();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
  });

  await runImagePollutionFix({
    args,
    sheetsClient,
    driveClient,
    openai,
    readRawRowsFn: defaultReadRawRows,
    downloadImageFn: downloadImage,
    downloadFromDriveFn: downloadFromDrive,
    supplierCanonicalFn: resolveSupplierCanonical,
    verifySameProductFn: verifySameProduct,
    generateGarmentViewFn: generateGarmentView,
    uploadToDriveFn: uploadToDrive,
    trashDriveFileFn: trashDriveFile,
    writeUpdatesFn: writeUpdates,
    appendTrailRowFn: appendTrailRow,
    loadProcessedPidsFn: loadProcessedPids,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    sheetName: 'Bestsellers-Ready',
  });
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('fix-image-pollution');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
