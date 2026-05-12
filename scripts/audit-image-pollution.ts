// READ-ONLY 3-pass image pollution audit for Phase 16 (SPEC R1, R2; CONTEXT D-01 through D-09).
// MUST NEVER call uploadToDrive, writeUpdates, trashDriveFile, or modify Drive/Sheets.
// Only output: tmp/image-pollution-audit-{YYYY-MM-DD}.tsv + trail rows (tier=0 audit-side events).
// Mirrors scripts/audit-garment-types.ts skeleton; extends with raw-row reader for Model* columns.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient, extractFileId, downloadFromDrive, getDriveFileMetadata } from '../src/sheets/drive.js';
import { downloadImage } from '../src/shopify/image-standardizer.js';
import { verifyGarmentTypeMatch } from '../src/lib/ai-image-generator.js';
import { verifySameProduct } from '../src/lib/verify-same-product.js';
import { resolveSupplierCanonical } from '../src/lib/supplier-canonical.js';
import { appendTrailRow, getOrCreateTrailRunId } from '../src/lib/image-pollution-trail.js';
import { logger } from '../src/lib/logger.js';
import type { sheets_v4, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Pollution class enum + valid image mime types
// ---------------------------------------------------------------------------

export const POLLUTION_CLASSES = [
  'shared_url',
  'invalid_image_format',
  'content_mismatch',
  'model_pollution',
  'shape_drift',
] as const;
export type PollutionClass = (typeof POLLUTION_CLASSES)[number];

const VALID_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const IMAGE_COLUMNS = [
  'FrontImage',
  'BackImage',
  'DirectSideImage',
  'ModelFrontImage',
  'ModelSideImage',
  'ModelBackImage',
] as const;

const MODEL_COLUMNS = ['ModelFrontImage', 'ModelSideImage', 'ModelBackImage'] as const;

// ---------------------------------------------------------------------------
// CLI types + DI seam
// ---------------------------------------------------------------------------

export interface RunImagePollutionAuditArgs {
  all: boolean;
  pid?: string;
  dryRun: boolean;
  reAudit: boolean;
  postMortem: boolean;
  limit?: number;
  help: boolean;
  maxDriveRps?: number;
  backoffBaseMs?: number;
}

export interface RunImagePollutionAuditDeps {
  args: RunImagePollutionAuditArgs;
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
  getDriveFileMetadataFn: typeof getDriveFileMetadata;
  verifyShapeFn: typeof verifyGarmentTypeMatch;
  verifySameProductFn: typeof verifySameProduct;
  supplierCanonicalFn: typeof resolveSupplierCanonical;
  appendTrailRowFn: typeof appendTrailRow;
  spreadsheetId: string;
  sheetName: string;
}

export interface AuditRow {
  pid: string;
  pollution_class: PollutionClass | 'info';
  affected_columns: string;
  affected_drive_urls: string;
  expected_supplier_url: string;
  recommended_fix_tier: string;
  pass_detected_in: string;
  notes: string;
}

export interface AuditSummary {
  pidsScanned: number;
  pidsPolluted: number;
  classCounts: Record<PollutionClass, number>;
  headwearSkipped: number;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Image Pollution Audit CLI — Phase 16 (read-only, 3-pass)

Scans Bestsellers-Ready image columns and flags pollution across 5 classes:
  shared_url, invalid_image_format, content_mismatch, model_pollution, shape_drift.

Writes ONLY tmp/image-pollution-audit-{YYYY-MM-DD}.tsv + trail rows (tier=0).
Never touches Drive or Sheets.

Usage:
  npx tsx scripts/audit-image-pollution.ts --all
  npx tsx scripts/audit-image-pollution.ts --pid 6110
  npx tsx scripts/audit-image-pollution.ts --dry-run --all
  npx tsx scripts/audit-image-pollution.ts --re-audit --all
  npx tsx scripts/audit-image-pollution.ts --post-mortem

Flags:
  --all              Scan every BR row.
  --pid <id>         Audit a single pid (bypasses chunked --all).
  --dry-run          Skip AI calls; print pass plan only.
  --re-audit         Run again; output suffix '-reaudit'. For R10 phase-close.
  --post-mortem      Inspect manual queue / trail without running passes.
  --limit N          Process at most N pids (post dedup).
  --max-drive-rps N  Rate-limit Drive metadata calls (default 10).
  --help, -h         Show this help message.

Environment variables required:
  OPENAI_API_KEY
  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_PRIVATE_KEY
  GOOGLE_SPREADSHEET_ID
  SS_ACCOUNT_NUMBER (for Pass 2 supplier-canonical S&S branch)
  SS_API_KEY        (for Pass 2 supplier-canonical S&S branch)
`);
}

// ---------------------------------------------------------------------------
// Default raw-row reader — cannot use readAllRows.
// Cannot use readAllRows — SheetRow (src/sheets/types.ts) lacks Model* columns.
// See RESEARCH Pitfall 1 + PATTERNS Option B.
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
// Sanitize for TSV — single space replacement for tab/newline/CR runs (T-16-06)
// ---------------------------------------------------------------------------

function sanitize(s: string): string {
  return (s ?? '').replace(/[\t\n\r]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Drive metadata rate-limit + 403/429 backoff helper
// ---------------------------------------------------------------------------

class DriveRateLimiter {
  private lastCallAt = 0;
  private readonly minIntervalMs: number;

  constructor(maxRps: number) {
    this.minIntervalMs = maxRps > 0 ? Math.max(0, Math.floor(1000 / maxRps)) : 0;
  }

  async wait(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise<void>((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastCallAt = Date.now();
  }
}

function isQuotaError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (!e) return false;
  if (e.code === 403 || e.code === 429) {
    if (Array.isArray(e.errors)) {
      return e.errors.some(
        (x: { reason?: string }) =>
          x?.reason === 'quotaExceeded' ||
          x?.reason === 'userRateLimitExceeded' ||
          x?.reason === 'rateLimitExceeded',
      );
    }
    return true;
  }
  return false;
}

async function getDriveMetadataWithBackoff(
  drive: drive_v3.Drive,
  fileId: string,
  fn: typeof getDriveFileMetadata,
  limiter: DriveRateLimiter,
  backoffBaseMs: number,
): Promise<{ mimeType: string; size: string; name: string } | null> {
  const maxRetries = 5;
  let attempt = 0;
  while (attempt <= maxRetries) {
    await limiter.wait();
    try {
      return await fn(drive, fileId);
    } catch (err) {
      if (!isQuotaError(err) || attempt === maxRetries) {
        if (attempt === maxRetries) {
          logger.warn(
            `[audit-image-pollution] drive_quota_exceeded after ${maxRetries} retries on ${fileId}`,
          );
          return null;
        }
        throw err;
      }
      // Exponential backoff with jitter
      const base = backoffBaseMs * Math.pow(2, attempt);
      const jitter = Math.random() * base * 0.3;
      const wait = Math.min(30_000, base + jitter);
      await new Promise<void>((r) => setTimeout(r, wait));
      attempt++;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit TSV writer — writes ONCE at end of run with D-09 summary header.
// ---------------------------------------------------------------------------

function writeAuditTSV(
  rows: AuditRow[],
  summary: AuditSummary,
  runId: string,
  suffix: string,
): string {
  const d = new Date().toISOString().slice(0, 10);
  const path = `tmp/image-pollution-audit-${d}${suffix}.tsv`;

  if (!existsSync('tmp')) {
    try {
      mkdirSync('tmp', { recursive: true });
    } catch {
      // ignore — writeFileSync will surface real errors
    }
  }

  const cc = summary.classCounts;
  const header =
    `# audit_run_id=${runId}\n` +
    `# pids_scanned=${summary.pidsScanned}\n` +
    `# pids_polluted=${summary.pidsPolluted}\n` +
    `# class_counts: shared_url=${cc.shared_url} invalid_image_format=${cc.invalid_image_format} content_mismatch=${cc.content_mismatch} model_pollution=${cc.model_pollution} shape_drift=${cc.shape_drift}\n` +
    `# headwear_skipped_count=${summary.headwearSkipped}\n` +
    `pid\tpollution_class\taffected_columns\taffected_drive_urls\texpected_supplier_url\trecommended_fix_tier\tpass_detected_in\tnotes\n`;

  const body = rows
    .map((r) =>
      [
        sanitize(r.pid),
        r.pollution_class,
        sanitize(r.affected_columns),
        sanitize(r.affected_drive_urls),
        sanitize(r.expected_supplier_url),
        r.recommended_fix_tier,
        r.pass_detected_in,
        sanitize(r.notes),
      ].join('\t'),
    )
    .join('\n');

  try {
    writeFileSync(path, header + body + (body ? '\n' : ''));
  } catch (err) {
    logger.warn(`[audit-image-pollution] Failed to write audit TSV: ${err}`);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Per-pid data shape (built from raw rows)
// ---------------------------------------------------------------------------

interface PidData {
  pid: string;
  styleId: string;
  // column → URL
  urls: Map<string, string>;
}

function buildPidData(rows: string[][]): PidData[] {
  if (rows.length === 0) return [];
  const header = rows[0];
  const h: Record<string, number> = {};
  header.forEach((x, i) => {
    h[x] = i;
  });

  const pidIdx = h['productId'] ?? -1;
  const styleIdx = h['styleID'] ?? -1;

  // Dedup by productId — first occurrence wins.
  const byPid = new Map<string, PidData>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const pid = String(row[pidIdx] ?? '').trim();
    if (!pid) continue;
    if (byPid.has(pid)) continue;
    const data: PidData = {
      pid,
      styleId: String(row[styleIdx] ?? '').trim(),
      urls: new Map(),
    };
    for (const col of IMAGE_COLUMNS) {
      const idx = h[col];
      if (idx === undefined) continue;
      const v = String(row[idx] ?? '').trim();
      if (v) data.urls.set(col, v);
    }
    byPid.set(pid, data);
  }
  return [...byPid.values()];
}

// ---------------------------------------------------------------------------
// Pass 1 — structural (free; no AI)
//   a) shared_url: fileId reused across distinct pids (any column combination)
//   b) invalid_image_format: Drive mimeType not in VALID_IMAGE_MIMES
// ---------------------------------------------------------------------------

async function pass1Structural(
  targetPids: PidData[],
  deps: RunImagePollutionAuditDeps,
  runId: string,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  const args = deps.args;

  // Step 1: build fileId → Map<pid, columns[]>
  const fileIdMap = new Map<string, Map<string, Set<string>>>();
  for (const p of targetPids) {
    for (const [col, url] of p.urls) {
      const fid = extractFileId(url);
      if (!fid) continue;
      if (!fileIdMap.has(fid)) fileIdMap.set(fid, new Map());
      const inner = fileIdMap.get(fid)!;
      if (!inner.has(p.pid)) inner.set(p.pid, new Set());
      inner.get(p.pid)!.add(col);
    }
  }

  // Step 2: detect shared_url — fileId used across >1 distinct pid
  for (const [fid, pidMap] of fileIdMap) {
    if (pidMap.size <= 1) continue;
    const collidingPids = [...pidMap.keys()];
    for (const [pid, cols] of pidMap) {
      const others = collidingPids.filter((x) => x !== pid).join(', ');
      const colsArr = [...cols].sort();
      // Find canonical URL for the fileId — pick the original URL from any pid
      const url = `https://drive.google.com/uc?id=${fid}`;
      const recTier = await recommendedFixTier(pid, deps);
      rows.push({
        pid,
        pollution_class: 'shared_url',
        affected_columns: colsArr.join(','),
        affected_drive_urls: url,
        expected_supplier_url: '',
        recommended_fix_tier: recTier,
        pass_detected_in: '1',
        notes: `shared with: ${others}`,
      });
      try {
        await deps.appendTrailRowFn({
          timestamp_iso: new Date().toISOString(),
          pid,
          operation: 'VERIFIER_FAIL',
          column_or_path: colsArr.join(','),
          old_value: url,
          new_value: '',
          tier: 0,
          run_id: runId,
          notes: `pass1 shared_url collision (with ${others})`,
        });
      } catch {
        // trail is side-channel
      }
    }
  }

  // Step 3: invalid_image_format via Drive metadata
  if (!args.dryRun) {
    const limiter = new DriveRateLimiter(args.maxDriveRps ?? 10);
    const backoffBaseMs = args.backoffBaseMs ?? 1000;
    const polluted = new Set(rows.map((r) => r.pid));

    for (const p of targetPids) {
      for (const [col, url] of p.urls) {
        const fid = extractFileId(url);
        if (!fid) continue;
        // Skip if already polluted by shared_url for same column? No — different
        // class. Still check mime to surface dual flags.
        let meta: { mimeType: string; size: string; name: string } | null = null;
        try {
          meta = await getDriveMetadataWithBackoff(
            deps.driveClient,
            fid,
            deps.getDriveFileMetadataFn,
            limiter,
            backoffBaseMs,
          );
        } catch (err) {
          logger.warn(
            `[audit-image-pollution] Drive metadata failed for ${p.pid}/${col}: ${err}`,
          );
          continue;
        }
        if (!meta) continue;
        if (!VALID_IMAGE_MIMES.has(meta.mimeType)) {
          const recTier = await recommendedFixTier(p.pid, deps);
          rows.push({
            pid: p.pid,
            pollution_class: 'invalid_image_format',
            affected_columns: col,
            affected_drive_urls: url,
            expected_supplier_url: '',
            recommended_fix_tier: recTier,
            pass_detected_in: '1',
            notes: `non-image mime: ${meta.mimeType}`,
          });
          polluted.add(p.pid);
          try {
            await deps.appendTrailRowFn({
              timestamp_iso: new Date().toISOString(),
              pid: p.pid,
              operation: 'VERIFIER_FAIL',
              column_or_path: col,
              old_value: url,
              new_value: '',
              tier: 0,
              run_id: runId,
              notes: `pass1 invalid_image_format mime=${meta.mimeType}`,
            });
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return rows;
}

// Pass-1 + Pass-2 quick canonical-availability check. Used both for the
// recommended_fix_tier hint (tier 1 if canonical available, else 3) and for
// short-circuiting Pass 2 when supplier-canonical returns null.
async function recommendedFixTier(
  pid: string,
  deps: RunImagePollutionAuditDeps,
): Promise<string> {
  if (deps.args.dryRun) return '1';
  try {
    const canon = await deps.supplierCanonicalFn(pid);
    return canon ? '1' : '3';
  } catch {
    return '3';
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — AI content verification (D-03, D-04, D-05)
//   a) BR FrontImage vs supplier canonical → content_mismatch
//   b) Each Model* column vs garment Front → model_pollution
// ---------------------------------------------------------------------------

async function pass2Content(
  targetPids: PidData[],
  pass1Polluted: Set<string>,
  deps: RunImagePollutionAuditDeps,
  runId: string,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];

  for (const p of targetPids) {
    if (pass1Polluted.has(p.pid)) continue;

    // 2a: BR Front vs supplier canonical
    const front = p.urls.get('FrontImage');
    let canonicalUrl: string | null = null;
    let canonicalSource: string | undefined;

    let canonical: { url: string; source: string; styleId?: number | string } | null = null;
    try {
      canonical = (await deps.supplierCanonicalFn(p.pid)) as typeof canonical;
    } catch (err) {
      logger.warn(`[audit-image-pollution] supplier-canonical failed for ${p.pid}: ${err}`);
    }
    if (canonical) {
      canonicalUrl = canonical.url;
      canonicalSource = canonical.source;
    } else {
      // D-04: log no_canonical_available as informational row; do NOT count polluted.
      rows.push({
        pid: p.pid,
        pollution_class: 'info',
        affected_columns: 'FrontImage',
        affected_drive_urls: front ?? '',
        expected_supplier_url: '',
        recommended_fix_tier: '3',
        pass_detected_in: '2',
        notes: 'no_canonical_available',
      });
    }

    let frontBuf: Buffer | null = null;

    if (canonicalUrl && front) {
      const frontFid = extractFileId(front);
      if (frontFid) {
        try {
          frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
        } catch (err) {
          logger.warn(`[audit-image-pollution] BR Front download failed for ${p.pid}: ${err}`);
        }
      }
      let canonicalBuf: Buffer | null = null;
      try {
        canonicalBuf = await deps.downloadImageFn(canonicalUrl);
      } catch (err) {
        logger.warn(
          `[audit-image-pollution] canonical download failed for ${p.pid} (${canonicalSource}): ${err}`,
        );
      }
      if (frontBuf && canonicalBuf) {
        try {
          const result = await deps.verifySameProductFn(deps.openai, frontBuf, canonicalBuf);
          try {
            await deps.appendTrailRowFn({
              timestamp_iso: new Date().toISOString(),
              pid: p.pid,
              operation: result.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
              column_or_path: 'FrontImage',
              old_value: front,
              new_value: canonicalUrl,
              tier: 0,
              run_id: runId,
              notes: `pass2 front-vs-canonical: ${result.reason}`,
            });
          } catch {
            // ignore
          }
          if (!result.match) {
            rows.push({
              pid: p.pid,
              pollution_class: 'content_mismatch',
              affected_columns: 'FrontImage',
              affected_drive_urls: front,
              expected_supplier_url: canonicalUrl,
              recommended_fix_tier: '1',
              pass_detected_in: '2',
              notes: result.reason,
            });
          }
        } catch (err) {
          logger.warn(`[audit-image-pollution] verifier (front-vs-canonical) crashed for ${p.pid}: ${err}`);
        }
      }
    }

    // 2b: Model* vs garment Front (only if we have a Front buffer or can download it)
    let frontBufForModel = frontBuf;
    if (!frontBufForModel && front) {
      const frontFid = extractFileId(front);
      if (frontFid) {
        try {
          frontBufForModel = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
        } catch {
          // skip model checks if front cannot be read
        }
      }
    }
    if (frontBufForModel) {
      for (const modelCol of MODEL_COLUMNS) {
        const modelUrl = p.urls.get(modelCol);
        if (!modelUrl) continue;
        const modelFid = extractFileId(modelUrl);
        if (!modelFid) continue;
        let modelBuf: Buffer | null = null;
        try {
          modelBuf = await deps.downloadFromDriveFn(deps.driveClient, modelFid);
        } catch (err) {
          logger.warn(`[audit-image-pollution] ${modelCol} download failed for ${p.pid}: ${err}`);
          continue;
        }
        try {
          const result = await deps.verifySameProductFn(deps.openai, modelBuf, frontBufForModel);
          try {
            await deps.appendTrailRowFn({
              timestamp_iso: new Date().toISOString(),
              pid: p.pid,
              operation: result.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
              column_or_path: modelCol,
              old_value: modelUrl,
              new_value: front ?? '',
              tier: 0,
              run_id: runId,
              notes: `pass2 ${modelCol}-vs-front: ${result.reason}`,
            });
          } catch {
            // ignore
          }
          if (!result.match) {
            rows.push({
              pid: p.pid,
              pollution_class: 'model_pollution',
              affected_columns: modelCol,
              affected_drive_urls: modelUrl,
              expected_supplier_url: '',
              recommended_fix_tier: '1',
              pass_detected_in: '2',
              notes: result.reason,
            });
          }
        } catch (err) {
          logger.warn(`[audit-image-pollution] verifier (${modelCol}-vs-front) crashed for ${p.pid}: ${err}`);
        }
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Pass 3 — AI shape verification (D-06, D-07)
//   Back/DirectSide vs Front via verifyGarmentTypeMatch.
//   Per D-07: only runs on pids clean from Pass 1 AND Pass 2.
// ---------------------------------------------------------------------------

async function pass3Shape(
  targetPids: PidData[],
  pass1Polluted: Set<string>,
  pass2Polluted: Set<string>,
  deps: RunImagePollutionAuditDeps,
  runId: string,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];

  for (const p of targetPids) {
    if (pass1Polluted.has(p.pid)) continue;
    if (pass2Polluted.has(p.pid)) continue;

    const front = p.urls.get('FrontImage');
    if (!front) continue;
    const frontFid = extractFileId(front);
    if (!frontFid) continue;

    let frontBuf: Buffer;
    try {
      frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
    } catch (err) {
      logger.warn(`[audit-image-pollution] pass3 front download failed for ${p.pid}: ${err}`);
      continue;
    }

    for (const viewCol of ['BackImage', 'DirectSideImage'] as const) {
      const url = p.urls.get(viewCol);
      if (!url) continue;
      const fid = extractFileId(url);
      if (!fid) continue;
      let viewBuf: Buffer;
      try {
        viewBuf = await deps.downloadFromDriveFn(deps.driveClient, fid);
      } catch (err) {
        logger.warn(`[audit-image-pollution] ${viewCol} download failed for ${p.pid}: ${err}`);
        continue;
      }
      try {
        const result = await deps.verifyShapeFn(deps.openai, viewBuf, frontBuf);
        try {
          await deps.appendTrailRowFn({
            timestamp_iso: new Date().toISOString(),
            pid: p.pid,
            operation: result.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
            column_or_path: viewCol,
            old_value: url,
            new_value: front,
            tier: 0,
            run_id: runId,
            notes: `pass3 ${viewCol}-vs-front: ${result.reason}`,
          });
        } catch {
          // ignore
        }
        if (!result.match) {
          rows.push({
            pid: p.pid,
            pollution_class: 'shape_drift',
            affected_columns: viewCol,
            affected_drive_urls: url,
            expected_supplier_url: '',
            recommended_fix_tier: '2',
            pass_detected_in: '3',
            notes: result.reason,
          });
        }
      } catch (err) {
        logger.warn(`[audit-image-pollution] verifyShape crashed for ${p.pid}/${viewCol}: ${err}`);
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main runner — orchestrates the 3 passes + writes the audit TSV
// ---------------------------------------------------------------------------

export async function runImagePollutionAudit(
  deps: RunImagePollutionAuditDeps,
): Promise<AuditSummary> {
  const runId = getOrCreateTrailRunId();
  const args = deps.args;

  // Post-mortem short-circuit — read manual queue without running passes.
  if (args.postMortem) {
    return runPostMortem();
  }

  const rawRows = await deps.readRawRowsFn(
    deps.sheetsClient,
    deps.spreadsheetId,
    deps.sheetName,
  );
  const allPids = buildPidData(rawRows);

  // Filter to target pids: optional --pid, headwear exclusion, optional --limit.
  let headwearSkipped = 0;
  const targetPids: PidData[] = [];
  for (const p of allPids) {
    if (args.pid && p.pid !== args.pid) continue;
    if (/^H08/i.test(p.pid)) {
      headwearSkipped++;
      continue;
    }
    targetPids.push(p);
  }
  const limited =
    args.limit !== undefined && args.limit > 0
      ? targetPids.slice(0, args.limit)
      : targetPids;

  const classCounts: Record<PollutionClass, number> = {
    shared_url: 0,
    invalid_image_format: 0,
    content_mismatch: 0,
    model_pollution: 0,
    shape_drift: 0,
  };

  let allRows: AuditRow[] = [];

  if (args.dryRun) {
    // dry-run: only do Pass 1 SHARED-URL detection (no Drive metadata, no AI).
    // Sufficient to print pass plan + budget sanity.
    const pass1 = await pass1Structural(limited, deps, runId);
    for (const r of pass1) {
      if (r.pollution_class in classCounts) {
        classCounts[r.pollution_class as PollutionClass]++;
      }
    }
    allRows = pass1;
  } else {
    // Pass 1 — structural
    const pass1 = await pass1Structural(limited, deps, runId);
    const pass1Set = new Set(pass1.map((r) => r.pid));

    // Pass 2 — AI content
    const pass2 = await pass2Content(limited, pass1Set, deps, runId);
    const pass2Set = new Set(
      pass2
        .filter((r) => r.pollution_class !== 'info')
        .map((r) => r.pid),
    );

    // Pass 3 — AI shape (D-07: only Pass-1+2-clean pids)
    const pass3 = await pass3Shape(limited, pass1Set, pass2Set, deps, runId);

    allRows = [...pass1, ...pass2, ...pass3];
    for (const r of allRows) {
      if (r.pollution_class in classCounts) {
        classCounts[r.pollution_class as PollutionClass]++;
      }
    }
  }

  const pollutedPids = new Set(
    allRows.filter((r) => r.pollution_class !== 'info').map((r) => r.pid),
  );
  const summary: AuditSummary = {
    pidsScanned: limited.length,
    pidsPolluted: pollutedPids.size,
    classCounts,
    headwearSkipped,
  };

  const suffix = args.reAudit ? '-reaudit' : '';
  writeAuditTSV(allRows, summary, runId, suffix);

  console.log('\n=== Image Pollution Audit Summary ===');
  console.log(`audit_run_id=${runId}`);
  console.log(`pids_scanned=${summary.pidsScanned}`);
  console.log(`pids_polluted=${summary.pidsPolluted}`);
  console.log(
    `class_counts: shared_url=${classCounts.shared_url} invalid_image_format=${classCounts.invalid_image_format} content_mismatch=${classCounts.content_mismatch} model_pollution=${classCounts.model_pollution} shape_drift=${classCounts.shape_drift}`,
  );
  console.log(`headwear_skipped_count=${summary.headwearSkipped}`);
  if (args.reAudit) {
    console.log(`RE-AUDIT result: ${summary.pidsPolluted} pids still polluted`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Post-mortem (--post-mortem): inspect manual queue without running audit.
// ---------------------------------------------------------------------------

function runPostMortem(): AuditSummary {
  const d = new Date().toISOString().slice(0, 10);
  const queuePath = `tmp/image-pollution-manual-queue-${d}.tsv`;
  const classCounts: Record<PollutionClass, number> = {
    shared_url: 0,
    invalid_image_format: 0,
    content_mismatch: 0,
    model_pollution: 0,
    shape_drift: 0,
  };
  let pidsScanned = 0;

  if (existsSync(queuePath)) {
    const content = readFileSync(queuePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#') || line.startsWith('pid\t')) continue;
      const cols = line.split('\t');
      const cls = cols[1] as PollutionClass | undefined;
      if (cls && cls in classCounts) {
        classCounts[cls]++;
        pidsScanned++;
      }
    }
    console.log('\n=== POST-MORTEM (manual queue breakdown) ===');
    console.log(`source: ${queuePath}`);
    console.log(`total_pids: ${pidsScanned}`);
    console.log(
      `class_counts: shared_url=${classCounts.shared_url} invalid_image_format=${classCounts.invalid_image_format} content_mismatch=${classCounts.content_mismatch} model_pollution=${classCounts.model_pollution} shape_drift=${classCounts.shape_drift}`,
    );
  } else {
    console.log(`\n[post-mortem] No manual queue found at ${queuePath}`);
  }

  return {
    pidsScanned,
    pidsPolluted: pidsScanned,
    classCounts,
    headwearSkipped: 0,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      pid: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      're-audit': { type: 'boolean', default: false },
      'post-mortem': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'max-drive-rps': { type: 'string' },
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

  const args: RunImagePollutionAuditArgs = {
    all: values.all === true,
    pid: values.pid as string | undefined,
    dryRun: values['dry-run'] === true,
    reAudit: values['re-audit'] === true,
    postMortem: values['post-mortem'] === true,
    limit: values.limit ? Number(values.limit) : undefined,
    maxDriveRps: values['max-drive-rps']
      ? Number(values['max-drive-rps'])
      : 10,
    help: false,
  };

  if (!args.all && !args.pid && !args.postMortem) {
    console.error('Must pass --all, --pid <id>, or --post-mortem');
    showHelp();
    process.exit(1);
  }

  const sheetsClient = createSheetsClient();
  const driveClient = createDriveClient();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
  });

  await runImagePollutionAudit({
    args,
    sheetsClient,
    driveClient,
    openai,
    readRawRowsFn: defaultReadRawRows,
    downloadImageFn: downloadImage,
    downloadFromDriveFn: downloadFromDrive,
    getDriveFileMetadataFn: getDriveFileMetadata,
    verifyShapeFn: verifyGarmentTypeMatch,
    verifySameProductFn: verifySameProduct,
    supplierCanonicalFn: resolveSupplierCanonical,
    appendTrailRowFn: appendTrailRow,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    sheetName: 'Bestsellers-Ready',
  });
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-image-pollution');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
