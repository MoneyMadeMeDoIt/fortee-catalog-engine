/**
 * Remap a youth product's variant images by sourcing from its adult counterpart.
 *
 * Use case: CSW scraped some youth products (S5610Y, S5615Y) with shuffled
 * (color → image) mappings, so most variants show the wrong garment color.
 * The adult version (S05610, S05615) was scraped cleanly and color-image
 * verification confirms every variant is correct. This script takes the
 * adult's image URLs and writes them into the youth's BR rows, matched by
 * exact color name (with one allowed fuzzy alias passed via --alias).
 *
 * Then it pushes corrected media to the store: deletes the existing
 * "<color> front", "<color> back", "<color> left side", "<color> right side"
 * media on the youth product and re-attaches fresh ones from the adult URLs.
 *
 *   Stage 1 (sheet): write FrontImage, BackImage, DirectSideImage,
 *                    ModelFrontImage cells in BR for every matched variant row.
 *   Stage 2 (store): delete + re-attach front/back media. Side pair is
 *                    rebuilt via buildSidePair on the adult DirectSideImage.
 *
 * Flags:
 *   --youth <pid> --adult <pid>   required pair to remap
 *   --alias "Kelly:Kelly Green"   colon-separated youth-color → adult-color rename
 *   --dry-run                     no sheet writes, no store writes, no Drive uploads
 *   --skip-store                  only update BR; don't touch store
 *   --skip-sheet                  only push from existing BR (skip BR write)
 *
 * Recommended:
 *   npx tsx -r dotenv/config scripts/remap-youth-from-adult.ts --youth S5610Y --adult S05610 --alias "Kelly:Kelly Green" --dry-run
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { buildSidePair } from '../src/lib/side-pair-builder.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';

const IMAGE_COLS = ['FrontImage', 'BackImage', 'DirectSideImage', 'ModelFrontImage'] as const;
type ImageCol = typeof IMAGE_COLS[number];

interface Args {
  youth: string;
  adult: string;
  aliases: Map<string, string>; // youth-color (lower) → adult-color
  dryRun: boolean;
  skipStore: boolean;
  skipSheet: boolean;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { youth: '', adult: '', aliases: new Map(), dryRun: false, skipStore: false, skipSheet: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--youth') a.youth = argv[++i];
    else if (x === '--adult') a.adult = argv[++i];
    else if (x === '--alias') {
      const [from, to] = argv[++i].split(':').map(s => s.trim());
      if (from && to) a.aliases.set(from.toLowerCase(), to);
    }
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--skip-store') a.skipStore = true;
    else if (x === '--skip-sheet') a.skipSheet = true;
  }
  if (!a.youth || !a.adult) { throw new Error('Missing --youth or --adult'); }
  return a;
}

function colLetter(idx: number): string {
  let r = '', n = idx;
  while (n >= 0) { r = String.fromCharCode((n % 26) + 65) + r; n = Math.floor(n / 26) - 1; }
  return r;
}

function safeColor(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, '_');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`remap-youth-from-adult: ${JSON.stringify({ youth: args.youth, adult: args.adult, aliases: [...args.aliases], dryRun: args.dryRun, skipStore: args.skipStore, skipSheet: args.skipSheet })}`);

  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });

  // Build adult lookup: color (lower) → { Front, Back, Side, Model } first non-empty value
  // Also capture the youth's supplierCode so buildSidePair uploads land in the
  // right Drive folder (root/<supplier>/<styleId>/).
  const adultByColor = new Map<string, Partial<Record<ImageCol, string>>>();
  let youthSupplier = '';
  for (let i = 1; i < rows.length; i++) {
    const rowPid = String(rows[i][h['productId']] ?? '').trim();
    if (rowPid === args.youth && !youthSupplier) {
      youthSupplier = String(rows[i][h['supplierCode']] ?? '').trim();
    }
    if (rowPid !== args.adult) continue;
    const color = String(rows[i][h['colorName']] ?? '').trim();
    if (!color) continue;
    const k = color.toLowerCase();
    const cur = adultByColor.get(k) ?? {};
    for (const col of IMAGE_COLS) {
      const v = String(rows[i][h[col]] ?? '').trim();
      if (v && !cur[col]) cur[col] = v;
    }
    adultByColor.set(k, cur);
  }
  if (!youthSupplier) throw new Error(`Could not find supplierCode for youth pid ${args.youth} in BR`);
  logger.info(`Youth supplier: ${youthSupplier}`);
  logger.info(`Adult ${args.adult}: ${adultByColor.size} colors with images`);

  // Find youth rows and plan updates
  interface PlannedRow { rowIdx: number; youthColor: string; adultColor: string; updates: { col: ImageCol; oldVal: string; newVal: string }[] }
  const plans: PlannedRow[] = [];
  const skippedColors = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][h['productId']] ?? '').trim() !== args.youth) continue;
    const youthColor = String(rows[i][h['colorName']] ?? '').trim();
    if (!youthColor) continue;
    const aliased = args.aliases.get(youthColor.toLowerCase()) ?? youthColor;
    const adult = adultByColor.get(aliased.toLowerCase());
    if (!adult) { skippedColors.add(youthColor); continue; }
    const updates: PlannedRow['updates'] = [];
    for (const col of IMAGE_COLS) {
      const newVal = adult[col];
      if (!newVal) continue;
      const oldVal = String(rows[i][h[col]] ?? '').trim();
      if (oldVal === newVal) continue;
      updates.push({ col, oldVal, newVal });
    }
    if (updates.length > 0) plans.push({ rowIdx: i, youthColor, adultColor: aliased, updates });
  }
  logger.info(`Planned: ${plans.length} youth rows have updates`);
  if (skippedColors.size > 0) logger.info(`Skipped colors (no adult match): ${[...skippedColors].join(', ')}`);

  // Stage 1: BR sheet update
  if (!args.skipSheet) {
    const sheetUpdates: { range: string; values: string[][] }[] = [];
    for (const p of plans) {
      for (const u of p.updates) {
        sheetUpdates.push({
          range: `'${READY_TAB}'!${colLetter(h[u.col])}${p.rowIdx + 1}`,
          values: [[u.newVal]],
        });
      }
    }
    logger.info(`Sheet updates: ${sheetUpdates.length} cell writes`);
    if (args.dryRun) {
      // Show first 6 as a preview
      for (const u of sheetUpdates.slice(0, 6)) logger.info(`  DRY ${u.range} = ${u.values[0][0].slice(0, 60)}`);
      if (sheetUpdates.length > 6) logger.info(`  …and ${sheetUpdates.length - 6} more`);
    } else if (sheetUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MAIN_ID,
        requestBody: { valueInputOption: 'RAW', data: sheetUpdates },
      });
      logger.info('Sheet updates applied.');
    }
  }

  // Stage 2: Store update (front + back + side pair)
  if (args.skipStore) {
    logger.info('--skip-store set, exiting after sheet stage.');
    return;
  }

  // Per-color URLs to push (adult sources)
  interface ColorPlan { color: string; front: string; back: string; side: string }
  const byColor = new Map<string, ColorPlan>();
  for (const p of plans) {
    const adult = adultByColor.get(p.adultColor.toLowerCase())!;
    if (!adult.FrontImage) continue;
    if (byColor.has(p.youthColor.toLowerCase())) continue;
    byColor.set(p.youthColor.toLowerCase(), {
      color: p.youthColor,
      front: adult.FrontImage,
      back: adult.BackImage ?? '',
      side: adult.DirectSideImage ?? '',
    });
  }
  logger.info(`Store push: ${byColor.size} colors planned`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  const STORE_PRODUCT = `
    query($q: String!) {
      products(first: 5, query: $q) {
        edges { node { id handle media(first: 250) { edges { node { ... on MediaImage { id alt image { url } } } } } } }
      }
    }
  `;
  const PRODUCT_DELETE_MEDIA = `
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }
  `;
  const PRODUCT_CREATE_MEDIA = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id alt }
        mediaUserErrors { field message }
      }
    }
  `;

  const handleSearch = `tag:'' OR product_type:''`; // placeholder — switch to handle suffix
  // Actually find product by handle suffix
  const findRes = (await client.request(STORE_PRODUCT, { variables: { q: `${args.youth.toLowerCase()}` } })) as {
    data: { products: { edges: { node: { id: string; handle: string; media: { edges: { node: { id?: string; alt?: string; image?: { url: string } } }[] } } }[] } };
  };
  const matches = findRes.data.products.edges
    .map(e => e.node)
    .filter(n => n.handle.endsWith(`-${args.youth.toLowerCase()}`) || n.handle === args.youth.toLowerCase());
  if (matches.length === 0) { logger.error(`Could not find ${args.youth} product on store.`); return; }
  const product = matches[0];
  const media = product.media.edges
    .map(e => e.node)
    .filter(n => n && n.id && n.image)
    .map(n => ({ id: n.id!, alt: (n.alt ?? '').trim().toLowerCase(), url: n.image!.url }));
  logger.info(`Found store product ${product.handle} with ${media.length} media`);

  // For each color, find existing front/back/side media to delete, then attach new
  const altSet = (color: string) => ({
    front: `${color} front`.toLowerCase(),
    back: `${color} back`.toLowerCase(),
    leftSide: `${color} left side`.toLowerCase(),
    rightSide: `${color} right side`.toLowerCase(),
  });

  let mediaDeleted = 0, mediaAttached = 0, errs = 0;
  for (const cp of byColor.values()) {
    const labels = altSet(cp.color);
    const existingByAlt = new Map<string, string>();
    for (const m of media) existingByAlt.set(m.alt, m.id);
    const toDelete: string[] = [];
    for (const a of [labels.front, labels.back, labels.leftSide, labels.rightSide]) {
      const id = existingByAlt.get(a);
      if (id) toDelete.push(id);
    }
    // Build side pair for the new side image
    let leftUrl = cp.side, rightUrl = cp.side;
    if (cp.side) {
      const pair = await buildSidePair(cp.side, youthSupplier, args.youth, safeColor(cp.color));
      if (pair) { leftUrl = pair.leftSideUrl; rightUrl = pair.rightSideUrl; }
    }
    const toAttach: { url: string; alt: string }[] = [];
    if (cp.front) toAttach.push({ url: cp.front, alt: `${cp.color} front` });
    if (cp.back) toAttach.push({ url: cp.back, alt: `${cp.color} back` });
    if (cp.side) {
      toAttach.push({ url: leftUrl, alt: `${cp.color} left side` });
      toAttach.push({ url: rightUrl, alt: `${cp.color} right side` });
    }

    if (args.dryRun) {
      logger.info(`  [${product.handle}/${cp.color}] DRY would delete ${toDelete.length} media + attach ${toAttach.length} new`);
      continue;
    }

    if (toDelete.length > 0) {
      const r1 = (await client.request(PRODUCT_DELETE_MEDIA, { variables: { productId: product.id, mediaIds: toDelete } })) as { data: { productDeleteMedia: { mediaUserErrors: { field: string[]; message: string }[] } } };
      const e = r1.data.productDeleteMedia.mediaUserErrors;
      if (e.length > 0) { errs++; logger.error(`  [${cp.color}] delete error: ${e.map(x => x.message).join(',')}`); continue; }
      mediaDeleted += toDelete.length;
    }
    for (const t of toAttach) {
      const r2 = (await client.request(PRODUCT_CREATE_MEDIA, { variables: { productId: product.id, media: [{ originalSource: t.url, alt: t.alt, mediaContentType: 'IMAGE' }] } })) as { data: { productCreateMedia: { mediaUserErrors: { field: string[]; message: string }[] } } };
      const e = r2.data.productCreateMedia.mediaUserErrors;
      if (e.length > 0) { errs++; logger.error(`  [${cp.color}] attach "${t.alt}" error: ${e.map(x => x.message).join(',')}`); continue; }
      mediaAttached++;
    }
    logger.info(`  [${product.handle}/${cp.color}] FIXED: deleted ${toDelete.length}, attached ${toAttach.length}`);
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Plans:           ${plans.length} variant rows`);
  logger.info(`Colors pushed:   ${byColor.size}`);
  logger.info(`Media deleted:   ${args.dryRun ? '(dry)' : mediaDeleted}`);
  logger.info(`Media attached:  ${args.dryRun ? '(dry)' : mediaAttached}`);
  logger.info(`Errors:          ${errs}`);
}

await main();
