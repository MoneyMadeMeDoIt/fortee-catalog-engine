/**
 * Orchestrator (S3): fill gaps in the Missing-Info tab using CSW scraping + AI image generation.
 *
 * Per-product pipeline:
 *   1. CSW scrape (Description, Category, SizeChart) → write to all variant rows in Bestsellers-Ready
 *   2. Per-variant AI image gen (Back, Side, Model) from FrontImage URL → write to row
 *   3. Recount per-product gaps → rewrite Missing-Info markers
 *
 * Cost prices and original Drive image hosting are out of scope (deferred per plan).
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/fill-missing-info.ts [flags]
 *     --dry-run          plan only; no AI calls, no sheet writes
 *     --style-id <code>  process one product
 *     --limit <n>        process at most N products with gaps
 *     --only csw|images  restrict pipeline to one half
 *     --no-model         skip on-model image generation
 *     --budget <usd>     AI budget cap (default 50)
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient } from '../src/sheets/drive.js';
import { CostTracker } from '../src/lib/cost-tracker.js';
import { generateGarmentView } from '../src/lib/ai-image-generator.js';
import { generateModelImage, type ModelGender } from '../src/lib/ai-model-image.js';
import { getCategoryGroup } from '../src/shopify/variants.js';
import { scrapeCSW, type CSWScrapeResult } from './scrape-csw-product.js';
import type { CategoryGroup } from '../src/shopify/types.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const MISSING_TAB = 'Missing-Info';
const READY_TAB = 'Bestsellers-Ready';

const CAP_BAG_WORDS = ['cap', 'hat', 'beanie', 'toque', 'visor', 'snapback', 'trucker', 'dad hat', 'headwear', 'headband', 'bandana', 'balaclava', 'bucket hat', 'ear warmer', 'bag', 'tote', 'backpack', 'duffle', 'cooler', 'apron', 'pouch'];
function isCapOrBag(...blobs: string[]): boolean {
  const hay = blobs.join(' ').toLowerCase();
  return CAP_BAG_WORDS.some(w => hay.includes(w));
}

interface Flags {
  dryRun: boolean;
  styleId: string | null;
  limit: number | null;
  only: 'csw' | 'images' | null;
  noModel: boolean;
  budget: number;
}

function parseFlags(): Flags {
  const a = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] ?? null : null;
  };
  const only = get('--only');
  if (only && only !== 'csw' && only !== 'images') {
    console.error(`--only must be csw or images, got "${only}"`);
    process.exit(1);
  }
  return {
    dryRun: a.includes('--dry-run'),
    styleId: get('--style-id'),
    limit: get('--limit') ? Number(get('--limit')) : null,
    only: (only as 'csw' | 'images' | null) ?? null,
    noModel: a.includes('--no-model'),
    budget: get('--budget') ? Number(get('--budget')) : 50,
  };
}

function colLetter(idx: number): string {
  let r = '', n = idx;
  while (n >= 0) { r = String.fromCharCode((n % 26) + 65) + r; n = Math.floor(n / 26) - 1; }
  return r;
}

function indexHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => { map[h] = i; });
  return map;
}

interface MissingInfoRow {
  rowIdx: number; // 1-based sheet row
  productId: string;
  productName: string;
  needsDescription: boolean;
  needsCategory: boolean;
  needsSizeChart: boolean;
  missingFront: number;
  missingBack: number;
  missingSide: number;
  missingModel: number;
}

function parseMissingCount(cell: string): number {
  const m = String(cell ?? '').match(/MISSING\s*\((\d+)\)/i);
  return m ? Number(m[1]) : (String(cell ?? '').toUpperCase().includes('MISSING') ? 1 : 0);
}

interface UpdateOp { range: string; values: string[][] }

async function batchWrite(sheets: any, ops: UpdateOp[]): Promise<void> {
  if (ops.length === 0) return;
  // Sheets API supports batch updates of up to ~10MB / 100k cells; chunk at 500 ops.
  const CHUNK = 500;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const slice = ops.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: MAIN_ID,
      requestBody: { valueInputOption: 'RAW', data: slice },
    });
  }
}

function extractDriveFileId(url: string): string | null {
  // Handles: /uc?id=ID, /uc?export=view&id=ID, /file/d/ID/view, /open?id=ID
  const m = url.match(/[?&]id=([^&]+)/) || url.match(/\/d\/([^/]+)/);
  return m ? m[1] : null;
}

async function downloadImage(url: string, drive?: any): Promise<Buffer | null> {
  const driveFileId = extractDriveFileId(url);
  if (driveFileId && drive) {
    try {
      const res = await drive.files.get(
        { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return Buffer.from(res.data);
    } catch (e: any) {
      console.log(`    [drive api] ${driveFileId}: ${e.message}`);
      return null;
    }
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'fortee-catalog-engine/1.0' } });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(`Flags: ${JSON.stringify(flags)}`);

  const sheets = createSheetsClient();
  const drive = flags.dryRun ? null : createDriveClient();

  // --- Read both tabs ---
  console.log('Reading Missing-Info...');
  const miResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${MISSING_TAB}'` });
  const miRows = miResp.data.values ?? [];
  const miH = indexHeaders(miRows[0]);

  console.log('Reading Bestsellers-Ready...');
  const brResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const brRows = brResp.data.values ?? [];
  const brH = indexHeaders(brRows[0]);

  // --- Parse Missing-Info into structured records ---
  const missing: MissingInfoRow[] = [];
  for (let i = 1; i < miRows.length; i++) {
    const r = miRows[i];
    const productId = String(r[miH['productId']] ?? '').trim();
    if (!productId) continue;
    missing.push({
      rowIdx: i + 1,
      productId,
      productName: String(r[miH['productName']] ?? '').trim(),
      needsDescription: String(r[miH['Description']] ?? '').toUpperCase().includes('MISSING'),
      needsCategory: String(r[miH['Category']] ?? '').toUpperCase().includes('MISSING'),
      needsSizeChart: String(r[miH['SizeChart']] ?? '').toUpperCase().includes('MISSING'),
      missingFront: parseMissingCount(r[miH['FrontImage']]),
      missingBack: parseMissingCount(r[miH['BackImage']]),
      missingSide: parseMissingCount(r[miH['SideImage']]),
      missingModel: parseMissingCount(r[miH['ModelImage']]),
    });
  }
  console.log(`Missing-Info: ${missing.length} products with gaps`);

  // --- Bestsellers-Ready row index by productId ---
  const brByPid = new Map<string, number[]>();
  const brPidIdx = brH['productId'];
  for (let i = 1; i < brRows.length; i++) {
    const pid = String(brRows[i][brPidIdx] ?? '').trim();
    if (!pid) continue;
    let arr = brByPid.get(pid);
    if (!arr) { arr = []; brByPid.set(pid, arr); }
    arr.push(i + 1); // 1-based row
  }

  // --- Filter scope ---
  // Stub products (no variant rows with both colorName and frontUrl) can never produce
  // an AI gen — the orchestrator silently skips them. Drop them before applying --limit
  // so `--limit 10` actually means 10 real candidates, not 10 Missing-Info rows.
  const colorCol = brH['colorName'];
  const frontCol = brH['FrontImage'];
  const backCol = brH['BackImage'];
  const sideCol = brH['DirectSideImage'];
  const modelCol = brH['ModelFrontImage'];
  const hasGenWorkRemaining = (pid: string): boolean => {
    const rows = brByPid.get(pid) ?? [];
    let anyModel = false;
    for (const rn of rows) {
      const row = brRows[rn - 1];
      const color = String(row[colorCol] ?? '').trim();
      const front = String(row[frontCol] ?? '').trim();
      if (!color || !front) continue;
      const back = String(row[backCol] ?? '').trim();
      const side = String(row[sideCol] ?? '').trim();
      const model = String(row[modelCol] ?? '').trim();
      if (!back || !side) return true;
      if (model) anyModel = true;
    }
    // Model is product-level (one per product). If we found any row with model filled, done.
    return !anyModel;
  };
  let scope = missing;
  if (flags.styleId) scope = scope.filter(m => m.productId === flags.styleId);
  else if (flags.only !== 'csw') scope = scope.filter(m => hasGenWorkRemaining(m.productId));
  if (flags.limit) scope = scope.slice(0, flags.limit);
  console.log(`Processing ${scope.length} products`);

  const tracker = new CostTracker(flags.budget);
  const updates: UpdateOp[] = [];
  const summary = { cswScraped: 0, imagesGenerated: 0, modelGenerated: 0, skipped: 0, failed: 0 };

  for (const prod of scope) {
    console.log(`\n--- ${prod.productId} (${prod.productName || 'no name'}) ---`);
    const variantRows = brByPid.get(prod.productId) ?? [];
    if (variantRows.length === 0) {
      console.log('  no variant rows in Bestsellers-Ready, skipping');
      summary.skipped++;
      continue;
    }

    // ===== Phase A: CSW scrape =====
    let csw: CSWScrapeResult | null = null;
    const needCSW = (prod.needsDescription || prod.needsCategory || prod.needsSizeChart);
    if (flags.only !== 'images' && needCSW) {
      console.log(`  scraping CSW for ${prod.productId}...`);
      try {
        csw = await scrapeCSW(prod.productId);
        if (csw.handle) {
          console.log(`    handle=${csw.handle}, type=${csw.productType}, gender=${csw.gender}`);
          summary.cswScraped++;
        } else {
          console.log('    no CSW match');
        }
      } catch (e: any) {
        console.log(`    scrape error: ${e.message}`);
      }
    }

    // Apply CSW data to ALL variant rows + Missing-Info row
    if (csw && csw.handle && !flags.dryRun) {
      for (const vr of variantRows) {
        if (prod.needsDescription && csw.description) {
          updates.push({ range: `'${READY_TAB}'!${colLetter(brH['description'])}${vr}`, values: [[csw.description]] });
        }
        if (prod.needsCategory && csw.productType) {
          updates.push({ range: `'${READY_TAB}'!${colLetter(brH['categories'])}${vr}`, values: [[csw.productType]] });
        }
        if (prod.needsSizeChart && csw.sizeChartUrl && brH['Size Chart'] !== undefined) {
          updates.push({ range: `'${READY_TAB}'!${colLetter(brH['Size Chart'])}${vr}`, values: [[csw.sizeChartUrl]] });
        }
      }
      // Mark Missing-Info row as filled
      if (prod.needsDescription && csw.description) updates.push({ range: `'${MISSING_TAB}'!${colLetter(miH['Description'])}${prod.rowIdx}`, values: [['']] });
      if (prod.needsCategory && csw.productType) updates.push({ range: `'${MISSING_TAB}'!${colLetter(miH['Category'])}${prod.rowIdx}`, values: [['']] });
      if (prod.needsSizeChart && csw.sizeChartUrl) updates.push({ range: `'${MISSING_TAB}'!${colLetter(miH['SizeChart'])}${prod.rowIdx}`, values: [['']] });
    }

    // ===== Phase B: AI image generation =====
    if (flags.only === 'csw') continue;

    // Gather product-type hints from every source we have: CSW scrape, Missing-Info, and
    // Bestsellers-Ready fields. With --only images (no CSW) the BR fields are our only signal.
    const brSample = variantRows.length > 0 ? brRows[variantRows[0] - 1] : [];
    const brProductName = String(brSample[brH['productName']] ?? '');
    const brBaseCategory = String(brSample[brH['baseCategory']] ?? '');
    const brCategories = String(brSample[brH['categories']] ?? '');
    const brKeywords = String(brSample[brH['keywords']] ?? '');
    const skipModelForType = isCapOrBag(
      prod.productName,
      csw?.productType ?? '',
      brProductName,
      brBaseCategory,
      brCategories,
      brKeywords,
    );
    if (skipModelForType) console.log(`  skipModelForType=true (headwear/bag detected)`);

    // Infer youth from productId suffix/prefix or any available text field.
    // Handles kids-line codes like L3170Y, Y07250, and keyword hits in BR metadata.
    const brGender = String(brSample[brH['gender']] ?? '').toLowerCase();
    const textBlob = `${prod.productId} ${prod.productName} ${brProductName} ${brBaseCategory} ${brCategories} ${brKeywords} ${brGender}`.toLowerCase();
    const isYouth =
      /^y\d/i.test(prod.productId) ||
      /y$/i.test(prod.productId) ||
      /\b(youth|kid|kids|toddler|infant|boys|girls|junior)\b/.test(textBlob);
    let gender: ModelGender = csw?.gender ?? 'unisex';
    if (isYouth) gender = 'youth';
    console.log(`  gender=${gender}${isYouth ? ' (youth detected)' : ''}`);
    const categoryGroup: CategoryGroup = getCategoryGroup(csw?.productType ?? '') ?? 'tops';

    // Group variant rows by colorName — back/side/model images are color-level,
    // not size-level. Generating per row would burn money on identical outputs.
    const colorGroups = new Map<string, { frontUrl: string; needsBack: boolean; needsSide: boolean; needsModel: boolean }>();
    for (const vr of variantRows) {
      const row = brRows[vr - 1];
      const colorName = String(row[brH['colorName']] ?? '').trim();
      if (!colorName) continue;
      const frontUrl = String(row[brH['FrontImage']] ?? '').trim();
      const back = String(row[brH['BackImage']] ?? '').trim();
      const side = String(row[brH['DirectSideImage']] ?? '').trim();
      const model = String(row[brH['ModelFrontImage']] ?? '').trim();
      const existing = colorGroups.get(colorName);
      if (!existing) {
        colorGroups.set(colorName, {
          frontUrl,
          needsBack: !back,
          needsSide: !side,
          needsModel: !model,
        });
      } else {
        // Any size row with a real front URL wins as the source.
        if (!existing.frontUrl && frontUrl) existing.frontUrl = frontUrl;
        // A view counts as filled if ANY size row already has it (color-level data).
        if (back) existing.needsBack = false;
        if (side) existing.needsSide = false;
        if (model) existing.needsModel = false;
      }
    }

    // Model images are product-level, not color-level — generate on the first color
    // with a usable front and unmet need. All other colors skip model gen.
    let modelColorPicked: string | null = null;
    if (!flags.noModel && !skipModelForType) {
      for (const [colorName, plan] of colorGroups) {
        if (plan.frontUrl && plan.needsModel) { modelColorPicked = colorName; break; }
      }
    }

    for (const [colorName, plan] of colorGroups) {
      if (!plan.frontUrl) {
        console.log(`  [${colorName}] no front image — skip`);
        summary.skipped++;
        continue;
      }
      const needsBack = plan.needsBack;
      const needsSide = plan.needsSide;
      const needsModel = colorName === modelColorPicked;
      if (!needsBack && !needsSide && !needsModel) continue;

      let frontBuf: Buffer | null = null;
      if (!flags.dryRun) {
        frontBuf = await downloadImage(plan.frontUrl, drive);
        if (!frontBuf) {
          console.log(`  [${colorName}] front download failed: ${plan.frontUrl}`);
          summary.failed++;
          continue;
        }
      }

      const tasks: Array<'back' | 'side' | 'model'> = [];
      if (needsBack) tasks.push('back');
      if (needsSide) tasks.push('side');
      if (needsModel) tasks.push('model');

      for (const view of tasks) {
        if (flags.dryRun) {
          console.log(`  [${colorName}] would generate ${view}`);
          continue;
        }
        try {
          let buffer: Buffer | null = null;
          let costLine = '';
          if (view === 'model') {
            const res = await generateModelImage(frontBuf!, gender, tracker);
            if (!res) { console.log(`  [${colorName}] model gen failed (budget/policy)`); summary.failed++; continue; }
            buffer = res.buffer;
            costLine = `cost $${res.cost.toFixed(3)}`;
            summary.modelGenerated++;
          } else {
            const res = await generateGarmentView(frontBuf!, view, categoryGroup, colorName, prod.productId, tracker, undefined, prod.productName);
            if (!res) { console.log(`  [${colorName}] ${view} gen failed (budget/policy)`); summary.failed++; continue; }
            buffer = res.buffer;
            costLine = `cost $${res.totalCost.toFixed(3)}, score=${res.score}`;
            summary.imagesGenerated++;
          }
          // Persist generated buffer for the follow-up Drive-upload pass.
          // Filename encodes (productId, color, view) so the upload pass can map back to all size rows.
          const outDir = path.join('tmp', 'generated');
          mkdirSync(outDir, { recursive: true });
          const safeColor = colorName.replace(/[^a-z0-9-]+/gi, '_');
          const outPath = path.join(outDir, `${prod.productId}__${safeColor}__${view}.png`);
          writeFileSync(outPath, buffer);
          console.log(`  [${colorName}] ${view} generated → ${outPath} (${costLine})`);
        } catch (e: any) {
          console.log(`  [${colorName}] ${view} error: ${e.message}`);
          summary.failed++;
        }
      }
    }
  }

  // --- Apply sheet writes ---
  if (!flags.dryRun && updates.length > 0) {
    console.log(`\nApplying ${updates.length} sheet updates...`);
    await batchWrite(sheets, updates);
  } else if (flags.dryRun) {
    console.log(`\n[dry-run] would apply ${updates.length} sheet updates`);
  }

  // --- Summary ---
  console.log(`\n=== Summary ===`);
  console.log(`Products processed:    ${scope.length}`);
  console.log(`CSW scrapes:           ${summary.cswScraped}`);
  console.log(`Back/side generated:   ${summary.imagesGenerated}`);
  console.log(`Model generated:       ${summary.modelGenerated}`);
  console.log(`Skipped (no source):   ${summary.skipped}`);
  console.log(`Failed:                ${summary.failed}`);
  console.log(`AI cost:               $${tracker.total.toFixed(2)} / $${flags.budget}`);
  console.log(`Note: generated image buffers are NOT yet uploaded to a CDN — that's a follow-up pass.`);
}

main().catch(e => { console.error(e); process.exit(1); });
