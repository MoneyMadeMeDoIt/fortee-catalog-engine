/**
 * AI Category & Keyword Generator (Phase 19-02).
 *
 * For each unique productId in Bestsellers-Ready (~291), makes ONE structured-output
 * call to OpenAI gpt-4o-mini returning { baseCategory, categoriesPath, keywords[] },
 * then fans the result out to ALL variant rows for that product.
 *
 * Default mode: dry-run  — emits a preview TSV, writes NOTHING to the sheet.
 * Apply mode:   --apply  — backs up the 3 affected columns first, then writes via writeUpdates.
 *
 * Usage:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/gen-categories-keywords.ts [options]
 *
 * Options:
 *   --apply          Write changes to the sheet (default: dry-run).
 *   --force          Re-process already-filled products (skip idempotent skip-if-filled).
 *   --limit N        Cap the number of products processed (smoke test).
 *   --pid X          Process a single productId only.
 *
 * Requirements:
 *   - OPENAI_API_KEY must be set in .env (operator chose OpenAI; existing key).
 *   - Prefix all invocations with NODE_OPTIONS=--use-system-ca (D-04, AV TLS interception).
 *
 * Safety invariants:
 *   - Dry-run default (D-14): never writes to the sheet without --apply.
 *   - Backup-before-apply (D-14): writes tmp/gen-cat-kw-backup-{ts}.tsv before any sheet write.
 *   - Null-resolving baseCategory never written (D-07): getCategoryGroup() post-validation gate.
 *   - Row-1 guard (P5): every emitted range targets sheetRow >= 2.
 *   - Idempotent (OPS-02): skip-if-filled unless --force.
 *   - Checkpoint (OPS-01): per-product checkpoint in tmp/gen-categories-keywords-checkpoint.json.
 *   - One call per product (D-03): classify once, fan out to all variant rows.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { google } from 'googleapis';
import { createSheetsClient } from '../src/sheets/client.js';
import { writeUpdates } from '../src/sheets/writer.js';
import { columnToLetter } from '../src/sheets/column-map.js';
import type { EnrichmentUpdate } from '../src/sheets/types.js';
import {
  buildPrompt,
  isCleanKeyword,
  SAFE_BASE_CATEGORIES,
} from './lib/category-schema.js';
import type { CategoryOutput } from './lib/category-schema.js';
import { getCategoryGroup } from '../src/shopify/variants.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const TAB = 'Bestsellers-Ready';
const CHECKPOINT_FILE = 'tmp/gen-categories-keywords-checkpoint.json';

/** Column names we write to (the 3 target columns). */
const TARGET_COLUMNS = ['baseCategory', 'categories', 'keywords'] as const;

/** Concurrency for the productId worker pool (D-03: bounded, not per-row). */
const CONCURRENCY = 8;

/** Max tokens for a Claude Haiku 4.5 structured-output call (~291 products × ~200 tokens = safe). */
const MAX_TOKENS = 512;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Checkpoint file shape. */
export interface Checkpoint {
  completedPids: string[];
  failedPids: string[];
  timestamp: string;
}

/** A product row entry for fan-out (0-based dataRows index + the raw row array). */
export interface ProductRowEntry {
  rowIndex: number;  // 0-based index into dataRows (sheetRow = rowIndex + 2)
  row: string[];
}

/** Input to buildUpdatesForProduct — all DI'd for unit testing. */
export interface BuildUpdatesInput {
  productResult: CategoryOutput;
  rowsForPid: ProductRowEntry[];
  headers: string[];
  idColIdx: number;
  colorColIdx: number;
  catColIdx: number;       // 'categories' column
  keywordsColIdx: number;  // 'keywords' column
  baseCatColIdx: number;   // 'baseCategory' column
  tab: string;
}

/** Output stats from buildUpdatesForProduct. */
export interface UpdateStats {
  written_new: number;
  overwritten_changed: number;
  skipped_already_current: number;
  flagged_unsafe_basecat: number;
}

/** Preview line for one product (written to dry-run TSV). */
export interface PreviewRow {
  pid: string;
  baseCategory_old: string;
  baseCategory_new: string;
  baseCategory_changed: boolean;  // D-14: flag decoration-affecting changes
  categoriesPath: string;
  keywords: string;
  rowCount: number;
}

