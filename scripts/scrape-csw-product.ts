/**
 * Scrape a Canada Sportswear (canadasportswear.com) product by style code.
 * Site is plain Shopify — no Playwright needed.
 *
 * Returns: handle, description, productType, tags, gender, sizeChartUrl.
 *
 * Module exports: scrapeCSW(style) and helpers (findHandle, fetchProductJson, fetchSizeChartUrl, inferGender).
 * CLI: `npx tsx scripts/scrape-csw-product.ts <STYLE>` — prints JSON for one style.
 */
import 'dotenv/config';
import * as cheerio from 'cheerio';

const BASE = 'https://www.canadasportswear.com';
const RATE_LIMIT_MS = 1000;

export type Gender = 'women' | 'men' | 'youth' | 'unisex';

export interface CSWScrapeResult {
  style: string;
  handle: string | null;
  description: string;
  productType: string;
  tags: string[];
  gender: Gender;
  sizeChartUrl: string | null;
}

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function get(url: string): Promise<Response> {
  await throttle();
  const r = await fetch(url, { headers: { 'User-Agent': 'fortee-catalog-engine/1.0' } });
  return r;
}

/** Search by style code, return matching product handle. Verifies the style appears in title/tags. */
export async function findHandle(style: string): Promise<string | null> {
  const r = await get(`${BASE}/search/suggest.json?q=${encodeURIComponent(style)}&resources[type]=product&resources[limit]=10`);
  if (!r.ok) return null;
  const data: any = await r.json();
  const products: any[] = data?.resources?.results?.products ?? [];
  if (products.length === 0) return null;

  const styleUpper = style.toUpperCase();
  // Prefer products whose title or tags mention the style code (avoid false-positive search hits).
  const matched = products.find(p => {
    const title = String(p.title ?? '').toUpperCase();
    const tags = (p.tags ?? []).map((t: string) => t.toUpperCase());
    return title.includes(styleUpper) || tags.some((t: string) => t === styleUpper || t.endsWith(styleUpper));
  });
  return matched?.handle ?? products[0].handle ?? null;
}

/** Fetch product JSON: body_html (description), product_type (category), tags. */
export async function fetchProductJson(handle: string): Promise<{ description: string; productType: string; tags: string[] } | null> {
  const r = await get(`${BASE}/products/${handle}.json`);
  if (!r.ok) return null;
  const data: any = await r.json();
  const p = data?.product;
  if (!p) return null;
  return {
    description: htmlToText(String(p.body_html ?? '')),
    productType: String(p.product_type ?? ''),
    tags: Array.isArray(p.tags) ? p.tags.map((t: any) => String(t)) : [],
  };
}

/** Fetch product HTML page, extract first SIZE_CHART PDF URL. */
export async function fetchSizeChartUrl(handle: string): Promise<string | null> {
  const r = await get(`${BASE}/products/${handle}`);
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/href="(https:\/\/cdn\.shopify\.com\/[^"]*SIZE_CHART[^"]*\.pdf[^"]*)"/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/**
 * Gender inference, in priority order:
 *  1. tags array (LADIES/WOMENS/MENS/YOUTH)
 *  2. handle keywords (e.g., "-ladies-", "-mens-", "-womens-", "-youth-")
 *  3. Y-suffix on style code → youth
 *  4. default unisex
 *
 * Note: L-prefix on CSW style codes does NOT mean Ladies — it's the "Lightweight" line.
 * E.g., L07240 → "Cadet Mens Lightweight Softshell". Always trust the handle/title over the prefix.
 */
export function inferGender(style: string, tags: string[], handle: string | null = null): Gender {
  const tagsUpper = tags.map(t => t.toUpperCase());
  if (tagsUpper.includes('LADIES') || tagsUpper.includes('WOMEN') || tagsUpper.includes('WOMENS')) return 'women';
  if (tagsUpper.includes('YOUTH') || tagsUpper.includes('KIDS')) return 'youth';
  if (tagsUpper.includes('MENS') || tagsUpper.includes('MEN')) return 'men';

  if (handle) {
    const h = handle.toLowerCase();
    if (/-(ladies|womens|women)-/.test(h)) return 'women';
    if (/-youth-/.test(h)) return 'youth';
    if (/-(mens|men)-/.test(h)) return 'men';
    if (/-unisex-/.test(h)) return 'unisex';
  }

  if (/Y$/.test(style.toUpperCase())) return 'youth';
  return 'unisex';
}

function htmlToText(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  // Drop images and scripts; keep text content
  $('img, script, style').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

export async function scrapeCSW(style: string): Promise<CSWScrapeResult> {
  const handle = await findHandle(style);
  if (!handle) {
    return { style, handle: null, description: '', productType: '', tags: [], gender: inferGender(style, []), sizeChartUrl: null };
  }
  const [json, sizeChartUrl] = await Promise.all([
    fetchProductJson(handle),
    fetchSizeChartUrl(handle),
  ]);
  const tags = json?.tags ?? [];
  return {
    style,
    handle,
    description: json?.description ?? '',
    productType: json?.productType ?? '',
    tags,
    gender: inferGender(style, tags, handle),
    sizeChartUrl,
  };
}

async function main(): Promise<void> {
  const style = process.argv[2];
  if (!style) {
    console.error('Usage: npx tsx scripts/scrape-csw-product.ts <STYLE_CODE>');
    process.exit(1);
  }
  const result = await scrapeCSW(style);
  console.log(JSON.stringify(result, null, 2));
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });
