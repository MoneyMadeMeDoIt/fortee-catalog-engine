/**
 * Replace contaminated <color> left/right side media on the dest store.
 *
 * Why: prior versions of `fetch-ss-images-fixed.ts` had a fallback chain
 *   `colorDirectSideImage || colorSideImage`
 * that wrote the on-model side URL into the direct-side slot for some S&S
 * products. Those bad URLs were uploaded as `<color> left/right side` media
 * when the products were pushed to the store. The supplier-fetch bug was
 * fixed 2026-05-01 and `clear-side-model-collisions.ts` cleared the bad cells
 * in BR; `fetch-ss-images-fixed.ts` was then rerun and refetched 515 of 705
 * (pid, color) pairs with the correct direct-side image. This script pushes
 * those corrected images to the store.
 *
 * For each (pid, color) listed in tmp/side-model-collisions.tsv:
 *   1. Look up BR.DirectSideImage for the (pid, color).
 *   2. If empty → emit to tmp/contaminated-sides-unfixable.tsv (no replacement
 *      available — needs manual sourcing).
 *   3. Otherwise:
 *      a. Find the store product via handle suffix → pid.
 *      b. Find media with alt = "<color> left side" / "<color> right side".
 *      c. buildSidePair from BR.DirectSide.
 *      d. Delete the old contaminated media.
 *      e. Upload the fresh left/right side pair.
 *
 * Flags:
 *   --dry-run         no Drive writes, no Shopify writes
 *   --limit N         process at most N (pid, color) pairs
 *   --pids a,b,c      restrict to these productIds
 *
 * Recommended first run:
 *   npx tsx -r dotenv/config scripts/fix-store-contaminated-sides.ts --dry-run --limit 1
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { buildSidePair } from '../src/lib/side-pair-builder.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const COLLISIONS_TSV = 'tmp/side-model-collisions.tsv';
const UNFIXABLE_TSV = 'tmp/contaminated-sides-unfixable.tsv';

interface Args { dryRun: boolean; limit: number; pids: string[] | null }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, limit: Infinity, pids: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--pids') a.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return a;
}

function safeColor(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, '_');
}

interface BrLookup {
  /** key: `${pid}|${colorLower}` → first non-empty DirectSide encountered */
  directByKey: Map<string, { sideUrl: string; supplier: string; styleId: string }>;
  pidByHandleSuffix: Map<string, string>;
}

function buildBrLookup(rows: string[][]): BrLookup {
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  const directByKey = new Map<string, { sideUrl: string; supplier: string; styleId: string }>();
  const pidByHandleSuffix = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pid = String(r[h['productId']] ?? '').trim();
    const color = String(r[h['colorName']] ?? '').trim();
    const side = String(r[h['DirectSideImage']] ?? '').trim();
    const supplier = String(r[h['supplierCode']] ?? '').trim();
    const styleId = String(r[h['styleID']] ?? '').trim() || pid;
    if (!pid) continue;
    pidByHandleSuffix.set(pid.toLowerCase(), pid);
    if (!color || !side) continue;
    const key = `${pid}|${color.toLowerCase()}`;
    if (!directByKey.has(key)) directByKey.set(key, { sideUrl: side, supplier, styleId });
  }
  return { directByKey, pidByHandleSuffix };
}

interface ProductOnStore {
  id: string;
  handle: string;
  media: { id: string; alt: string; url: string }[];
}