/** Full output of buildUpdatesForProduct. */
export interface BuildUpdatesResult {
  updates: EnrichmentUpdate[];
  preview: PreviewRow;
  stats: UpdateStats;
}

// ─── Pure core: groupRowsByProductId ─────────────────────────────────────────

/**
 * Groups data rows by productId (trimmed+uppercased for consistency).
 * Rows with empty productId are skipped (counted in skipped_no_pid).
 *
 * @returns Map<pid, ProductRowEntry[]> where rowIndex is the 0-based dataRows index.
 */
export function groupRowsByProductId(
  dataRows: string[][],
  idColIdx: number,
): { groups: Map<string, ProductRowEntry[]>; skipped_no_pid: number } {
  const groups = new Map<string, ProductRowEntry[]>();
  let skipped_no_pid = 0;

  for (let ri = 0; ri < dataRows.length; ri++) {
    const row = dataRows[ri];
    const rawPid = row[idColIdx] ?? '';
    const pid = rawPid.trim().toUpperCase();

    if (!pid) {
      skipped_no_pid++;
      continue;
    }

    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid)!.push({ rowIndex: ri, row });
  }

  return { groups, skipped_no_pid };
}

// ─── Pure core: buildUpdatesForProduct ───────────────────────────────────────

/**
 * Build EnrichmentUpdate[] for ONE product's rows.
 *
 * Pure function — no network, no file I/O. Fully unit-testable.
 *
 * Implements:
 *   - D-07: null-resolving baseCategory is never written; existing value preserved + logged
 *   - D-11: fan-out identical values to ALL variant rows of this productId
 *   - D-14: flags decoration-affecting baseCategory changes in the preview
 *   - OPS-02: skip cells already holding the target value (delta-only)
 *   - P5 row-1 guard: sheetRow = rowIndex + 2; assert >= 2
 *   - KW-02 belt-and-suspenders: drop any dirty keywords that somehow passed the schema
 */
export function buildUpdatesForProduct(args: BuildUpdatesInput): BuildUpdatesResult {
  const {
    productResult,
    rowsForPid,
    headers,
    catColIdx,
    keywordsColIdx,
    baseCatColIdx,
    tab,
  } = args;

  const stats: UpdateStats = {
    written_new: 0,
    overwritten_changed: 0,
    skipped_already_current: 0,
    flagged_unsafe_basecat: 0,
  };

  const updates: EnrichmentUpdate[] = [];

  // D-07 post-validation: if getCategoryGroup returns null for the model's baseCategory,
  // do NOT write it. Leave existing value unchanged and flag.
  const baseCatGroup = getCategoryGroup(productResult.baseCategory);
  const baseCatSafe = baseCatGroup !== null;

  if (!baseCatSafe) {
    stats.flagged_unsafe_basecat++;
    console.warn(
      `[gen-categories-keywords] FLAGGED: baseCategory="${productResult.baseCategory}" ` +
      `resolves null via getCategoryGroup() — leaving existing value unchanged.`,
    );
  }

  // KW-02 belt-and-suspenders: drop dirty keywords even if schema allowed them.
  const cleanKeywords = productResult.keywords.filter(kw => {
    const clean = isCleanKeyword(kw);
    if (!clean) {
      console.warn(
        `[gen-categories-keywords] Dropping dirty keyword "${kw}" that escaped schema validation.`,
      );
    }
    return clean;
  });

  // Keywords column format: comma-separated (matches existing BR column convention).
  const keywordsValue = cleanKeywords.join(', ');
  const categoriesValue = productResult.categoriesPath;

  // Compute old baseCategory from the first row for preview + change-flag.
  const firstRow = rowsForPid[0]?.row ?? [];
  const oldBaseCategory = (firstRow[baseCatColIdx] ?? '').trim();

  // Fan-out: emit the same 3 values to EVERY row of this productId.
  for (const { rowIndex, row } of rowsForPid) {
    // P5 row-1 guard: sheetRow must be >= 2.
    const sheetRow = rowIndex + 2;
    if (sheetRow < 2) {
      throw new Error(
        `[gen-categories-keywords] Row-1 guard violated: rowIndex=${rowIndex} → sheetRow=${sheetRow}`,
      );
    }

    // 1. baseCategory column (only if the model's value is safe)
    if (baseCatSafe) {
      const existingBaseCat = (row[baseCatColIdx] ?? '').trim();
      const newBaseCat = productResult.baseCategory;

      if (existingBaseCat === newBaseCat) {
        stats.skipped_already_current++;
      } else {
        const colLetter = columnToLetter(baseCatColIdx);
        updates.push({ range: `'${tab}'!${colLetter}${sheetRow}`, values: [[newBaseCat]] });
        if (existingBaseCat === '') {
          stats.written_new++;
        } else {
          stats.overwritten_changed++;
        }
      }
    }

    // 2. categories column (never blank a populated cell with an empty value)
    const existingCat = (row[catColIdx] ?? '').trim();
    if (categoriesValue === '' || existingCat === categoriesValue) {
      stats.skipped_already_current++;
    } else {
      const colLetter = columnToLetter(catColIdx);
      updates.push({ range: `'${tab}'!${colLetter}${sheetRow}`, values: [[categoriesValue]] });
      if (existingCat === '') {
        stats.written_new++;
      } else {
        stats.overwritten_changed++;
      }
    }

    // 3. keywords column (never blank a populated cell with an empty value)
    const existingKw = (row[keywordsColIdx] ?? '').trim();
    if (keywordsValue === '' || existingKw === keywordsValue) {
      stats.skipped_already_current++;
    } else {
      const colLetter = columnToLetter(keywordsColIdx);
      updates.push({ range: `'${tab}'!${colLetter}${sheetRow}`, values: [[keywordsValue]] });
      if (existingKw === '') {
        stats.written_new++;
      } else {
        stats.overwritten_changed++;
      }
    }
  }

  const preview: PreviewRow = {
    pid: (firstRow[args.idColIdx] ?? '').trim().toUpperCase(),
    baseCategory_old: oldBaseCategory,
    baseCategory_new: baseCatSafe ? productResult.baseCategory : oldBaseCategory,
    baseCategory_changed: baseCatSafe && productResult.baseCategory !== oldBaseCategory,
    categoriesPath: categoriesValue,
    keywords: keywordsValue,
    rowCount: rowsForPid.length,
  };

  return { updates, preview, stats };
}

