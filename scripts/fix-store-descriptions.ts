/**
 * Rewrite product descriptions on the dest test store into D2C-friendly copy.
 *
 * Current state on dest (median 633 chars, max 1042) is supplier-catalog prose:
 * 4-7 paragraphs, generic "Ideal for: team uniforms, workwear" lines. Bad for
 * a consumer storefront (low scannability, no hook, B2B voice).
 *
 * Target shape:
 *   - 1 sentence hook (lead with the benefit, not the product name)
 *   - 3-4 short bullets (feature → why-it-matters)
 *   - ~250-350 chars total, plain HTML so Shopify renders bullets
 *
 *   1. Read Bestsellers-Ready: per productId → original description + product
 *      meta (title, fabric/keywords blob) for context.
 *   2. For each product on dest, look up the BR row, generate a rewrite via
 *      gpt-4o-mini.
 *   3. Cache rewrites in tmp/d2c-description-cache.json (keyed by productId +
 *      sha256 of original description) — reruns are free.
 *   4. Update via productUpdate.descriptionHtml. Idempotent: skip if the
 *      product's current descriptionHtml already matches the cached rewrite.
 *
 * Flags:
 *   --dry-run             no Shopify writes, no OpenAI calls (cache-only preview)
 *   --no-cache            ignore cache, regenerate everything (still writes cache)
 *   --limit N             process at most N products
 *   --handles a,b,c       restrict to these handles
 *   --print               echo each rewrite to stdout
 *
 * Recommended first run:
 *   npx tsx -r dotenv/config scripts/fix-store-descriptions.ts --limit 1 --print
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const CACHE_PATH = path.join('tmp', 'd2c-description-cache.json');

interface Args { dryRun: boolean; limit: number; handles: string[] | null; noCache: boolean; print: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, limit: Infinity, handles: null, noCache: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--no-cache') a.noCache = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--handles') a.handles = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--print') a.print = true;
  }
  return a;
}

interface CacheEntry { html: string; charCount: number; model: string; ts: number }
type Cache = Record<string, CacheEntry>;
let cache: Cache = {};
function loadCache(): void {
  if (existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); } catch { cache = {}; }
  }
}
function saveCache(): void { writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }
// Bump PROMPT_VERSION whenever the SYSTEM_PROMPT structure changes so cached
// rewrites from the old structure are not reused.
const PROMPT_VERSION = 'v2';
function cacheKey(pid: string, original: string): string {
  return `${pid}::${PROMPT_VERSION}::${createHash('sha256').update(original).digest('hex').slice(0, 16)}`;
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

const SYSTEM_PROMPT = `You rewrite apparel product descriptions for a consumer-facing Shopify storefront.

Required structure, in order:
1. <p> Intro — 1-2 sentence benefit-led hook (~14-25 words). Don't restate the product name. Lead with how it feels or what the wearer gets.
2. <p> Benefits — 2-3 sentences. Why someone reaches for this piece: comfort, durability, fit, occasion fit. Plainspoken, not aspirational fluff.
3. <ul> Bullets — exactly 3-4 <li>. Each bullet: a concrete feature, then "—", then what the wearer gets (e.g. "Brushed fleece interior — locks in warmth on the coldest days").
4. <p> Composition — one short line listing fabric/weight when the source has it (e.g. "100% ringspun cotton, 5.3 oz / 180 GSM"). If the source has no fabric info, OMIT this paragraph entirely. Never invent.

Voice rules:
- Confident, plainspoken, modern D2C. No "ideal for", no "perfect for any occasion", no "versatile wardrobe essential", no "wardrobe staple", no "elevate your wardrobe".
- Don't invent specs. If the source mentions a fabric/weight/feature, you can use it; if it doesn't, leave it out.
- Never mention printing, embroidery, decoration, screen printing, custom logos, or anything about adding artwork. This is a finished retail product, not blank stock for decoration.
- Don't reference the supplier, brand name, or supplier product name.

Length target: 400-650 characters of visible text total across all paragraphs combined. Tight and scannable.

Output strictly as HTML: <p> ... </p> for intro, <p> ... </p> for benefits, <ul><li>...</li></ul> for bullets, <p> ... </p> for composition (if present). No <h1>, no extra wrappers, no markdown, no emoji.`;

async function rewriteDescription(productTitle: string, original: string, keywords: string): Promise<string> {
  const client = getClient();
  const userPrompt = `Product title: ${productTitle}
Keywords/categories: ${keywords || '(none)'}

Original supplier description:
"""
${original}
"""

Rewrite per the rules. Return only the HTML.`;
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 700,
    temperature: 0.5,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  const html = (res.choices[0]?.message?.content ?? '').trim();
  // Strip ``` fences if the model adds them
  return html.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();
}

interface BrIndex {
  byPid: Map<string, { title: string; description: string; keywords: string }>;
  pidByHandleSuffix: Map<string, string>;
}
function buildBrIndex(rows: string[][]): BrIndex {
  const h: Record<string, number> = {};
  (rows[0] as string[]).forEach((x, i) => { h[x] = i; });
  const byPid = new Map<string, { title: string; description: string; keywords: string }>();
  const pidByHandleSuffix = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pid = String(r[h['productId']] ?? '').trim();
    if (!pid) continue;
    pidByHandleSuffix.set(pid.toLowerCase(), pid);
    if (byPid.has(pid)) continue;
    byPid.set(pid, {
      title: String(r[h['productName']] ?? '').trim(),
      description: String(r[h['description']] ?? '').trim(),
      keywords: [r[h['keywords']], r[h['baseCategory']], r[h['categories']]]
        .map(v => String(v ?? '').trim()).filter(Boolean).join(', '),
    });
  }
  return { byPid, pidByHandleSuffix };
}

function pidFromHandle(handle: string, br: BrIndex): string | null {
  const segments = handle.split('-');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (br.pidByHandleSuffix.has(segments[i].toLowerCase())) return br.pidByHandleSuffix.get(segments[i].toLowerCase())!;
  }
  return null;
}

interface ProductOnStore { id: string; handle: string; descriptionHtml: string }

async function fetchAllProducts(client: ShopifyClient): Promise<ProductOnStore[]> {
  const Q = `
    query($after: String) {
      products(first: 50, after: $after) {
        edges { cursor node { id handle descriptionHtml } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const out: ProductOnStore[] = [];
  let after: string | null = null;
  for (let page = 0; page < 30; page++) {
    const res = (await client.request(Q, { variables: { after } })) as {
      data: { products: { edges: { node: ProductOnStore }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };
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
      product { id descriptionHtml }
      userErrors { field message }
    }
  }
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`fix-store-descriptions starting: ${JSON.stringify({ ...args, handles: args.handles?.length })}`);
  loadCache();
  logger.info(`Cache loaded: ${Object.keys(cache).length} entries`);

  const sheets = createSheetsClient();
  const brResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const brRows = (brResp.data.values ?? []) as string[][];
  const br = buildBrIndex(brRows);
  logger.info(`Indexed ${br.byPid.size} BR products`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  let products = await fetchAllProducts(client);
  logger.info(`Fetched ${products.length} products from dest`);
  if (args.handles) products = products.filter(p => args.handles!.includes(p.handle));
  if (Number.isFinite(args.limit)) products = products.slice(0, args.limit);
  logger.info(`Processing ${products.length} products`);

  let updated = 0, alreadyOk = 0, noBrMatch = 0, generated = 0, cacheHits = 0, errors = 0;
  for (const p of products) {
    try {
      const pid = pidFromHandle(p.handle, br);
      if (!pid) { noBrMatch++; logger.info(`[${p.handle}] no pid match`); continue; }
      const brRow = br.byPid.get(pid);
      if (!brRow || !brRow.description) { noBrMatch++; logger.info(`[${p.handle}] no BR description`); continue; }

      const key = cacheKey(pid, brRow.description);
      let entry = args.noCache ? null : cache[key];
      if (entry) cacheHits++;

      if (!entry) {
        // In dry-run, normally skip OpenAI to keep previews free. But when
        // --print is on the user wants to actually see new rewrites, so allow
        // generation (still no Shopify writes).
        if (args.dryRun && !args.print) {
          logger.info(`[${p.handle}] DRY would call OpenAI (no cached entry)`);
          continue;
        }
        const html = await rewriteDescription(brRow.title || p.handle, brRow.description, brRow.keywords);
        entry = { html, charCount: html.replace(/<[^>]+>/g, '').length, model: 'gpt-4o-mini', ts: Date.now() };
        cache[key] = entry;
        saveCache();
        generated++;
      }

      // Prepend the supplier productId as a "Style #" line so customers (and
      // staff) can quote it. Kept outside the AI cache so the cache stays
      // valid across pid label changes and re-runs are deterministic.
      const styleHeader = `<p><strong>Style #:</strong> ${pid}</p>\n`;
      const finalHtml = `${styleHeader}${entry.html}`;

      if (args.print) {
        logger.info(`[${p.handle}] rewrite (${entry.charCount} visible chars + style #):\n${finalHtml}\n`);
      }

      // Already-correct check: compare normalized HTML (Shopify may massage whitespace)
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (norm(p.descriptionHtml ?? '') === norm(finalHtml)) { alreadyOk++; continue; }

      if (args.dryRun) {
        logger.info(`[${p.handle}] DRY would update descriptionHtml (${entry.charCount} chars + style # ${pid})`);
        continue;
      }

      const res = (await client.request(PRODUCT_UPDATE, {
        variables: { input: { id: p.id, descriptionHtml: finalHtml } },
      })) as { data: { productUpdate: { userErrors: { field: string[]; message: string }[] } } };
      const errs = res.data.productUpdate.userErrors;
      if (errs.length > 0) {
        errors++;
        logger.error(`[${p.handle}] update error: ${errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ')}`);
      } else {
        updated++;
        logger.info(`[${p.handle}] updated (${entry.charCount} chars)`);
      }
    } catch (e) {
      errors++;
      logger.error(`[${p.handle}] uncaught: ${e instanceof Error ? e.message : e}`);
    }
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Updated:        ${updated}`);
  logger.info(`Already OK:     ${alreadyOk}`);
  logger.info(`Cache hits:     ${cacheHits}`);
  logger.info(`Generated new:  ${generated}`);
  logger.info(`No BR match:    ${noBrMatch}`);
  logger.info(`Errors:         ${errors}`);
}

await main();
