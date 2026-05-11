// READ-ONLY retro audit script for Phase 15 (SPEC R6 + CONTEXT D-04/D-05).
// MUST NEVER call uploadToDrive, writeUpdates, or modify Drive/Sheets.
// Only output: tmp/garment-type-rejects.tsv via appendRejectRow.
//
// Mirrors the structure of scripts/audit-images.ts (DI seam, parseArgs,
// chunked reader for --all, colorGroupMap dedup) but stripped of every
// write-side concern. See 15-PATTERNS.md "scripts/audit-garment-types.ts"
// for the analog map.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows, readRowRange } from '../src/sheets/reader.js';
import { downloadImage } from '../src/shopify/image-standardizer.js';
import { verifyGarmentTypeMatch } from '../src/lib/ai-image-generator.js';
import { appendRejectRow, getOrCreateRunId } from '../src/lib/rejects-tsv.js';
import { logger } from '../src/lib/logger.js';
import type { SheetRow } from '../src/sheets/types.js';
import type { sheets_v4 } from 'googleapis';

// ---------------------------------------------------------------------------
// Types for dependency injection (enables unit testing without real network)
// ---------------------------------------------------------------------------

export interface RunGarmentTypeAuditArgs {
  styleId?: string;
  all: boolean;
  dryRun: boolean;
  limit?: number;
  help: boolean;
}