// ─── classifyProduct ──────────────────────────────────────────────────────────

/**
 * Calls OpenAI gpt-4o-mini with a single structured-output request for one product.
 *
 * Per D-02 (revised 2026-06-10, operator chose OpenAI — existing key, no setup):
 * uses client.chat.completions.create() with response_format json_object, then
 * extracts the fields leniently (gpt-4o-mini json_object is not schema-guaranteed).
 * Safety is enforced downstream in buildUpdatesForProduct: baseCategory via the
 * getCategoryGroup() gate (D-07), keywords via isCleanKeyword (KW-02). ONE call per
 * product (D-03). Runtime: invoke with NODE_OPTIONS=--use-system-ca (AV TLS).
 *
 * Error handling (Pitfall 12):
 *   - 429 insufficient_quota / billing hard limit → save checkpoint + clean exit signal.
 *   - 429 rate-limit → retry with bounded backoff.
 *   - Other errors → rethrow.
 */
export async function classifyProduct(
  input: Parameters<typeof buildPrompt>[0],
  client: OpenAI,
): Promise<CategoryOutput> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a product-classification assistant. Respond ONLY with a single valid JSON object matching the requested fields — no prose, no markdown fences.',
          },
          { role: 'user', content: buildPrompt(input) },
        ],
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) {
        throw new Error('[gen-categories-keywords] classifyProduct: empty completion content');
      }
      const obj = JSON.parse(raw) as Record<string, unknown>;
      // Lenient extraction. gpt-4o-mini's json_object output is NOT schema-
      // guaranteed, and a strict z.enum on baseCategory hard-fails ~25% of products
      // that return a sensible-but-non-verbatim garment label ("Hoodie" instead of
      // "Fleece - Core - Hood"). Safety is enforced DOWNSTREAM, not here:
      //  - baseCategory → getCategoryGroup() gate in buildUpdatesForProduct (D-07):
      //    a value that resolves null is left unchanged + flagged, never written.
      //  - keywords → cleaned against isCleanKeyword (KW-02/D-10), capped at 15.
      //  - categoriesPath → display-only (D-08); written as-is when non-empty.
      const keywords = Array.isArray(obj.keywords)
        ? (obj.keywords as unknown[])
            .filter((k): k is string => typeof k === 'string' && isCleanKeyword(k))
            .slice(0, 15)
        : [];
      return {
        baseCategory: String(obj.baseCategory ?? '').trim(),
        categoriesPath: String(obj.categoriesPath ?? '').trim(),
        keywords,
      } as CategoryOutput;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const errMsg = (err as Error)?.message ?? '';
      const code =
        (err as { code?: string })?.code ??
        (err as { error?: { code?: string } })?.error?.code ??
        (err as { error?: { type?: string } })?.error?.type ??
        '';
      const isRateLimit = status === 429;

      if (isRateLimit) {
        // Distinguish quota / billing hard limit (monthly cap) from transient rate-limit.
        const isQuotaError =
          code === 'insufficient_quota' ||
          code === 'billing_hard_limit_reached' ||
          errMsg.toLowerCase().includes('quota') ||
          errMsg.toLowerCase().includes('billing') ||
          errMsg.toLowerCase().includes('exceeded your current');

        if (isQuotaError) {
          // Pitfall 12: quota hit — signal clean exit to the caller.
          const quotaErr = new Error(
            `[gen-categories-keywords] OpenAI usage cap / quota reached. ` +
            `Checkpoint saved — re-run after raising the cap or topping up.\n` +
            `Original error: ${errMsg}`,
          );
          (quotaErr as any).isQuotaExhausted = true;
          throw quotaErr;
        }

        // Transient rate-limit: retry with bounded backoff.
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * attempt;
          console.warn(
            `[gen-categories-keywords] Rate limited (attempt ${attempt}/${MAX_RETRIES}). ` +
            `Retrying in ${delay}ms...`,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      // Not a rate limit, or retries exhausted — rethrow.
      throw err;
    }
  }

  throw new Error('[gen-categories-keywords] classifyProduct: exhausted retries');
}

