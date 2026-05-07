/**
 * Backfill correct titles on products already pushed to the dest test store.
 *
 * Why: prior versions of `push-bestsellers-to-store.ts` published the supplier
 * productName (e.g., "Parkour", "Heavy Cotton™") as the customer-facing title.
 * scripts/generate-titles.ts now writes a clean, brand-aware AI title to the
 * `cleanTitle` column in Bestsellers-Ready, and the push script reads that
 * column going forward. This script repairs already-pushed products by
 * aligning Shopify's product.title to BR.cleanTitle when they diverge.
 *
 * For each product on dest:
 *   1. Match handle suffix → BR pid
 *   2. Look up BR.cleanTitle for that pid
 *   3. If current title differs, update via productUpdate mutation
 *
 * If BR.cleanTitle is missing for a pid, skip with `no-clean-title-in-br`
 * (run scripts/generate-titles.ts first).
 *
 * Flags:
 *   --dry-run         no Shopify writes
 *   --limit N         process at most N products
 *   --handles a,b,c   restrict to these handles
 *   --quiet           suppress per-product log lines
 *
 * Recommended first run:
 *   npx tsx -r dotenv/config scripts/fix-store-titles.ts --dry-run --limit 1
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';

interface Args { dryRun: boolean; limit: number; handles: string[] | null; quiet: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, limit: Infinity, handles: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--handles') a.handles = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--quiet') a.quiet = true;
  }
  return a;
}

interface ProductOnStore { id: string; handle: string; title: string }

async function fetchAllProducts(client: ShopifyClient): Promise<ProductOnStore[]> {
  const Q = `
    query($after: String) {
      products(first: 100, after: $after) {
        edges { cursor node { id handle title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const out: ProductOnStore[] = [];
  let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const res = (await client.request(Q, { variables: { after } })) as {
      data: {
        products: {
          edges: { node: { id: string; handle: string; title: string } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    };
    for (const { node } of res.data.products.edges) out.push(node);
    if (!res.data.products.pageInfo.hasNextPage) break;
    after = res.data.products.pageInfo.endCursor;
  }
  return out;
}

const PRODUCT_UPDATE = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

interface BrIndex {
  titleByPid: Map<string, string>;
  pidByHandleSuffix: Map<string, string>;
}

function buildBrIndex(rows: string[][]): BrIndex {
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  if (h['cleanTitle'] == null) {
    throw new Error(`Bestsellers-Ready missing 'cleanTitle' column. Run scripts/generate-titles.ts first.`);
  }
  const titleByPid = new Map<string, string>();
  const pidByHandleSuffix = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pid = String(r[h['productId']] ?? '').trim();
    const cleanTitle = String(r[h['cleanTitle']] ?? '').trim();
    if (!pid) continue;
    pidByHandleSuffix.set(pid.toLowerCase(), pid);
    if (cleanTitle && !titleByPid.has(pid)) titleByPid.set(pid, cleanTitle);
  }
  return { titleByPid, pidByHandleSuffix };
}

function pidFromHandle(handle: string, br: BrIndex): string | null {
  const segments = handle.split('-');
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments[i].toLowerCase();
    if (br.pidByHandleSuffix.has(candidate)) return br.pidByHandleSuffix.get(candidate)!;
  }
  return null;
}

interface FixOutcome {
  handle: string;
  status: 'fixed' | 'already-correct' | 'no-pid-match' | 'no-clean-title-in-br' | 'trademark-preserved' | 'error';
  oldTitle?: string;
  newTitle?: string;
  error?: string;
}

const TRADEMARK_RE = /[™®©]/; // ™ ® ©

async function fixProduct(
  client: ShopifyClient,
  p: ProductOnStore,
  br: BrIndex,
  args: Args,
): Promise<FixOutcome> {
  const pid = pidFromHandle(p.handle, br);
  if (!pid) return { handle: p.handle, status: 'no-pid-match' };

  const cleanTitle = br.titleByPid.get(pid);
  if (!cleanTitle) return { handle: p.handle, status: 'no-clean-title-in-br' };

  if (TRADEMARK_RE.test(p.title)) {
    return { handle: p.handle, status: 'trademark-preserved', oldTitle: p.title };
  }

  if (p.title.trim() === cleanTitle.trim()) {
    return { handle: p.handle, status: 'already-correct' };
  }

  if (args.dryRun) {
    return { handle: p.handle, status: 'fixed', oldTitle: p.title, newTitle: cleanTitle };
  }

  const res = (await client.request(PRODUCT_UPDATE, {
    variables: { input: { id: p.id, title: cleanTitle } },
  })) as { data: { productUpdate: { userErrors: { field: string[]; message: string }[] } } };
  const errs = res.data.productUpdate.userErrors;
  if (errs.length > 0) {
    return {
      handle: p.handle,
      status: 'error',
      oldTitle: p.title,
      newTitle: cleanTitle,
      error: errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; '),
    };
  }
  return { handle: p.handle, status: 'fixed', oldTitle: p.title, newTitle: cleanTitle };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`fix-store-titles starting: ${JSON.stringify({ ...args, handles: args.handles?.length })}`);

  const sheets = createSheetsClient();
  const brResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const brRows = (brResp.data.values ?? []) as string[][];
  const br = buildBrIndex(brRows);
  logger.info(`Indexed ${br.titleByPid.size} BR products with cleanTitle (of ${br.pidByHandleSuffix.size} total)`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  let products = await fetchAllProducts(client);
  logger.info(`Fetched ${products.length} products from dest`);
  if (args.handles) products = products.filter(p => args.handles!.includes(p.handle));
  if (Number.isFinite(args.limit)) products = products.slice(0, args.limit);
  logger.info(`Processing ${products.length} products`);

  const counts: Record<string, number> = {};
  for (const p of products) {
    try {
      const r = await fixProduct(client, p, br, args);
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (r.status === 'fixed') {
        logger.info(`[${p.handle}] ${args.dryRun ? 'WOULD FIX' : 'FIXED'}: "${r.oldTitle}" → "${r.newTitle}"`);
      } else if (r.status === 'error') {
        logger.error(`[${p.handle}] ERROR: ${r.error}`);
      } else if (!args.quiet) {
        logger.info(`[${p.handle}] ${r.status}`);
      }
    } catch (e) {
      counts['error'] = (counts['error'] ?? 0) + 1;
      logger.error(`[${p.handle}] uncaught: ${e instanceof Error ? e.message : e}`);
    }
  }

  logger.info(`\n=== Summary ===`);
  for (const [k, v] of Object.entries(counts).sort()) logger.info(`${k.padEnd(24)}: ${v}`);
}

await main();