export interface RunGarmentTypeAuditDeps {
  args: RunGarmentTypeAuditArgs;
  sheetsClient: unknown;
  openai: OpenAI;
  readAllRowsFn: typeof readAllRows;
  readRowRangeFn: typeof readRowRange;
  downloadImageFn: typeof downloadImage;
  verifierFn: typeof verifyGarmentTypeMatch;
  appendRejectRowFn: typeof appendRejectRow;
  spreadsheetId: string;
  sheetName: string;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Garment Type Audit CLI — Phase 15 (read-only)

Scans BR back/side images and flags shape-mismatched uploads (e.g.
crewneck-with-hoodie-back). Writes ONLY tmp/garment-type-rejects.tsv.
Never touches Drive or Sheets.

Usage:
  npx tsx scripts/audit-garment-types.ts --style-id <ID>
  npx tsx scripts/audit-garment-types.ts --all
  npx tsx scripts/audit-garment-types.ts --dry-run --all
  npx tsx scripts/audit-garment-types.ts --limit 50 --all

Flags:
  --style-id <ID>   Style ID to audit (processes all color rows).
  --all             Scan every row.
  --dry-run         List target rows without calling Vision.
  --limit N         Process at most N products (post dedup).
  --help, -h        Show this help message.

Environment variables required:
  OPENAI_API_KEY
  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_PRIVATE_KEY
  GOOGLE_SPREADSHEET_ID
  GOOGLE_SHEET_NAME (optional, default: Sheet1)
`);
}

// ---------------------------------------------------------------------------
// Pure-ish audit runner (DI seam — exported for testing)
// ---------------------------------------------------------------------------

export async function runGarmentTypeAudit(
  deps: RunGarmentTypeAuditDeps,
): Promise<{ processedRows: number; mismatchCount: number; skippedCount: number }> {
  const {
    args,
    sheetsClient,
    openai,
    readAllRowsFn,
    readRowRangeFn,
    downloadImageFn,
    verifierFn,
    appendRejectRowFn,
    spreadsheetId,
    sheetName,
  } = deps;

  const runId = getOrCreateRunId();
  let processedRows = 0;
  let mismatchCount = 0;
  let skippedCount = 0;

  // Mirror scripts/audit-images.ts:336 isInvalidUrl check.
  const isInvalidUrl = (url: string) => !url || url.includes('assetly.ordermygear');

  // Process one row: download front, then verify each view, write rejects on
  // mismatch. Per audit-runner.ts:333-336 discipline, all per-row failures
  // log a warn and fall through — never crash the loop.
  async function processRow(row: SheetRow): Promise<void> {
    processedRows++;

    if (isInvalidUrl(row.FrontImage)) {
      skippedCount++;
      logger.warn(`[audit-garment-types] Skipping ${row.productId}: invalid FrontImage`);
      return;
    }

    // No back/side at all? Nothing to verify — skip silently (don't count).
    if (isInvalidUrl(row.BackImage) && isInvalidUrl(row.DirectSideImage)) {
      return;
    }

    let frontBuf: Buffer;
    try {
      frontBuf = await downloadImageFn(row.FrontImage);
    } catch (err) {
      skippedCount++;
      logger.warn(`[audit-garment-types] Failed to download front for ${row.productId}: ${err}`);
      return;
    }

    for (const view of ['back', 'side'] as const) {
      const url = view === 'back' ? row.BackImage : row.DirectSideImage;
      if (isInvalidUrl(url)) continue;

      if (args.dryRun) {
        console.log(`  [dry-run] would verify ${row.productId}/${view}`);
        continue;
      }

      try {
        const viewBuf = await downloadImageFn(url);
        const result = await verifierFn(openai, viewBuf, frontBuf);
        if (!result.match) {
          mismatchCount++;
          await appendRejectRowFn({
            pid: row.productId,
            view,
            reason: result.reason,
            timestamp: new Date().toISOString(),
            run_id: runId,
          });
          console.log(`  MISMATCH: ${row.productId}/${view} — ${result.reason}`);
        }
      } catch (err) {
        logger.warn(`[audit-garment-types] Failed verifying ${row.productId}/${view}: ${err}`);
        // Do NOT increment mismatchCount on verifier exception — only on confirmed mismatch.
      }
    }
  }

  if (args.styleId) {
    const { rows } = await readAllRowsFn(
      sheetsClient as sheets_v4.Sheets,
      spreadsheetId,
      sheetName,
    );
    const targetRows = rows.filter((r) => r.styleID.trim() === args.styleId!.trim());

    // Dedup by (styleID, colorName) so size-rows aren't re-processed.
    // Mirrors scripts/audit-images.ts:140-149 colorGroupMap pattern.
    const colorGroupMap = new Map<string, SheetRow>();
    for (const r of targetRows) {
      const key = `${r.styleID.trim()}|${r.colorName.trim()}`;
      if (!colorGroupMap.has(key)) colorGroupMap.set(key, r);
    }
    const unique = [...colorGroupMap.values()];
    const limited = args.limit ? unique.slice(0, args.limit) : unique;
    for (const r of limited) await processRow(r);
  } else if (args.all) {
    // Chunked reader (mirror scripts/audit-images.ts:302-310 + dedup).
    const CHUNK_SIZE = 1000;
    let chunkNum = 0;
    let hasMore = true;
    let productsProcessed = 0;
    const seenColors = new Set<string>();

    while (hasMore) {
      const offset = chunkNum * CHUNK_SIZE;
      const { rows } = await readRowRangeFn(
        sheetsClient as sheets_v4.Sheets,
        spreadsheetId,
        offset,
        CHUNK_SIZE,
        sheetName,
      );
      if (rows.length === 0) {
        hasMore = false;
        break;
      }
      if (rows.length < CHUNK_SIZE) hasMore = false;

      for (const r of rows) {
        const key = `${r.styleID.trim()}|${r.colorName.trim()}`;
        if (seenColors.has(key)) continue;
        seenColors.add(key);
        if (args.limit !== undefined && productsProcessed >= args.limit) {
          hasMore = false;
          break;
        }
        await processRow(r);
        productsProcessed++;
      }
      chunkNum++;
    }
  } else {
    throw new Error('Must pass --style-id <ID> or --all');
  }

  return { processedRows, mismatchCount, skippedCount };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'style-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    showHelp();
    return;
  }

  // Env validation — fail fast BEFORE constructing any clients so missing
  // OPENAI_API_KEY doesn't trigger the SDK's own error path.
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

  const args: RunGarmentTypeAuditArgs = {
    styleId: values['style-id'] as string | undefined,
    all: values.all === true,
    dryRun: values['dry-run'] === true,
    limit: values.limit ? Number(values.limit) : undefined,
    help: false,
  };

  if (!args.styleId && !args.all) {
    console.error('Must pass --style-id <ID> or --all');
    showHelp();
    process.exit(1);
  }

  const sheetsClient = createSheetsClient();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
  });

  const summary = await runGarmentTypeAudit({
    args,
    sheetsClient,
    openai,
    readAllRowsFn: readAllRows,
    readRowRangeFn: readRowRange,
    downloadImageFn: downloadImage,
    verifierFn: verifyGarmentTypeMatch,
    appendRejectRowFn: appendRejectRow,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Sheet1',
  });

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${summary.processedRows}`);
  console.log(`Mismatches: ${summary.mismatchCount}`);
  console.log(`Skipped: ${summary.skippedCount}`);
  console.log(`Output: tmp/garment-type-rejects.tsv (run_id: ${getOrCreateRunId()})`);
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-garment-types');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