// ─── Checkpoint helpers ────────────────────────────────────────────────────────

function loadCheckpoint(filePath: string): Checkpoint {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    }
  } catch (err) {
    console.warn(`[gen-categories-keywords] Could not read checkpoint: ${(err as Error).message}`);
  }
  return { completedPids: [], failedPids: [], timestamp: '' };
}

function saveCheckpoint(filePath: string, checkpoint: Checkpoint): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  checkpoint.timestamp = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
}

// ─── TSV writers ──────────────────────────────────────────────────────────────

function writePreviewTsv(filePath: string, rows: PreviewRow[]): void {
  const header = 'pid\tbaseCategory_old\tbaseCategory_new\tbaseCategory_CHANGED\tcategoriesPath\tkeywords\trowCount\n';
  const body = rows
    .map(r =>
      [
        r.pid,
        r.baseCategory_old,
        r.baseCategory_new,
        r.baseCategory_changed ? 'CHANGED' : '',
        r.categoriesPath,
        r.keywords,
        String(r.rowCount),
      ].join('\t'),
    )
    .join('\n');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, header + body, 'utf8');
}

function writeBackupTsv(
  filePath: string,
  headers: string[],
  dataRows: string[][],
  idColIdx: number,
  colorColIdx: number,
  baseCatColIdx: number,
  catColIdx: number,
  keywordsColIdx: number,
): void {
  const tsvHeader = ['pid', 'colorName', 'baseCategory', 'categories', 'keywords'].join('\t') + '\n';
  const lines: string[] = [];

  for (const row of dataRows) {
    const pid = (row[idColIdx] ?? '').trim().toUpperCase();
    if (!pid) continue;
    const color = row[colorColIdx] ?? '';
    const baseCat = row[baseCatColIdx] ?? '';
    const cat = row[catColIdx] ?? '';
    const kw = row[keywordsColIdx] ?? '';
    lines.push([pid, color, baseCat, cat, kw].join('\t'));
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, tsvHeader + lines.join('\n'), 'utf8');
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

/**
 * Process a list of products with bounded concurrency.
 * Writes checkpoint after each completed product.
 * Stops cleanly on quota exhaustion.
 */
async function processProductsWithConcurrency(
  pids: string[],
  groups: Map<string, ProductRowEntry[]>,
  headers: string[],
  idColIdx: number,
  colorColIdx: number,
  baseCatColIdx: number,
  catColIdx: number,
  keywordsColIdx: number,
  client: OpenAI,
  checkpoint: Checkpoint,
  checkpointPath: string,
  tab: string,
): Promise<{
  allUpdates: EnrichmentUpdate[];
  allPreviews: PreviewRow[];
  totalStats: {
    written_new: number;
    overwritten_changed: number;
    skipped_already_current: number;
    flagged_unsafe_basecat: number;
    products_called: number;
    products_skipped: number;
  };
  quotaExhausted: boolean;
}> {
  const allUpdates: EnrichmentUpdate[] = [];
  const allPreviews: PreviewRow[] = [];
  const totalStats = {
    written_new: 0,
    overwritten_changed: 0,
    skipped_already_current: 0,
    flagged_unsafe_basecat: 0,
    products_called: 0,
    products_skipped: 0,
  };
  let quotaExhausted = false;

  // Work queue
  let queueIdx = 0;
  const mu = { active: 0 };

  const processOne = async (pid: string): Promise<void> => {
    const rowsForPid = groups.get(pid) ?? [];
    if (rowsForPid.length === 0) return;

    // Extract product metadata from the first row for the prompt.
    const firstRow = rowsForPid[0].row;
    const getCol = (name: string): string => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? (firstRow[idx] ?? '') : '';
    };

    const promptInput = {
      productName: getCol('productName'),
      description: getCol('description'),
      brandName: getCol('brandName'),
      gender: getCol('gender'),
      fit: getCol('fit'),
      weightGSM: getCol('weightGSM'),
      currentBaseCategory: getCol('baseCategory'),
    };

    try {
      const productResult = await classifyProduct(promptInput, client);
      totalStats.products_called++;

      const result = buildUpdatesForProduct({
        productResult,
        rowsForPid,
        headers,
        idColIdx,
        colorColIdx,
        catColIdx,
        keywordsColIdx,
        baseCatColIdx,
        tab,
      });

      allUpdates.push(...result.updates);
      allPreviews.push(result.preview);

      totalStats.written_new += result.stats.written_new;
      totalStats.overwritten_changed += result.stats.overwritten_changed;
      totalStats.skipped_already_current += result.stats.skipped_already_current;
      totalStats.flagged_unsafe_basecat += result.stats.flagged_unsafe_basecat;

      // Checkpoint: record completed pid immediately (OPS-01/D-13).
      checkpoint.completedPids.push(pid);
      saveCheckpoint(checkpointPath, checkpoint);

      console.log(
        `[gen-categories-keywords] ${pid}: baseCategory="${productResult.baseCategory}" ` +
        `→ ${result.stats.written_new} new, ${result.stats.overwritten_changed} changed, ` +
        `${result.stats.skipped_already_current} same`,
      );
    } catch (err: unknown) {
      if ((err as any).isQuotaExhausted) {
        quotaExhausted = true;
        throw err; // propagate to stop the pool
      }
      // Non-quota error: record as failed but continue.
      console.error(
        `[gen-categories-keywords] Failed pid=${pid}: ${(err as Error).message ?? err}`,
      );
      checkpoint.failedPids.push(pid);
      saveCheckpoint(checkpointPath, checkpoint);
    }
  };

  // Simple bounded-concurrency runner.
  const workers: Promise<void>[] = [];

  const runNext = async (): Promise<void> => {
    while (queueIdx < pids.length && !quotaExhausted) {
      const pid = pids[queueIdx++];
      await processOne(pid);
    }
  };

  for (let i = 0; i < Math.min(CONCURRENCY, pids.length); i++) {
    workers.push(runNext());
  }

  try {
    await Promise.all(workers);
  } catch (err) {
    if ((err as any).isQuotaExhausted) {
      // Already flagged; fallthrough to return partial results.
    } else {
      throw err;
    }
  }

  return { allUpdates, allPreviews, totalStats, quotaExhausted };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Startup: verify OPENAI_API_KEY ─────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[gen-categories-keywords] ERROR: OPENAI_API_KEY is not set.\n' +
      'Add it to your .env file:\n' +
      '  OPENAI_API_KEY=sk-...\n' +
      'Note: run this script with NODE_OPTIONS=--use-system-ca (AV TLS interception).',
    );
    process.exit(1);
  }

  // ── CLI args ──────────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const forceMode = args.includes('--force');
  const dryRun = !applyMode;

  const limitArgIdx = args.indexOf('--limit');
  const limitN = limitArgIdx >= 0 ? parseInt(args[limitArgIdx + 1] ?? '0', 10) : 0;

  const pidArgIdx = args.indexOf('--pid');
  const singlePid = pidArgIdx >= 0 ? (args[pidArgIdx + 1] ?? '').trim().toUpperCase() : undefined;

  console.log(`=== gen-categories-keywords ${dryRun ? '[DRY RUN]' : '[APPLY]'} ===`);
  if (forceMode) console.log('[FORCE] Re-processing already-filled products.');
  if (singlePid) console.log(`[SINGLE] Processing only pid=${singlePid}`);
  if (limitN > 0) console.log(`[LIMIT] Capped at ${limitN} products.`);

  // ── OpenAI client ─────────────────────────────────────────────────────────
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ── Sheets client ─────────────────────────────────────────────────────────
  const sheets = createSheetsClient();
  const sheetsApi = google.sheets({
    version: 'v4',
    auth: (sheets as any).context._options.auth,
  });

  // ── Load checkpoint ────────────────────────────────────────────────────────
  const checkpointPath = CHECKPOINT_FILE;
  const checkpoint = loadCheckpoint(checkpointPath);
  const completedSet = new Set(checkpoint.completedPids);

  if (completedSet.size > 0) {
    console.log(`[checkpoint] Resuming: ${completedSet.size} pids already completed.`);
  }

  // ── Read live header row (D-12: raw values.get, never readAllRows) ─────────
  console.log('\n[sheets] Reading header row...');
  const headerResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'!1:1`,
  });
  const headers: string[] = (headerResp.data.values?.[0] ?? []).map((h: unknown) =>
    String(h ?? '').trim(),
  );
  console.log(`[sheets] Header row: ${headers.length} column(s)`);

  // Resolve required column indices from the live header.
  const requiredCols = ['productId', 'colorName', 'baseCategory', 'categories', 'keywords'];
  const colIndices: Record<string, number> = {};
  for (const col of requiredCols) {
    const idx = headers.indexOf(col);
    if (idx === -1) {
      throw new Error(
        `[gen-categories-keywords] Required column "${col}" not found in header. ` +
        `Header has ${headers.length} columns.`,
      );
    }
    colIndices[col] = idx;
  }

  const idColIdx = colIndices['productId']!;
  const colorColIdx = colIndices['colorName']!;
  const baseCatColIdx = colIndices['baseCategory']!;
  const catColIdx = colIndices['categories']!;
  const keywordsColIdx = colIndices['keywords']!;

  // ── Read all data rows (D-12: raw values.get) ─────────────────────────────
  console.log('\n[sheets] Reading all data rows...');
  const dataResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'`,
  });
  const allRows = dataResp.data.values ?? [];
  const dataRows = allRows.slice(1) as string[][];
  console.log(`[sheets] Data rows: ${dataRows.length}`);

  // ── Group rows by productId ────────────────────────────────────────────────
  const { groups, skipped_no_pid } = groupRowsByProductId(dataRows, idColIdx);
  console.log(`[plan] ${groups.size} unique productId(s); ${skipped_no_pid} rows skipped (no productId)`);

  // ── Build the list of pids to process ─────────────────────────────────────
  let pidsToProcess: string[] = [...groups.keys()];

  if (singlePid) {
    if (!groups.has(singlePid)) {
      console.error(`[gen-categories-keywords] pid="${singlePid}" not found in BR.`);
      process.exit(1);
    }
    pidsToProcess = [singlePid];
  }

  // OPS-02 idempotent skip-if-filled: skip pids whose 3 target cells are already non-empty
  // (unless --force).
  let products_skipped = 0;
  const filteredPids: string[] = [];

  for (const pid of pidsToProcess) {
    // Skip already-completed pids from checkpoint.
    if (completedSet.has(pid)) {
      products_skipped++;
      continue;
    }

    if (!forceMode) {
      const rows = groups.get(pid) ?? [];
      const firstRow = rows[0]?.row ?? [];
      const existingBaseCat = (firstRow[baseCatColIdx] ?? '').trim();
      const existingCat = (firstRow[catColIdx] ?? '').trim();
      const existingKw = (firstRow[keywordsColIdx] ?? '').trim();

      if (existingBaseCat && existingCat && existingKw) {
        products_skipped++;
        continue;
      }
    }

    filteredPids.push(pid);
  }

  // Apply --limit if set.
  const pidsForRun = limitN > 0 ? filteredPids.slice(0, limitN) : filteredPids;

  console.log(
    `[plan] Processing ${pidsForRun.length} product(s) ` +
    `(${products_skipped} skipped — already complete or in checkpoint).`,
  );

  if (pidsForRun.length === 0) {
    console.log('\n[gen-categories-keywords] Nothing to process — all products already classified.');
    printStats({
      written_new: 0,
      overwritten_changed: 0,
      skipped_already_current: 0,
      flagged_unsafe_basecat: 0,
      products_called: 0,
      products_skipped,
    });
    return;
  }

  // ── Process products ──────────────────────────────────────────────────────
  const { allUpdates, allPreviews, totalStats, quotaExhausted } =
    await processProductsWithConcurrency(
      pidsForRun,
      groups,
      headers,
      idColIdx,
      colorColIdx,
      baseCatColIdx,
      catColIdx,
      keywordsColIdx,
      client,
      checkpoint,
      checkpointPath,
      TAB,
    );

  totalStats.products_skipped = products_skipped;

  if (quotaExhausted) {
    console.error(
      '\n[gen-categories-keywords] QUOTA EXHAUSTED — OpenAI usage cap / quota reached.\n' +
      `Checkpoint saved to ${checkpointPath}.\n` +
      'Re-run after the cap clears to continue from where processing stopped.',
    );
  }

  // ── Emit preview TSV ───────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDir = path.resolve('tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const previewPath = path.join(tmpDir, `gen-cat-kw-preview-${ts}.tsv`);
  writePreviewTsv(previewPath, allPreviews);
  console.log(`\n[output] Preview TSV: ${previewPath}`);

  // ── Print stats (Pitfall 13 summary) ─────────────────────────────────────
  printStats(totalStats);

  // ── Dry-run: stop here ────────────────────────────────────────────────────
  if (dryRun) {
    console.log('\n[DRY RUN] No writes to sheet. Pass --apply to execute.');
    return;
  }

  // ── Apply: backup, then write ─────────────────────────────────────────────
  if (allUpdates.length === 0) {
    console.log('\n[apply] No changes to write — already current.');
    return;
  }

  // D-14: backup the 3 affected columns BEFORE any write.
  const backupPath = path.join(tmpDir, `gen-cat-kw-backup-${ts}.tsv`);
  writeBackupTsv(backupPath, headers, dataRows, idColIdx, colorColIdx, baseCatColIdx, catColIdx, keywordsColIdx);
  console.log(`\n[backup] Written: ${backupPath}`);

  console.log(`\n[apply] Writing ${allUpdates.length} update(s)...`);
  const written = await writeUpdates(sheets, MAIN_ID, allUpdates);
  console.log(`[apply] Done — ${written} cell(s) written.`);
}

function printStats(stats: {
  written_new: number;
  overwritten_changed: number;
  skipped_already_current: number;
  flagged_unsafe_basecat: number;
  products_called: number;
  products_skipped: number;
}): void {
  console.log('\n=== Run Stats ===');
  console.log(`  written_new               : ${stats.written_new}`);
  console.log(`  overwritten_changed       : ${stats.overwritten_changed}`);
  console.log(`  skipped_already_current   : ${stats.skipped_already_current}`);
  console.log(`  flagged_unsafe_basecat    : ${stats.flagged_unsafe_basecat}`);
  console.log(`  products_called           : ${stats.products_called}`);
  console.log(`  products_skipped          : ${stats.products_skipped}`);
}

// Only run main() when this script is the entry point — not when imported by tests.
// Resolve both sides to real filesystem paths so spaces in the path (e.g.
// "Claude code project") don't break the comparison (file:// URLs %20-encode them).
const isEntryPoint = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;

if (isEntryPoint) {
  main().catch(err => {
    console.error('[gen-categories-keywords] Fatal:', err.message ?? err);
    process.exit(1);
  });
}
