/**
 * Push products from the `Bestsellers-Ready` tab into the DEST testing store.
 *
 * Workflow per product:
 *   1. Skip if it's still flagged in Missing-Info (we don't push incomplete products).
 *   2. Skip if a product with that handle already exists on the dest store
 *      (handled internally by pushCloneableProduct).
 *   3. For each unique color, build 4 images: front, back, left side, right side.
 *      The "side" pair is built from the single DirectSideImage we have:
 *        - Vision detects whether it's a left or right view (gpt-4o-mini)
 *        - Original is labeled accordingly
 *        - Flipped horizontally → labeled the opposite side
 *        - Both uploaded to Drive (flipped only — original stays in place)
 *      Each image gets alt text "{color} {view}", e.g. "Vintage Black left side".
 *   4. Build a CloneableProduct (Color × Size options, no print-area option) and
 *      hand off to pushCloneableProduct.
 *
 * Print area / decoration setup is intentionally NOT automated — the user does
 * that manually in Shopify admin after each product lands.
 *
 * Flags:
 *   --dry-run         no Drive writes, no Shopify writes
 *   --limit N         push at most N products (smoke testing)
 *   --handles a,b,c   restrict to these productIds
 *   --status DRAFT    push as draft (default ACTIVE)
 *   --skip-side-pair  skip Vision/flip step (use only original side image)
 *
 * Recommended first run:
 *   npx tsx -r dotenv/config scripts/push-bestsellers-to-store.ts --limit 1
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { pushCloneableProduct, fetchMetafieldDefs } from '../src/shopify/clone-pusher.js';
import { buildSidePair } from '../src/lib/side-pair-builder.js';
import { logger } from '../src/lib/logger.js';
import type { CloneableProduct, ExportImage } from '../src/shopify/clone-types.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const MISSING_TAB = 'Missing-Info';

interface Args {
  limit: number;
  handles: string[] | null;
  dryRun: boolean;
  status: 'ACTIVE' | 'DRAFT';
  skipSidePair: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: Infinity, handles: null, dryRun: false, status: 'ACTIVE', skipSidePair: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--handles') a.handles = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--status') a.status = (argv[++i] || 'ACTIVE').toUpperCase() as 'ACTIVE' | 'DRAFT';
    else if (x === '--skip-side-pair') a.skipSidePair = true;
  }
  return a;
}

function safeColor(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, '_');
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function deriveHandle(productId: string, productName: string): string {
  const slug = slugify(productName || productId);
  // Always include the productId for uniqueness (and so manual lookup is easy)
  if (slug && !slug.includes(productId.toLowerCase())) return `${slug}-${productId.toLowerCase()}`;
  return slug || productId.toLowerCase();
}

function parseTags(keywords: string): string[] {
  return keywords.split(/[,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 250);
}

// Map text from BR fields to a Shopify Taxonomy Category GID. Order matters —
// more specific keywords come first. The color-pattern metafield is restricted
// to certain categories; assigning a sensible GID prevents the "Owner subtype
// does not match the metafield definition's constraints" error.
const CATEGORY_GIDS = {
  hoodie:    'gid://shopify/TaxonomyCategory/aa-1-13-13',
  tank:      'gid://shopify/TaxonomyCategory/aa-1-13-9',
  shirt:     'gid://shopify/TaxonomyCategory/aa-1-13-7',
  tshirt:    'gid://shopify/TaxonomyCategory/aa-1-13-8',
  headwear:  'gid://shopify/TaxonomyCategory/aa-2-18',
  jacket:    'gid://shopify/TaxonomyCategory/aa-1-10-2',
  vest:      'gid://shopify/TaxonomyCategory/aa-1-10-6',
  uniforms:  'gid://shopify/TaxonomyCategory/aa-1-24',
  apron:     'gid://shopify/TaxonomyCategory/hg-11-8-1',
};

function deriveCategoryGid(blob: string): string {
  const s = blob.toLowerCase();
  if (/\b(beanie|toque|cap|hat|snapback|trucker|visor|headwear|headband|bandana|balaclava)\b/.test(s)) return CATEGORY_GIDS.headwear;
  if (/\bapron\b/.test(s)) return CATEGORY_GIDS.apron;
  if (/\b(hoodie|hooded|sweatshirt|crewneck|fleece|pullover|quarter[\s-]?zip|full[\s-]?zip)\b/.test(s)) return CATEGORY_GIDS.hoodie;
  if (/\b(jacket|coat|parka|softshell|windbreaker|outerwear)\b/.test(s)) return CATEGORY_GIDS.jacket;
  if (/\bvest\b/.test(s)) return CATEGORY_GIDS.vest;
  if (/\btank\s*top\b/.test(s)) return CATEGORY_GIDS.tank;
  if (/\b(safety|hi[\s-]?vis|workwear|uniform)\b/.test(s)) return CATEGORY_GIDS.uniforms;
  if (/\b(polo|woven|button[\s-]?up|button[\s-]?down|dress shirt)\b/.test(s)) return CATEGORY_GIDS.shirt;
  // Default for any tee, long sleeve, generic top, or unrecognized apparel
  return CATEGORY_GIDS.tshirt;
}

async function buildProduct(
  pid: string,
  variantRows: string[][],
  bh: Record<string, number>,
  status: 'ACTIVE' | 'DRAFT',
  skipSidePair: boolean,
): Promise<CloneableProduct | null> {
  const first = variantRows[0];
  const productName = String(first[bh['productName']] ?? '').trim();
  const cleanTitle = String(first[bh['cleanTitle']] ?? '').trim();
  if (!cleanTitle) {
    logger.warn(`[${pid}] cleanTitle missing in BR — skipping. Run scripts/generate-titles.ts to populate.`);
    return null;
  }
  const supplierCode = String(first[bh['supplierCode']] ?? '').trim() || 'UNKNOWN';
  const styleId = String(first[bh['styleID']] ?? '').trim() || pid;
  const description = String(first[bh['description']] ?? '').trim();
  const brandName = String(first[bh['brandName']] ?? '').trim() || supplierCode;
  const baseCategory = String(first[bh['baseCategory']] ?? '').trim();
  const categories = String(first[bh['categories']] ?? '').trim();
  const productType = baseCategory || categories || '';
  const keywords = String(first[bh['keywords']] ?? '').trim();

  const handle = deriveHandle(pid, productName);

  // Build per-color image set + per (color, size) variant rows
  interface ColorBundle { front: string; back: string; side: string; sampleVariantRow: string[] }
  const byColor = new Map<string, ColorBundle>();
  // Variants: dedupe by (color, size)
  const variantBucket = new Map<string, string[]>();

  for (const row of variantRows) {
    const color = String(row[bh['colorName']] ?? '').trim();
    const size = String(row[bh['sizeName']] ?? '').trim();
    if (!color) continue;
    const front = String(row[bh['FrontImage']] ?? '').trim();
    const back = String(row[bh['BackImage']] ?? '').trim();
    const side = String(row[bh['DirectSideImage']] ?? '').trim();
    if (!byColor.has(color) && front && back && side) {
      byColor.set(color, { front, back, side, sampleVariantRow: row });
    }
    if (size) {
      const k = `${color}|${size}`;
      if (!variantBucket.has(k)) variantBucket.set(k, row);
    }
  }

  if (byColor.size === 0) {
    logger.warn(`[${pid}] no color has all 3 images — skipping`);
    return null;
  }

  // Build images
  const images: ExportImage[] = [];
  let position = 1;
  // Map color → list of image src URLs in order, for variant↔image linkage
  const variantImageByColor = new Map<string, string>();

  for (const [color, b] of byColor) {
    const sc = safeColor(color);
    let leftUrl = b.side, rightUrl = b.side;
    if (!skipSidePair) {
      const pair = await buildSidePair(b.side, supplierCode, styleId, sc);
      if (pair) {
        leftUrl = pair.leftSideUrl;
        rightUrl = pair.rightSideUrl;
      }
    }
    images.push({ src: b.front, alt: `${color} front`, position: String(position++) });
    images.push({ src: b.back, alt: `${color} back`, position: String(position++) });
    images.push({ src: leftUrl, alt: `${color} left side`, position: String(position++) });
    images.push({ src: rightUrl, alt: `${color} right side`, position: String(position++) });
    variantImageByColor.set(color, b.front);
  }

  // Build variants
  const variants: CloneableProduct['variants'] = [];
  for (const [, row] of variantBucket) {
    const color = String(row[bh['colorName']] ?? '').trim();
    const size = String(row[bh['sizeName']] ?? '').trim();
    if (!byColor.has(color)) continue; // color was filtered (incomplete imagery)
    // SKU format mirrors scripts/generate-skus.ts: {supplier}-{pid}-{color}-{size}.
    // partNumber is supplier's *product*-level code (same across variants), so it
    // can't be a per-variant SKU. PartID is per-variant but only 99.6% populated;
    // the deterministic recipe is unique by construction and survives empty fields.
    const sku = `${supplierCode}-${pid}-${color}-${size}`.replace(/\s+/g, ' ').trim();
    const cost = String(row[bh['costPrice']] ?? '').trim();
    const sell = String(row[bh['sellPrice1Area']] ?? '').trim();
    // sellPrice1Area is the source of truth for variant.price. NEVER fall back
    // to cost — that silently published supplier cost as the public selling
    // price (margin-breaking). If sellPrice is missing, skip the variant; if
    // every variant lacks one, the product is skipped at line ~225.
    const sellNum = parseFloat(sell);
    if (!sell || !Number.isFinite(sellNum) || sellNum <= 0) {
      logger.warn(
        `[${pid}] skipping variant ${color}/${size}: sellPrice1Area missing/invalid (sell="${sell}", cost="${cost}"). Populate BR before pushing.`,
      );
      continue;
    }
    const price = sell;
    const rawWeight = String(row[bh['unitWeight']] ?? '').trim();
    const weightLbs = parseFloat(rawWeight);
    const weightGrams = Number.isFinite(weightLbs) ? Math.round(weightLbs * 453.592) : 0;
    variants.push({
      optionValues: [color, size],
      sku,
      price,
      compareAtPrice: '',
      barcode: '',
      taxable: true,
      requiresShipping: true,
      inventoryPolicy: 'DENY',
      weightGrams,
      costPerItem: cost,
      variantImageUrl: variantImageByColor.get(color) ?? '',
    });
  }

  if (variants.length === 0) {
    logger.warn(`[${pid}] no usable variants — skipping`);
    return null;
  }

  const categoryBlob = `${productName} ${productType} ${baseCategory} ${categories} ${keywords}`;
  const categoryGid = deriveCategoryGid(categoryBlob);

  return {
    handle,
    title: cleanTitle,
    bodyHtml: description,
    vendor: brandName,
    productCategory: categoryGid,
    productType,
    tags: parseTags(keywords),
    status,
    templateSuffix: '',
    seoTitle: '',
    seoDescription: '',
    giftCard: false,
    optionNames: ['Color', 'Size'],
    colorLinked: true,
    variants,
    images,
    metafields: new Map(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`push-bestsellers starting: ${JSON.stringify({ ...args, handles: args.handles?.length })}`);

  const sheets = createSheetsClient();
  logger.info('Reading Bestsellers-Ready and Missing-Info...');
  const [brResp, miResp] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` }),
    sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${MISSING_TAB}'` }),
  ]);
  const brRows = (brResp.data.values ?? []) as string[][];
  const miRows = (miResp.data.values ?? []) as string[][];
  const bh: Record<string, number> = {}; (brRows[0] as string[]).forEach((x, i) => { bh[x] = i; });
  const mh: Record<string, number> = {}; (miRows[0] as string[]).forEach((x, i) => { mh[x] = i; });

  const skipPids = new Set<string>();
  for (let i = 1; i < miRows.length; i++) {
    const pid = String(miRows[i][mh['productId']] ?? '').trim();
    const summary = String(miRows[i][mh['missingFields']] ?? '').trim();
    if (pid && summary) skipPids.add(pid);
  }
  logger.info(`Missing-Info skip set: ${skipPids.size} products`);

  // Group BR rows by productId in stable order
  const order: string[] = [];
  const byPid = new Map<string, string[][]>();
  for (let i = 1; i < brRows.length; i++) {
    const pid = String(brRows[i][bh['productId']] ?? '').trim();
    if (!pid) continue;
    if (!byPid.has(pid)) { byPid.set(pid, []); order.push(pid); }
    byPid.get(pid)!.push(brRows[i]);
  }
  logger.info(`Bestsellers-Ready: ${order.length} unique products`);

  // Filter
  let candidates = order.filter(pid => !skipPids.has(pid));
  if (args.handles) candidates = candidates.filter(pid => args.handles!.includes(pid));
  candidates = candidates.slice(0, args.limit);
  logger.info(`Pushing ${candidates.length} products`);

  if (args.dryRun) {
    for (const pid of candidates) {
      logger.info(`[DRY] would push ${pid} with ${byPid.get(pid)!.length} variant rows`);
    }
    return;
  }

  const destClient = await createShopifyClient('DEST_SHOPIFY_');
  const metafieldDefs = await fetchMetafieldDefs(destClient);

  let pushed = 0, skippedExists = 0, errors = 0, skippedBuild = 0;
  for (const pid of candidates) {
    try {
      const product = await buildProduct(pid, byPid.get(pid)!, bh, args.status, args.skipSidePair);
      if (!product) { skippedBuild++; continue; }
      logger.info(`[${pid}] built (${product.variants.length} variants, ${product.images.length} images, handle=${product.handle})`);
      const result = await pushCloneableProduct(destClient, product, {
        skipExisting: true,
        metafieldDefs,
        categoryGid: product.productCategory || null,
        templateSuffix: null,
      });
      if (result.status === 'created') { pushed++; logger.info(`[${pid}] PUSHED → ${result.productGid}`); }
      else if (result.status === 'skipped-exists') { skippedExists++; logger.info(`[${pid}] already on dest — skipped`); }
      else if (result.status === 'error') { errors++; logger.error(`[${pid}] ERROR: ${result.error}`); }
    } catch (e) {
      errors++;
      logger.error(`[${pid}] uncaught: ${e instanceof Error ? e.message : e}`);
    }
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Pushed:           ${pushed}`);
  logger.info(`Skipped (exists): ${skippedExists}`);
  logger.info(`Skipped (build):  ${skippedBuild}`);
  logger.info(`Errors:           ${errors}`);
}

await main();