const PRODUCTS_PAGE = `
  query($after: String) {
    products(first: 25, after: $after) {
      edges {
        cursor
        node {
          id handle
          media(first: 250) {
            edges { node { ... on MediaImage { id alt image { url } } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchProductsByPid(client: ShopifyClient, br: BrLookup, neededPids: Set<string>): Promise<Map<string, ProductOnStore>> {
  type Resp = {
    data: { products: { edges: { node: {
      id: string; handle: string;
      media: { edges: { node: { id?: string; alt?: string; image?: { url: string } } }[] };
    } }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };
  };
  const out = new Map<string, ProductOnStore>();
  let after: string | null = null;
  for (let page = 0; page < 60; page++) {
    const res = (await client.request(PRODUCTS_PAGE, { variables: { after } })) as Resp;
    for (const { node } of res.data.products.edges) {
      const segments = node.handle.split('-');
      let pid: string | null = null;
      for (let i = segments.length - 1; i >= 0; i--) {
        const cand = segments[i].toLowerCase();
        if (br.pidByHandleSuffix.has(cand)) { pid = br.pidByHandleSuffix.get(cand)!; break; }
      }
      if (!pid || !neededPids.has(pid)) continue;
      const media = node.media.edges
        .map(e => e.node)
        .filter(n => n && n.id && n.image)
        .map(n => ({ id: n.id!, alt: (n.alt ?? '').trim(), url: n.image!.url }));
      out.set(pid, { id: node.id, handle: node.handle, media });
    }
    if (!res.data.products.pageInfo.hasNextPage) break;
    after = res.data.products.pageInfo.endCursor;
  }
  return out;
}

const PRODUCT_CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id alt mediaContentType }
      mediaUserErrors { field message code }
    }
  }
`;

const PRODUCT_DELETE_MEDIA = `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message code }
    }
  }
`;

async function attachMedia(client: ShopifyClient, productId: string, src: string, alt: string): Promise<string | null> {
  const res = (await client.request(PRODUCT_CREATE_MEDIA, {
    variables: {
      productId,
      media: [{ originalSource: src, alt, mediaContentType: 'IMAGE' }],
    },
  })) as { data: { productCreateMedia: { mediaUserErrors: { field: string[]; message: string }[] } } };
  const errs = res.data.productCreateMedia.mediaUserErrors;
  if (errs.length > 0) return errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ');
  return null;
}

async function deleteMedia(client: ShopifyClient, productId: string, mediaIds: string[]): Promise<string | null> {
  if (mediaIds.length === 0) return null;
  const res = (await client.request(PRODUCT_DELETE_MEDIA, {
    variables: { productId, mediaIds },
  })) as { data: { productDeleteMedia: { mediaUserErrors: { field: string[]; message: string }[] } } };
  const errs = res.data.productDeleteMedia.mediaUserErrors;
  if (errs.length > 0) return errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ');
  return null;
}

interface CollisionTarget { pid: string; color: string }

