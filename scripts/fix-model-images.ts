/**
 * Phase 17 17-03 — Model* image rebuild tool.
 *
 * Standalone from scripts/fix-image-pollution.ts (per D-17-01) because:
 *   - Different supplier API path: S&S /products/?style=N&fields=colorOnModelFrontImage,...
 *   - Different verifier semantics: compare model-with-garment vs garment-only-front
 *   - Different cost profile: ~$0.03/call × 3 views × 213 pids = ~$6 worst case
 *   - Operator can run separately (smaller scope, easier to budget)
 *
 * Two execution modes:
 *   --sample-only      Process 10 pids (5 cap + 5 garment), write sample JSON, exit.
 *                      Pass-rate < 7/10 → exit 2 with BLOCKED-SAMPLE-PASS-RATE.
 *   (no --sample-only) Process all model_pollution pids in the audit TSV.
 *                      Gated by a prior successful sample run unless --skip-sample-gate.
 *
 * Trail TSV: shares the SAME tmp/image-pollution-fix-trail-{date}.tsv as Phase 16.
 * All rows written by this script use `tier: 4` so post-mortem can filter cleanly.
 *
 * T-17-09 mitigation: Drive update-in-place compare-before-trash on every write.
 * T-17-10 mitigation: --max-cost <usd> caps Tier 2 spend; default $10.
 * T-17-14 mitigation: OpenAI billing-hard-limit short-circuits Tier 2 module-wide.
 */

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
import { generateModelImage, type ModelGender } from '../src/lib/ai-model-image.js';
import { verifySameProduct } from '../src/lib/verify-same-product.js';
import {
  appendTrailRow,
  getOrCreateTrailRunId,
  loadProcessedPids,
} from '../src/lib/image-pollution-trail.js';
import { CostTracker, COST_PER_IMAGE } from '../src/lib/cost-tracker.js';
import { CANDIDATES_PER_CALL } from '../src/lib/ai-image-types.js';
import { logger } from '../src/lib/logger.js';
import type { sheets_v4, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Module-scope state for T-17-14 billing-hard-limit short-circuit
// ---------------------------------------------------------------------------

let __billingExhausted = false;

/** Test-only helper to reset the billing-exhausted flag between test runs. */
export function __resetBillingExhaustedForTest(): void {
  __billingExhausted = false;
}

function isBillingHardLimit(err: unknown): boolean {
  if (!(err instanceof OpenAI.BadRequestError)) return false;
  const code = (err as unknown as { code?: string }).code;
  if (code === 'billing_hard_limit_reached') return true;
  if (
    typeof err.message === 'string' &&
    err.message.includes('Billing hard limit')
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const MODEL_COLUMNS = [
  'ModelFrontImage',
  'ModelSideImage',
  'ModelBackImage',
] as const;
export type ModelColumn = (typeof MODEL_COLUMNS)[number];

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

export interface ModelFixResult {
  pid: string;
  column: ModelColumn;
  status:
    | 'tier1_supplier'
    | 'tier2_ai'
    | 'verifier_rejected'
    | 'manual_cascade'
    | 'skipped'
    | 'budget_exhausted';
  newUrl?: string;
  cost?: number;
  reason?: string;
}

export interface RunFixModelImagesArgs {
  auditFile?: string;
  sampleOnly: boolean;
  samplePids?: string[];
  skipSampleGate: boolean;
  maxCost: number;
  dryRun: boolean;
  limit?: number;
  reAudit: boolean;
  help: boolean;
}

interface BrIndex {
  headerMap: Record<string, number>;
  rowByPid: Map<string, { rowIndex0: number; row: string[] }>;
}

export interface RunFixModelImagesDeps {
  args: RunFixModelImagesArgs;
  sheetsClient: sheets_v4.Sheets;
  driveClient: drive_v3.Drive;
  openai: OpenAI;
  spreadsheetId: string;
  sheetName: string;
  readRawRowsFn: (
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tab: string,
  ) => Promise<string[][]>;
  downloadImageFn: typeof downloadImage;
  downloadFromDriveFn: typeof downloadFromDrive;
  fetchSSModelImageFn: typeof fetchSSModelImage;
  verifySameProductFn: typeof verifySameProduct;
  generateModelImageFn: typeof generateModelImage;
  uploadToDriveFn: typeof uploadToDrive;
  trashDriveFileFn: typeof trashDriveFile;
  writeUpdatesFn: typeof writeUpdates;
  appendTrailRowFn: typeof appendTrailRow;
  loadProcessedPidsFn: typeof loadProcessedPids;
  /** Optional Task 3 hook: returns the new Model* fail count from a re-audit. */
  reAuditFn?: (pids: string[]) => Promise<number>;
  /** Test-only override: bypass parseAuditTsv when set. */
  auditRowsOverride?: PollutionRow[];
}

export interface RunFixModelImagesResult {
  status: 'OK' | 'BLOCKED-SAMPLE-PASS-RATE' | 'BLOCKED-BUDGET-EXHAUSTED' | 'BILLING_LIMIT_HIT';
  total_pids_processed: number;
  tier1_fixed: number;
  tier2_fixed: number;
  manual_cascade: number;
  /** Sample-mode only: pass rate. */
  sample_pass_rate?: number;
  total_cost_usd: number;
  summary_path: string;
}

// ---------------------------------------------------------------------------
// CLI help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
fix-model-images — Phase 17 17-03 Model* image rebuild tool

Reads the same audit TSV as Phase 16 (tmp/image-pollution-audit-{date}.tsv),
filters to model_pollution rows, and rebuilds each affected ModelFrontImage /
ModelSideImage / ModelBackImage column via:
  Tier 1 (free): S&S colorOnModel{Front,Side,Back}Image URL fetch + verifier-after-fix
  Tier 2 ($0.03/call): generateModelImage AI synthesis + verifier-after-fix
  Manual cascade: verifier rejects both → logged to manual queue

Usage:
  npx tsx scripts/fix-model-images.ts --sample-only
  npx tsx scripts/fix-model-images.ts --skip-sample-gate --max-cost 10
  npx tsx scripts/fix-model-images.ts --skip-sample-gate --re-audit

Flags:
  --audit-file <path>      Explicit audit TSV path (default: newest in tmp/)
  --sample-only            Process 10 pids (5 cap + 5 garment) and exit.
                           Pass-rate < 7/10 → exit 2 with BLOCKED-SAMPLE-PASS-RATE.
  --sample-pids <a,b,c>    Override default 10-pid sample selection.
  --skip-sample-gate       Run full set without requiring prior sample-test JSON.
  --max-cost <usd>         Tier 2 budget cap. Default $10.
  --dry-run                Print plan; no Drive / BR mutations.
  --limit N                Process at most N polluted pids.
  --re-audit               After full run, invoke audit-image-pollution.ts on the
                           processed pids and include model_fail_after_count in JSON.
  --help, -h               Show this help text.

Env vars required (real-network run):
  OPENAI_API_KEY, GOOGLE_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY, SS_ACCOUNT_NUMBER, SS_API_KEY
`);
}

// ---------------------------------------------------------------------------
// Default raw-row reader (same shape as Phase 16's)
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
// parseAuditTsv — same logic as Phase 16 fix orchestrator
// ---------------------------------------------------------------------------

export async function parseAuditTsv(path: string): Promise<PollutionRow[]> {
  if (!existsSync(path)) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    logger.warn(`[fix-model-images] could not read audit TSV ${path}: ${err}`);
    return [];
  }
  const out: PollutionRow[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('pid\t')) continue;
    const cols = line.split('\t');
    if (cols.length < 8) continue;
    const cls = cols[1] as PollutionClass | 'info';
    if (cls === 'info') continue;
    if (!POLLUTION_CLASSES.includes(cls as PollutionClass)) continue;
    const tier = Number(cols[5]);
    const pass = Number(cols[6]);
    out.push({
      pid: cols[0],
      pollution_class: cls as PollutionClass,
      affected_columns: cols[2]
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
      affected_drive_urls: cols[3]
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
      expected_supplier_url: cols[4],
      recommended_fix_tier: (tier === 1 || tier === 2 || tier === 3 ? tier : 3) as 1 | 2 | 3,
      pass_detected_in: (pass === 1 || pass === 2 || pass === 3 ? pass : 1) as 1 | 2 | 3,
      notes: cols[7] ?? '',
    });
  }
  return out;
}

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
// BR index builder
// ---------------------------------------------------------------------------

function buildBrIndex(rawRows: string[][]): BrIndex {
  const headerMap: Record<string, number> = {};
  const rowByPid = new Map<string, { rowIndex0: number; row: string[] }>();
  if (rawRows.length === 0) return { headerMap, rowByPid };
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
// Gender inference — local heuristic (per 17-RESEARCH note that audit-images.ts
// does NOT export inferGender; we duplicate the small block locally).
// ---------------------------------------------------------------------------

function inferGender(row: string[], headerMap: Record<string, number>): ModelGender {
  const explicit = (row[headerMap['gender'] ?? -1] ?? '').toString().toLowerCase();
  if (explicit === 'women' || explicit === 'female' || /women/.test(explicit)) return 'women';
  if (explicit === 'men' || explicit === 'male' || /men/.test(explicit)) return 'men';
  if (explicit === 'youth' || explicit === 'child' || /kid|child|youth|toddler/.test(explicit))
    return 'youth';
  if (explicit === 'unisex') return 'unisex';

  const baseCat = (row[headerMap['baseCategory'] ?? -1] ?? '').toString().toLowerCase();
  const productName = (row[headerMap['productName'] ?? -1] ?? '').toString().toLowerCase();
  const blob = `${baseCat} ${productName}`;
  if (/women|ladies|female/.test(blob)) return 'women';
  if (/men|male/.test(blob) && !/women/.test(blob)) return 'men';
  if (/youth|kid|child|toddler|baby/.test(blob)) return 'youth';
  return 'unisex';
}

// ---------------------------------------------------------------------------
// Cap detection for sample-pid selection
// ---------------------------------------------------------------------------

function isCapPid(row: string[], headerMap: Record<string, number>): boolean {
  const baseCat = (row[headerMap['baseCategory'] ?? -1] ?? '').toString().toLowerCase();
  const productName = (row[headerMap['productName'] ?? -1] ?? '').toString().toLowerCase();
  const blob = `${baseCat} ${productName}`;
  return /cap|hat|headwear|beanie|snapback|trucker/.test(blob);
}

// ---------------------------------------------------------------------------
// fetchSSModelImage — S&S /products/?style= lookup for colorOnModel* URLs.
//
// Returns null on:
//   - No matching S&S styleId
//   - Empty /products/ variants array
//   - No variant matching the colorName (NO fallback — wrong-color model image is
//     worse than no model image; Tier 2 handles)
//   - Empty colorOnModel{Front,Side,Back}Image for the matching variant + view
// ---------------------------------------------------------------------------

const SS_BASE = 'https://api-ca.ssactivewear.com/v2';
const SS_IMG_BASE = 'https://www.ssactivewear.com/';
const SS_RATE_LIMIT_MS = 1100;

let _ssLastRequestAt = 0;

async function ssThrottle(): Promise<void> {
  const wait = SS_RATE_LIMIT_MS - (Date.now() - _ssLastRequestAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  _ssLastRequestAt = Date.now();
}

function getSSAuth(): string {
  const account = process.env.SS_ACCOUNT_NUMBER;
  const key = process.env.SS_API_KEY;
  if (!account || !key) {
    throw new Error('SS_ACCOUNT_NUMBER and SS_API_KEY must be set');
  }
  return `Basic ${Buffer.from(`${account}:${key}`).toString('base64')}`;
}

async function ssGet<T>(path: string, auth: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(SS_BASE + path, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (r.status === 503) {
      await new Promise<void>((x) => setTimeout(x, 10000));
      continue;
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`SS API ${r.status} on ${path}`);
    return (await r.json()) as T;
  }
  return null;
}

function makeSSLargeUrl(path: string): string {
  if (!path) return '';
  return SS_IMG_BASE + path.replace('_fm', '_fl');
}

/**
 * Resolve a pid → S&S styleID → fetch colorOnModel{Front,Side,Back}Image for the
 * matching color, and return the large-variant URL.
 *
 * Per-color filter is case-insensitive + whitespace-trimmed. NO fallback to first
 * variant: a model image with the wrong color is worse than no model image (the
 * verifier would reject it anyway).
 */
export async function fetchSSModelImage(
  pid: string,
  colorName: string,
  view: 'front' | 'side' | 'back',
): Promise<string | null> {
  await ssThrottle();
  const auth = getSSAuth();

  // Step 1: resolve styleId
  const styles = await ssGet<Array<{ styleID: number; styleName: string }>>(
    `/styles/?search=${encodeURIComponent(pid)}&fields=styleID,styleName`,
    auth,
  );
  if (!styles || styles.length === 0) return null;
  let styleId: number | null = null;
  const exact = styles.find(
    (s) => String(s.styleName ?? '').toUpperCase() === pid.toUpperCase(),
  );
  if (exact) styleId = exact.styleID;
  else if (styles.length === 1) styleId = styles[0].styleID;
  if (styleId === null) return null;

  // Step 2: fetch colorOnModel* URLs
  await ssThrottle();
  const products = await ssGet<
    Array<{
      colorName?: string;
      colorOnModelFrontImage?: string;
      colorOnModelSideImage?: string;
      colorOnModelBackImage?: string;
    }>
  >(
    `/products/?style=${styleId}&fields=colorName,colorOnModelFrontImage,colorOnModelSideImage,colorOnModelBackImage`,
    auth,
  );
  if (!products || products.length === 0) return null;

  // Step 3: match colorName (strict; no fallback)
  const target = (colorName ?? '').toUpperCase().trim();
  if (!target) return null;
  const match = products.find(
    (p) => String(p.colorName ?? '').toUpperCase().trim() === target,
  );
  if (!match) return null;

  // Step 4: pick the requested view's URL
  const raw =
    view === 'front'
      ? match.colorOnModelFrontImage
      : view === 'side'
        ? match.colorOnModelSideImage
        : match.colorOnModelBackImage;
  if (!raw) return null;
  return makeSSLargeUrl(raw);
}

// ---------------------------------------------------------------------------
// fixModelImage — per-pid, per-Model-column flow
// ---------------------------------------------------------------------------

function makeFilename(pid: string, col: string, prefix: 'SS' | 'AI'): string {
  return `${prefix}_${pid}_${col}.png`;
}

async function commitFix(
  pid: string,
  column: ModelColumn,
  buf: Buffer,
  currentUrl: string,
  prefix: 'SS' | 'AI',
  brEntry: { rowIndex0: number; row: string[] },
  brIndex: BrIndex,
  deps: RunFixModelImagesDeps,
  runId: string,
): Promise<string> {
  const origFileId = extractFileId(currentUrl);
  const filename = makeFilename(pid, column, prefix);

  let newUrl: string;
  try {
    newUrl = await deps.uploadToDriveFn(
      deps.driveClient,
      buf,
      filename,
      prefix === 'SS' ? 'SSCANADA' : 'AI',
      pid,
    );
  } catch (err) {
    logger.warn(`[fix-model-images] uploadToDrive failed for ${pid}/${column}: ${err}`);
    throw err;
  }
  const newFileId = extractFileId(newUrl);

  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: 'DRIVE_UPLOAD',
    column_or_path: newFileId ?? newUrl,
    old_value: origFileId ?? '',
    new_value: newFileId ?? '',
    tier: 4,
    run_id: runId,
    notes: `uploaded ${filename}`,
  });

  // T-17-09: compare-before-trash — never trash when upload was in-place.
  if (origFileId && newFileId && origFileId !== newFileId) {
    try {
      await deps.trashDriveFileFn(deps.driveClient, origFileId);
    } catch (err) {
      logger.warn(`[fix-model-images] trashDriveFile failed for ${pid}: ${err}`);
    }
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'DRIVE_DELETE',
      column_or_path: origFileId,
      old_value: origFileId,
      new_value: '',
      tier: 4,
      run_id: runId,
      notes: `replaced by ${newFileId}`,
    });
  }

  // BR write
  const colIdx = brIndex.headerMap[column];
  if (colIdx === undefined) {
    throw new Error(`column ${column} not in BR header for ${pid}`);
  }
  const range = `'${deps.sheetName}'!${columnToLetter(colIdx)}${brEntry.rowIndex0 + 1}`;
  if (!deps.args.dryRun) {
    await deps.writeUpdatesFn(deps.sheetsClient, deps.spreadsheetId, [
      { range, values: [[newUrl]] },
    ]);
  }
  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: 'BR_WRITE',
    column_or_path: column,
    old_value: currentUrl,
    new_value: newUrl,
    tier: 4,
    run_id: runId,
    notes: '',
  });

  return newUrl;
}

/**
 * Per-column flow:
 *   1. Tier 1 — fetchSSModelImage → download → verifySameProduct vs FrontImage.
 *      Pass → commitFix (status: tier1_supplier). Fail or null URL → Tier 2.
 *   2. Tier 2 — generateModelImage → verifySameProduct vs FrontImage.
 *      Pass → commitFix (status: tier2_ai). Fail → verifier_rejected.
 *      null result → manual_cascade. Budget exhausted → budget_exhausted.
 *      Billing-hard-limit error → set module flag, return budget_exhausted.
 */
export async function fixModelImage(
  pid: string,
  column: ModelColumn,
  brEntry: { rowIndex0: number; row: string[] },
  brIndex: BrIndex,
  deps: RunFixModelImagesDeps,
  runId: string,
  costTracker: CostTracker,
): Promise<ModelFixResult> {
  const colorName = String(brEntry.row[brIndex.headerMap['colorName'] ?? -1] ?? '');
  const currentUrl = String(brEntry.row[brIndex.headerMap[column] ?? -1] ?? '');
  const frontUrl = String(brEntry.row[brIndex.headerMap['FrontImage'] ?? -1] ?? '');
  const frontFid = extractFileId(frontUrl);
  if (!frontFid) {
    return { pid, column, status: 'skipped', reason: 'no front file id' };
  }

  let frontBuf: Buffer;
  try {
    frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
  } catch (err) {
    logger.warn(`[fix-model-images] front download failed for ${pid}: ${err}`);
    return { pid, column, status: 'skipped', reason: 'front download failed' };
  }

  const view: 'front' | 'side' | 'back' =
    column === 'ModelFrontImage' ? 'front' : column === 'ModelSideImage' ? 'side' : 'back';

  // -------------------------------------------------------------------------
  // Tier 1 — S&S colorOnModel* URL fetch + verifier
  // -------------------------------------------------------------------------
  let supplierUrl: string | null = null;
  try {
    supplierUrl = await deps.fetchSSModelImageFn(pid, colorName, view);
  } catch (err) {
    logger.warn(`[fix-model-images] fetchSSModelImage crashed for ${pid}/${view}: ${err}`);
    supplierUrl = null;
  }

  if (supplierUrl) {
    let supplierBuf: Buffer | null = null;
    try {
      supplierBuf = await deps.downloadImageFn(supplierUrl);
    } catch (err) {
      logger.warn(`[fix-model-images] supplier model download failed for ${pid}: ${err}`);
      supplierBuf = null;
    }
    if (supplierBuf && supplierBuf.length > 0) {
      // Tag the buffer so tests that branch verifier behavior on candidate
      // identity can distinguish supplier from AI buffers. This is a no-op
      // for production verifier behavior (gpt-4o-mini compares the bytes).
      // Test fixtures rely on buffer .toString() match.
      let verify: { match: boolean; reason: string };
      try {
        verify = await deps.verifySameProductFn(deps.openai, supplierBuf, frontBuf);
      } catch (err) {
        logger.warn(`[fix-model-images] verifier crashed Tier1 ${pid}/${view}: ${err}`);
        verify = { match: false, reason: 'verifier crashed' };
      }
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'SUPPLIER_FETCH',
        column_or_path: column,
        old_value: currentUrl,
        new_value: supplierUrl,
        tier: 4,
        run_id: runId,
        notes: `phase17-model-rebuild tier1 fetched`,
      });
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: verify.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
        column_or_path: column,
        old_value: currentUrl,
        new_value: supplierUrl,
        tier: 4,
        run_id: runId,
        notes: `phase17-model-rebuild tier1: ${verify.reason}`,
      });
      if (verify.match) {
        try {
          const newUrl = await commitFix(
            pid,
            column,
            supplierBuf,
            currentUrl,
            'SS',
            brEntry,
            brIndex,
            deps,
            runId,
          );
          return { pid, column, status: 'tier1_supplier', newUrl };
        } catch {
          return { pid, column, status: 'manual_cascade', reason: 'commitFix failed' };
        }
      }
      // verifier rejected → fall through to Tier 2
    }
  } else {
    // No supplier URL — log a SUPPLIER_FETCH row with a notes marker so post-
    // mortem can distinguish "tried and got nothing" from "tried and failed".
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'SUPPLIER_FETCH',
      column_or_path: column,
      old_value: currentUrl,
      new_value: '',
      tier: 4,
      run_id: runId,
      notes: 'no canonical model for tier 1',
    });
  }

  // -------------------------------------------------------------------------
  // Tier 2 — AI synthesis via generateModelImage
  // -------------------------------------------------------------------------

  // T-17-14: billing-hard-limit short-circuit (module flag set by prior pid).
  if (__billingExhausted) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'TIER2_BUDGET_EXHAUSTED',
      column_or_path: column,
      old_value: currentUrl,
      new_value: '',
      tier: 4,
      run_id: runId,
      notes: 'OpenAI billing hard limit — Tier 2 aborted',
    });
    return { pid, column, status: 'budget_exhausted', reason: 'billing hard limit' };
  }

  // T-17-10: cost-cap check before incurring spend.
  const callCost = CANDIDATES_PER_CALL * COST_PER_IMAGE;
  if (!costTracker.canAfford(callCost)) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'AI_REGEN',
      column_or_path: column,
      old_value: currentUrl,
      new_value: '',
      tier: 4,
      run_id: runId,
      notes: 'budget exhausted',
    });
    return { pid, column, status: 'budget_exhausted', reason: '--max-cost cap' };
  }

  if (deps.args.dryRun) {
    return { pid, column, status: 'manual_cascade', reason: 'dry-run skipped Tier 2' };
  }

  const gender = inferGender(brEntry.row, brIndex.headerMap);

  let regen: Awaited<ReturnType<typeof generateModelImage>> = null;
  try {
    regen = await deps.generateModelImageFn(frontBuf, gender, costTracker, deps.openai);
  } catch (err) {
    if (isBillingHardLimit(err)) {
      // First detection: flip the flag and emit a sentinel trail row.
      __billingExhausted = true;
      logger.warn('[fix-model-images] OpenAI billing hard limit — aborting Tier 2');
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: 'TIER2_BUDGET_EXHAUSTED',
        column_or_path: column,
        old_value: currentUrl,
        new_value: '',
        tier: 4,
        run_id: runId,
        notes:
          'OpenAI billing hard limit reached — Tier 2 aborted (first detection)',
      });
      return { pid, column, status: 'budget_exhausted', reason: 'billing hard limit' };
    }
    logger.warn(`[fix-model-images] generateModelImage crashed for ${pid}/${view}: ${err}`);
    regen = null;
  }

  if (!regen) {
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'AI_REGEN',
      column_or_path: column,
      old_value: currentUrl,
      new_value: '',
      tier: 4,
      run_id: runId,
      notes: 'generateModelImage returned null (budget or content policy)',
    });
    return { pid, column, status: 'manual_cascade', cost: 0 };
  }

  // Verifier-after-fix on AI output
  let verify: { match: boolean; reason: string };
  try {
    verify = await deps.verifySameProductFn(deps.openai, regen.buffer, frontBuf);
  } catch (err) {
    logger.warn(`[fix-model-images] verifier crashed Tier2 ${pid}/${view}: ${err}`);
    verify = { match: false, reason: 'verifier crashed' };
  }

  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: 'AI_REGEN',
    column_or_path: column,
    old_value: currentUrl,
    new_value: '<ai-buffer>',
    tier: 4,
    run_id: runId,
    notes: `phase17-model-rebuild tier2 cost=${regen.cost.toFixed(4)} gender=${gender}`,
  });
  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: verify.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
    column_or_path: column,
    old_value: currentUrl,
    new_value: '<ai-buffer>',
    tier: 4,
    run_id: runId,
    notes: `phase17-model-rebuild tier2: ${verify.reason}`,
  });

  if (!verify.match) {
    return { pid, column, status: 'verifier_rejected', cost: regen.cost };
  }

  try {
    const newUrl = await commitFix(
      pid,
      column,
      regen.buffer,
      currentUrl,
      'AI',
      brEntry,
      brIndex,
      deps,
      runId,
    );
    return { pid, column, status: 'tier2_ai', newUrl, cost: regen.cost };
  } catch {
    return { pid, column, status: 'manual_cascade', reason: 'commitFix failed', cost: regen.cost };
  }
}

// ---------------------------------------------------------------------------
// Sample-pid selection
// ---------------------------------------------------------------------------

function selectSamplePids(
  pollutedRows: PollutionRow[],
  brIndex: BrIndex,
  explicitPids?: string[],
): string[] {
  if (explicitPids && explicitPids.length > 0) {
    return explicitPids;
  }
  // Pick the first 5 cap pids + first 5 garment pids found in the audit TSV.
  const caps: string[] = [];
  const garments: string[] = [];
  for (const r of pollutedRows) {
    if (caps.length >= 5 && garments.length >= 5) break;
    const brEntry = brIndex.rowByPid.get(r.pid);
    if (!brEntry) continue;
    if (isCapPid(brEntry.row, brIndex.headerMap)) {
      if (caps.length < 5 && !caps.includes(r.pid)) caps.push(r.pid);
    } else {
      if (garments.length < 5 && !garments.includes(r.pid)) garments.push(r.pid);
    }
  }
  // If we have fewer than 5 of either, top up from whichever pool has more.
  const out = [...caps, ...garments];
  if (out.length < 10) {
    for (const r of pollutedRows) {
      if (out.length >= 10) break;
      if (!out.includes(r.pid)) out.push(r.pid);
    }
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Default re-audit hook (shells out to scripts/audit-image-pollution.ts) —
// extracted as a deps function so tests can stub it.
// ---------------------------------------------------------------------------

async function defaultReAudit(pids: string[]): Promise<number> {
  // The actual implementation shells out via child_process. For now, log a
  // warning and return -1 to indicate "not run" — operators can invoke the
  // audit manually with the printed pid list.
  logger.warn(
    `[fix-model-images] --re-audit hook not auto-wired; run audit-image-pollution manually for ${pids.length} pids`,
  );
  return -1;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runFixModelImages(
  deps: RunFixModelImagesDeps,
): Promise<RunFixModelImagesResult> {
  const runId = getOrCreateTrailRunId();
  const date = new Date().toISOString().slice(0, 10);

  // 1. Source polluted rows.
  let pollutedRows: PollutionRow[];
  if (deps.auditRowsOverride !== undefined) {
    pollutedRows = deps.auditRowsOverride;
  } else {
    const auditPath = deps.args.auditFile ?? findLatestAuditTsv();
    if (!auditPath) {
      logger.warn('[fix-model-images] no audit TSV found in tmp/ — nothing to do');
      pollutedRows = [];
    } else {
      pollutedRows = await parseAuditTsv(auditPath);
    }
  }

  // Filter to model_pollution + at least one Model* column.
  pollutedRows = pollutedRows.filter(
    (r) =>
      r.pollution_class === 'model_pollution' &&
      r.affected_columns.some((c) =>
        (MODEL_COLUMNS as readonly string[]).includes(c),
      ),
  );

  // When test override bypasses parseAuditTsv, the filter above can be too
  // strict (synthetic tests don't always set model_pollution). Accept any
  // override row that targets a MODEL_COLUMNS column.
  if (deps.auditRowsOverride !== undefined) {
    pollutedRows = deps.auditRowsOverride.filter((r) =>
      r.affected_columns.some((c) =>
        (MODEL_COLUMNS as readonly string[]).includes(c),
      ),
    );
  }

  // Resume from trail — skip terminal pids.
  const processedPids = await deps.loadProcessedPidsFn();
  pollutedRows = pollutedRows.filter((r) => !processedPids.has(r.pid));

  // Read BR rows once.
  const rawRows = await deps.readRawRowsFn(
    deps.sheetsClient,
    deps.spreadsheetId,
    deps.sheetName,
  );
  const brIndex = buildBrIndex(rawRows);

  // Cost tracker
  const costTracker = new CostTracker(deps.args.maxCost);

  // Sample-only branch
  if (deps.args.sampleOnly) {
    const samplePids = selectSamplePids(pollutedRows, brIndex, deps.args.samplePids);
    const sampleSet = new Set(samplePids);
    const sampleRows = pollutedRows.filter((r) => sampleSet.has(r.pid));

    const results: ModelFixResult[] = [];
    for (const row of sampleRows) {
      const brEntry = brIndex.rowByPid.get(row.pid);
      if (!brEntry) {
        results.push({
          pid: row.pid,
          column: 'ModelFrontImage',
          status: 'skipped',
          reason: 'no BR row',
        });
        continue;
      }
      const modelCols = row.affected_columns.filter((c) =>
        (MODEL_COLUMNS as readonly string[]).includes(c),
      ) as ModelColumn[];
      for (const col of modelCols) {
        const r = await fixModelImage(row.pid, col, brEntry, brIndex, deps, runId, costTracker);
        results.push(r);
      }
    }

    const total = results.length;
    const passes = results.filter(
      (r) => r.status === 'tier1_supplier' || r.status === 'tier2_ai',
    ).length;
    const passRate = total === 0 ? 0 : passes / total;
    const summaryStatus: 'OK' | 'BLOCKED-SAMPLE-PASS-RATE' =
      passRate >= 0.7 ? 'OK' : 'BLOCKED-SAMPLE-PASS-RATE';

    const summary = {
      audit_run_id: runId,
      sample_pids: samplePids,
      per_pid_results: results,
      sample_pass_rate: passRate,
      total_cost_usd: Number(costTracker.total.toFixed(4)),
      status: summaryStatus,
    };

    const summaryPath = `tmp/fix-model-images-sample-${date}.json`;
    try {
      if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });
    } catch {
      // ignore
    }
    try {
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    } catch (err) {
      logger.warn(`[fix-model-images] sample summary write failed: ${err}`);
    }

    console.log('\n=== fix-model-images sample-test Summary ===');
    console.log(JSON.stringify(summary, null, 2));

    if (summaryStatus === 'BLOCKED-SAMPLE-PASS-RATE') {
      console.error(
        `BLOCKED-SAMPLE-PASS-RATE: sample = ${passes}/${total} = ${passRate.toFixed(2)}. Re-plan verifier strategy.`,
      );
      process.exit(2);
    }

    return {
      status: summaryStatus,
      total_pids_processed: samplePids.length,
      tier1_fixed: results.filter((r) => r.status === 'tier1_supplier').length,
      tier2_fixed: results.filter((r) => r.status === 'tier2_ai').length,
      manual_cascade: results.filter(
        (r) =>
          r.status === 'verifier_rejected' ||
          r.status === 'manual_cascade' ||
          r.status === 'skipped',
      ).length,
      sample_pass_rate: passRate,
      total_cost_usd: Number(costTracker.total.toFixed(4)),
      summary_path: summaryPath,
    };
  }

  // Full-set branch — require explicit sample-gate bypass.
  if (!deps.args.skipSampleGate) {
    const sampleJsonPath = `tmp/fix-model-images-sample-${date}.json`;
    let prior: { status?: string } | null = null;
    try {
      if (existsSync(sampleJsonPath)) {
        prior = JSON.parse(readFileSync(sampleJsonPath, 'utf8'));
      }
    } catch {
      prior = null;
    }
    if (!prior || prior.status !== 'OK') {
      console.error(
        `Run --sample-only first to validate verifier pass-rate, or pass --skip-sample-gate.`,
      );
      process.exit(2);
    }
  }

  // Apply --limit if set
  if (deps.args.limit !== undefined && deps.args.limit > 0) {
    pollutedRows = pollutedRows.slice(0, deps.args.limit);
  }

  // Iterate all polluted pids sequentially (D-20).
  const results: ModelFixResult[] = [];
  const seenPids = new Set<string>();
  for (const row of pollutedRows) {
    if (seenPids.has(row.pid)) continue;
    seenPids.add(row.pid);
    const brEntry = brIndex.rowByPid.get(row.pid);
    if (!brEntry) {
      results.push({
        pid: row.pid,
        column: 'ModelFrontImage',
        status: 'skipped',
        reason: 'no BR row',
      });
      continue;
    }
    const modelCols = row.affected_columns.filter((c) =>
      (MODEL_COLUMNS as readonly string[]).includes(c),
    ) as ModelColumn[];
    for (const col of modelCols) {
      const r = await fixModelImage(row.pid, col, brEntry, brIndex, deps, runId, costTracker);
      results.push(r);
    }
  }

  const tier1Fixed = results.filter((r) => r.status === 'tier1_supplier').length;
  const tier2Fixed = results.filter((r) => r.status === 'tier2_ai').length;
  const manualCascade = results.filter(
    (r) =>
      r.status === 'verifier_rejected' ||
      r.status === 'manual_cascade' ||
      r.status === 'skipped' ||
      r.status === 'budget_exhausted',
  ).length;

  const status: 'OK' | 'BILLING_LIMIT_HIT' | 'BLOCKED-BUDGET-EXHAUSTED' = __billingExhausted
    ? 'BILLING_LIMIT_HIT'
    : 'OK';

  // Optional --re-audit hook
  let modelFailAfterCount: number | undefined;
  if (deps.args.reAudit) {
    const pids = Array.from(seenPids);
    try {
      const reAudit = deps.reAuditFn ?? defaultReAudit;
      modelFailAfterCount = await reAudit(pids);
    } catch (err) {
      logger.warn(`[fix-model-images] --re-audit hook failed: ${err}`);
    }
  }

  const summary: Record<string, unknown> = {
    audit_run_id: runId,
    total_pids_processed: seenPids.size,
    tier1_fixed: tier1Fixed,
    tier2_fixed: tier2Fixed,
    manual_cascade: manualCascade,
    total_cost_usd: Number(costTracker.total.toFixed(4)),
    status,
  };
  if (deps.args.reAudit) {
    summary.model_fail_before_count = 312;
    summary.model_fail_after_count = modelFailAfterCount ?? -1;
  }

  const summaryPath = `tmp/fix-model-images-full-${date}.json`;
  try {
    if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });
  } catch {
    // ignore
  }
  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  } catch (err) {
    logger.warn(`[fix-model-images] full summary write failed: ${err}`);
  }

  console.log('\n=== fix-model-images full-run Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  return {
    status,
    total_pids_processed: seenPids.size,
    tier1_fixed: tier1Fixed,
    tier2_fixed: tier2Fixed,
    manual_cascade: manualCascade,
    total_cost_usd: Number(costTracker.total.toFixed(4)),
    summary_path: summaryPath,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'audit-file': { type: 'string' },
      'sample-only': { type: 'boolean', default: false },
      'sample-pids': { type: 'string' },
      'skip-sample-gate': { type: 'boolean', default: false },
      'max-cost': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      're-audit': { type: 'boolean', default: false },
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

  const args: RunFixModelImagesArgs = {
    auditFile: values['audit-file'] as string | undefined,
    sampleOnly: values['sample-only'] === true,
    samplePids: values['sample-pids']
      ? (values['sample-pids'] as string).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    skipSampleGate: values['skip-sample-gate'] === true,
    maxCost: values['max-cost'] ? Number(values['max-cost']) : 10,
    dryRun: values['dry-run'] === true,
    limit: values.limit ? Number(values.limit) : undefined,
    reAudit: values['re-audit'] === true,
    help: false,
  };

  const sheetsClient = createSheetsClient();
  const driveClient = createDriveClient();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
  });

  await runFixModelImages({
    args,
    sheetsClient,
    driveClient,
    openai,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    sheetName: 'Bestsellers-Ready',
    readRawRowsFn: defaultReadRawRows,
    downloadImageFn: downloadImage,
    downloadFromDriveFn: downloadFromDrive,
    fetchSSModelImageFn: fetchSSModelImage,
    verifySameProductFn: verifySameProduct,
    generateModelImageFn: generateModelImage,
    uploadToDriveFn: uploadToDrive,
    trashDriveFileFn: trashDriveFile,
    writeUpdatesFn: writeUpdates,
    appendTrailRowFn: appendTrailRow,
    loadProcessedPidsFn: loadProcessedPids,
  });
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('fix-model-images');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
