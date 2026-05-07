/**
 * Backfill the product-level model image on dest store products that have
 * BR.ModelFrontImage set but no `model front` media attached.
 *
 * Why: prior versions of `push-bestsellers-to-store.ts` only uploaded the
 * front/back/left/right side images per color and never included the
 * product-level model image. Audit (audit-product-imagery.ts) found 398/460
 * products in this state. The push script has been patched going forward;
 * this script repairs already-pushed products.
 *
 * For each store product:
 *   1. Match handle → pid via BR
 *   2. If BR.ModelFrontImage is set AND no media on store has alt containing
 *      "model", attach a single new media with that URL and alt "model front"
 *
 * Idempotent: skips products where a model media already exists.
 *
 * Flags:
 *   --dry-run         no Shopify writes
 *   --limit N         process at most N products
 *   --handles a,b,c   restrict to these handles
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;
const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';

interface Args { dryRun: boolean; limit: number; handles: string[] | null }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, limit: Infinity, handles: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--handles') a.handles = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return a;
}

const PRODUCT_PAGE = `
  query($after: String) {
    products(first: 25, after: $after) {
      edges { node { id handle media(first: 250) { edges { node { ... on MediaImage { id alt } } } } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const PRODUCT_CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id alt }
      mediaUserErrors { field message code }
    }
  }
`;

interface StoreP { id: string; handle: string; hasModel: boolean }

async function fetchAll(client: ShopifyClient): Promise<StoreP[]> {
  const out: StoreP[] = [];
  let after: string | null = null;
  for (let p = 0; p < 60; p++) {
    const r = (await client.request(PRODUCT_PAGE, { variables: { after } })) as any;
    for (const e of r.data.products.edges) {
      const node = e.node;
      const hasModel = node.media.edges.some((x: any) => /\bmodel\b/i.test((x.node?.alt ?? '').trim()));
      out.push({ id: node.id, handle: node.handle, hasModel });
    }
    if (!r.data.products.pageInfo.hasNextPage) break;
    after = r.data.products.pageInfo.endCursor;
  }
  return out;
}

async function attach(client: ShopifyClient, productId: string, src: string): Promise<string | null> {
  const r = (await client.request(PRODUCT_CREATE_MEDIA, {
    variables: { productId, media: [{ originalSource: src, alt: 'model front', mediaContentType: 'IMAGE' }] },
  })) as { data: { productCreateMedia: { mediaUserErrors: { field: string[]; message: string }[] } } };
  const errs = r.data.productCreateMedia.mediaUserErrors;
  if (errs.length > 0) return errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ');
  return null;
}

function pidFromHandle(handle: string, pidByLower: Map<string, string>): string | null {
  const segs = handle.split('-');
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = pidByLower.get(segs[i].toLowerCase());
    if (p) return p;
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`backfill-model-images: ${JSON.stringify({ ...args, handles: args.handles?.length })}`);

  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });

  const modelByPid = new Map<string, string>();
  const pidByLower = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][h['productId']] ?? '').trim();
    if (!pid) continue;
    pidByLower.set(pid.toLowerCase(), pid);
    if (modelByPid.has(pid)) continue;
    const m = String(rows[i][h['ModelFrontImage']] ?? '').trim();
    if (m) modelByPid.set(pid, m);
  }
  logger.info(`Indexed ${modelByPid.size} pids with ModelFrontImage in BR`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  let products = await fetchAll(client);
  logger.info(`Fetched ${products.length} store products`);
  if (args.handles) products = products.filter(p => args.handles!.includes(p.handle));
  if (Number.isFinite(args.limit)) products = products.slice(0, args.limit);

  let attached = 0, skippedNoModel = 0, skippedAlreadyHas = 0, skippedNoPid = 0, errors = 0;
  for (const p of products) {
    const pid = pidFromHandle(p.handle, pidByLower);
    if (!pid) { skippedNoPid++; continue; }
    const url = modelByPid.get(pid);
    if (!url) { skippedNoModel++; continue; }
    if (p.hasModel) { skippedAlreadyHas++; continue; }
    if (args.dryRun) {
      logger.info(`[${p.handle}] DRY would attach model front from ${url.slice(-12)}`);
      attached++;
      continue;
    }
    const err = await attach(client, p.id, url);
    if (err) { errors++; logger.error(`[${p.handle}] attach failed: ${err}`); }
    else { attached++; logger.info(`[${p.handle}] attached model front`); }
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Attached:           ${args.dryRun ? '(dry) ' + attached : attached}`);
  logger.info(`Skipped (no pid):   ${skippedNoPid}`);
  logger.info(`Skipped (no model): ${skippedNoModel}`);
  logger.info(`Skipped (has):      ${skippedAlreadyHas}`);
  logger.info(`Errors:             ${errors}`);
}

await main();