function loadCollisions(): CollisionTarget[] {
  const lines = readFileSync(COLLISIONS_TSV, 'utf-8').trim().split('\n').slice(1);
  const seen = new Set<string>();
  const out: CollisionTarget[] = [];
  for (const l of lines) {
    const [pid, color] = l.split('\t');
    if (!pid || !color) continue;
    const k = `${pid}|${color.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ pid: pid.trim(), color: color.trim() });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`fix-store-contaminated-sides starting: ${JSON.stringify({ ...args, pids: args.pids?.length })}`);

  let collisions = loadCollisions();
  logger.info(`Loaded ${collisions.length} unique (pid, color) collisions`);
  if (args.pids) collisions = collisions.filter(c => args.pids!.includes(c.pid));
  if (Number.isFinite(args.limit)) collisions = collisions.slice(0, args.limit);
  logger.info(`Processing ${collisions.length} (pid, color) pairs`);

  const sheets = createSheetsClient();
  const brResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const brRows = (brResp.data.values ?? []) as string[][];
  const br = buildBrLookup(brRows);
  logger.info(`Indexed ${br.directByKey.size} (pid,color) → DirectSide rows in BR`);

  // Split fixable vs unfixable upfront
  const fixable: CollisionTarget[] = [];
  const unfixable: CollisionTarget[] = [];
  for (const c of collisions) {
    if (br.directByKey.has(`${c.pid}|${c.color.toLowerCase()}`)) fixable.push(c);
    else unfixable.push(c);
  }
  logger.info(`Fixable (BR has DirectSide): ${fixable.length}`);
  logger.info(`Unfixable (BR DirectSide empty): ${unfixable.length}`);

  if (unfixable.length > 0 && !args.dryRun) {
    const lines = ['productId\tcolorName', ...unfixable.map(u => `${u.pid}\t${u.color}`)];
    writeFileSync(UNFIXABLE_TSV, lines.join('\n') + '\n');
    logger.info(`Wrote ${unfixable.length} unfixable pairs to ${UNFIXABLE_TSV}`);
  }

  if (fixable.length === 0) {
    logger.info('Nothing fixable. Done.');
    return;
  }

  const neededPids = new Set(fixable.map(c => c.pid));
  const client = await createShopifyClient('DEST_SHOPIFY_');
  logger.info(`Fetching store products for ${neededPids.size} pids...`);
  const productsByPid = await fetchProductsByPid(client, br, neededPids);
  logger.info(`Found ${productsByPid.size} of ${neededPids.size} pids on store`);

  let pairsFixed = 0, pairsAlreadyClean = 0, mediaDeleted = 0, mediaAttached = 0;
  let noProduct = 0, noMedia = 0, buildFailed = 0, errors = 0;

  for (const c of fixable) {
    const product = productsByPid.get(c.pid);
    if (!product) { noProduct++; logger.info(`[${c.pid}/${c.color}] product not on store`); continue; }

    const leftAlt = `${c.color} left side`.toLowerCase();
    const rightAlt = `${c.color} right side`.toLowerCase();
    const leftMedia = product.media.find(m => m.alt.toLowerCase() === leftAlt);
    const rightMedia = product.media.find(m => m.alt.toLowerCase() === rightAlt);
    if (!leftMedia && !rightMedia) {
      noMedia++;
      logger.info(`[${product.handle}/${c.color}] no left/right side media on store — skip`);
      continue;
    }

    const brRow = br.directByKey.get(`${c.pid}|${c.color.toLowerCase()}`)!;

    let pair;
    try {
      pair = await buildSidePair(brRow.sideUrl, brRow.supplier, brRow.styleId, safeColor(c.color));
    } catch (e) {
      buildFailed++;
      logger.error(`[${product.handle}/${c.color}] buildSidePair threw: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!pair) {
      buildFailed++;
      logger.error(`[${product.handle}/${c.color}] buildSidePair returned null`);
      continue;
    }

    const toDelete: string[] = [];
    if (leftMedia) toDelete.push(leftMedia.id);
    if (rightMedia) toDelete.push(rightMedia.id);

    if (args.dryRun) {
      logger.info(`[${product.handle}/${c.color}] DRY would delete ${toDelete.length} contaminated media + attach fresh L/R pair (detected=${pair.detectedSide})`);
      pairsFixed++;
      continue;
    }

    const delErr = await deleteMedia(client, product.id, toDelete);
    if (delErr) { errors++; logger.error(`[${product.handle}/${c.color}] delete failed: ${delErr}`); continue; }
    mediaDeleted += toDelete.length;

    const lErr = await attachMedia(client, product.id, pair.leftSideUrl, `${c.color} left side`);
    if (lErr) { errors++; logger.error(`[${product.handle}/${c.color}] attach left failed: ${lErr}`); continue; }
    mediaAttached++;

    const rErr = await attachMedia(client, product.id, pair.rightSideUrl, `${c.color} right side`);
    if (rErr) { errors++; logger.error(`[${product.handle}/${c.color}] attach right failed: ${rErr}`); continue; }
    mediaAttached++;

    pairsFixed++;
    logger.info(`[${product.handle}/${c.color}] FIXED — deleted ${toDelete.length}, attached fresh L/R (detected=${pair.detectedSide})`);
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Pairs ${args.dryRun ? 'would fix' : 'fixed'}: ${pairsFixed}`);
  logger.info(`Pairs already clean:    ${pairsAlreadyClean}`);
  logger.info(`No product on store:    ${noProduct}`);
  logger.info(`No side media to clean: ${noMedia}`);
  logger.info(`buildSidePair failed:   ${buildFailed}`);
  logger.info(`Errors:                 ${errors}`);
  logger.info(`Media deleted:          ${args.dryRun ? '(dry)' : mediaDeleted}`);
  logger.info(`Media attached:         ${args.dryRun ? '(dry)' : mediaAttached}`);
  logger.info(`Unfixable (need manual): ${unfixable.length}${args.dryRun ? '' : ' → ' + UNFIXABLE_TSV}`);
}

await main();
