/**
 * Phase 16 / 17: pid → supplier canonical image URL resolver.
 *
 * Dispatches by pid prefix to fetch the "what the product SHOULD look like"
 * image from each supplier's authoritative source:
 *
 *   H08*   → null (headwear is out-of-scope per D-22; never fetched)
 *   routesViaSS(pid) → S&S Canada REST API (auth via Basic / SS_ACCOUNT_NUMBER
 *             + SS_API_KEY). Phase 17 17-04 widened this to also include
 *             adidas (A*, CE*) and the KNOWN_SUPPLIER_PREFIXES allowlist
 *             (Bella+Canvas / Gildan / Next Level / Comfort Colors /
 *             American Apparel / Richardson) — all carried by S&S Canada.
 *   L*     → Canada Sportswear Shopify scraper (no auth)
 *   other  → null (M786, NE220, anvil 9xx, QTB6000 — handled by Plan 17-05
 *             manual triage)
 *
 * Patterns copied from:
 *   - scripts/fetch-ss-images-fixed.ts (S&S auth, throttle, ssGet, resolveStyleId, makeLargeUrl)
 *   - scripts/scrape-csw-product.ts (CSW throttle, findHandle, fetchProductJson)
 *   - scripts/audit-product-imagery.ts:51-77 (KNOWN_SUPPLIER_PREFIXES allowlist)
 *
 * The library exists so the audit + fix scripts share one resolver. The original
 * scripts remain as CLIs.
 *
 * CRITICAL — colorSideImage caveat (per user memory `feedback_strict_side_profile`
 * and `scripts/fetch-ss-images-fixed.ts:132-138`): S&S `colorSideImage` is
 * sometimes an on-model side view (NOT a true side profile). This resolver MUST
 * NEVER return `colorSideImage` as canonical — only `colorFrontImage`. The
 * comparison verifier downstream treats front as the truth source; if pollution
 * affected a side image, the fix flow synthesizes the side from the front via
 * Phase 15's generator (Tier 2), not from S&S's side endpoint.
 *
 * Rate-limit (T-16-05):
 *   - S&S: 1100 ms between calls (60 req/min); on 503 sleep 10s + retry once.
 *   - CSW: 1000 ms between calls (no documented limit; conservative).
 *   Each source has its own module-global `lastRequestAt`.
 */

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SS_BASE = 'https://api-ca.ssactivewear.com/v2';
const SS_IMG_BASE = 'https://www.ssactivewear.com/';
const SS_RATE_LIMIT_MS = 1100;

const CSW_BASE = 'https://www.canadasportswear.com';
const CSW_RATE_LIMIT_MS = 1000;

let ssLastRequestAt = 0;
let cswLastRequestAt = 0;

// ---------------------------------------------------------------------------
// KNOWN_SUPPLIER_PREFIXES (verbatim from scripts/audit-product-imagery.ts:51-77)
// ---------------------------------------------------------------------------

const KNOWN_SUPPLIER_PREFIXES: Record<string, string[]> = {
  // Richardson caps
  '168': ['Richardson_168_'],
  '112': ['Richardson_112_'],
  // BELLA + CANVAS line
  '1010': ['BELLA_+_CANVAS_1010_'],
  '3001': ['BELLA_+_CANVAS_3001_'],
  '3010': ['BELLA_+_CANVAS_3010_'],
  '3480': ['BELLA_+_CANVAS_3480_'],
  '4610': ['BELLA_+_CANVAS_4610_'],
  '6003': ['BELLA_+_CANVAS_6003_'],
  '6008': ['BELLA_+_CANVAS_6008_'],
  '6110': ['BELLA_+_CANVAS_6110_'],
  '8882': ['BELLA_+_CANVAS_8882_'],
  // Next Level
  '1510': ['Next_Level_1510_'],
  '3900': ['Next_Level_3900_'],
  '3911': ['Next_Level_3911_'],
  '9002': ['Next_Level_9002_'],
  // Comfort Colors
  '1466': ['Comfort_Colors_1466_'],
  '1467': ['Comfort_Colors_1467_'],
  // Gildan
  '5200': ['Gildan_5200_'],
  // American Apparel
  '1304': ['American_Apparel_1304_'],
};

// ---------------------------------------------------------------------------
// Phase 17 17-04: S&S prefix dispatcher widening
// ---------------------------------------------------------------------------

/**
 * Phase 17 17-04: pids dispatched to the S&S branch via brand-prefix routing.
 * Per RESEARCH Findings 1 + 2:
 *   - adidas is EXCLUSIVE to S&S in the promo channel (`/^A\d/i`, `/^CE\d/i`)
 *   - Bella+Canvas, Gildan, Next Level, Comfort Colors, American Apparel,
 *     and Richardson pids (the KNOWN_SUPPLIER_PREFIXES allowlist) are ALSO
 *     carried by S&S Canada.
 * Routing them through the existing S&S branch unlocks Tier 1 fixes without
 * building separate scrapers per brand. The S&S `/styles/?search=<pid>`
 * endpoint works for any pid, not just S*-prefixed (verified pattern in
 * scripts/fetch-ss-rest-sizes.ts:80-94).
 */
const SS_ROUTABLE_PIDS: Set<string> = new Set<string>(Object.keys(KNOWN_SUPPLIER_PREFIXES));

/**
 * Returns true if `pid` should be dispatched through the S&S branch of
 * resolveSupplierCanonical. Phase 17 17-04.
 *
 * Trigger conditions (any match):
 *   - `/^S/i`  (native S&S S* prefix — Phase 16 default)
 *   - `/^A\d/i` (adidas A2009, A702 etc. — RESEARCH Finding 1)
 *   - `/^CE\d/i` (adidas CE520L etc. — RESEARCH Finding 1)
 *   - `SS_ROUTABLE_PIDS.has(pid)` (Bella+Canvas / Gildan / Next Level /
 *     Comfort Colors / American Apparel / Richardson — RESEARCH Finding 2)
 *
 * The H08* early-return in resolveSupplierCanonical fires BEFORE this helper,
 * so headwear (D-22) never reaches the dispatcher.
 */
export function routesViaSS(pid: string): boolean {
  if (/^S/i.test(pid)) return true;
  if (/^A\d/i.test(pid)) return true;
  if (/^CE\d/i.test(pid)) return true;
  if (SS_ROUTABLE_PIDS.has(pid)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Canonical image resolution result returned to the caller. */
export interface CanonicalResult {
  /** Direct image URL the verifier will download. */
  url: string;
  /** Which supplier branch resolved this pid. */
  source: 'ss' | 'csw';
  /** S&S styleID (number) or CSW handle (string) — for trail logging. */
  styleId?: number | string;
  /**
   * Phase 17 17-02: true iff caller passed a `colorName` but no exact match
   * was found in the supplier response, and the result fell back to the first
   * front-image-bearing variant. Callers can use this to distinguish a precise
   * per-color resolution from a best-effort fallback. Unset when colorName was
   * not provided (preserves Phase 16 behavior).
   */
  wasFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Throttle helper — per-source module-global timestamps (mirrors
// scripts/scrape-csw-product.ts:37-42).
// ---------------------------------------------------------------------------

async function throttle(which: 'ss' | 'csw'): Promise<void> {
  const limit = which === 'ss' ? SS_RATE_LIMIT_MS : CSW_RATE_LIMIT_MS;
  const last = which === 'ss' ? ssLastRequestAt : cswLastRequestAt;
  const wait = limit - (Date.now() - last);
  if (wait > 0) {
    await new Promise<void>((r) => setTimeout(r, wait));
  }
  const now = Date.now();
  if (which === 'ss') {
    ssLastRequestAt = now;
  } else {
    cswLastRequestAt = now;
  }
}

// ---------------------------------------------------------------------------
// S&S helpers (mirror scripts/fetch-ss-images-fixed.ts:26-64)
// ---------------------------------------------------------------------------

function getSSAuth(): string {
  const account = process.env.SS_ACCOUNT_NUMBER;
  const key = process.env.SS_API_KEY;
  if (!account || !key) {
    throw new Error('SS_ACCOUNT_NUMBER and SS_API_KEY must be set');
  }
  return `Basic ${Buffer.from(`${account}:${key}`).toString('base64')}`;
}

async function ssGet<T>(path: string, auth: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(SS_BASE + path, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (r.status === 503) {
      await new Promise<void>((x) => setTimeout(x, 10000));
      continue;
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`SS API ${r.status} on ${path}`);
    return (await r.json()) as T;
  }
  return null;
}

async function resolveSSStyleId(pid: string, auth: string): Promise<number | null> {
  const styles = await ssGet<Array<{ styleID: number; styleName: string }>>(
    `/styles/?search=${encodeURIComponent(pid)}&fields=styleID,styleName`,
    auth,
  );
  if (!styles || styles.length === 0) return null;
  const exact = styles.find(
    (s) => String(s.styleName ?? '').toUpperCase() === pid.toUpperCase(),
  );
  if (exact) return exact.styleID;
  if (styles.length === 1) return styles[0].styleID;
  return null;
}

/** _fm thumb path → _fl large path + SS_IMG_BASE prefix. */
function makeSSLargeUrl(path: string): string {
  if (!path) return '';
  return SS_IMG_BASE + path.replace('_fm', '_fl');
}

// ---------------------------------------------------------------------------
// CSW helpers (port of scripts/scrape-csw-product.ts:51-89)
// ---------------------------------------------------------------------------

async function findCSWHandle(style: string): Promise<string | null> {
  const r = await fetch(
    `${CSW_BASE}/search/suggest.json?q=${encodeURIComponent(style)}&resources[type]=product&resources[limit]=10`,
    { headers: { 'User-Agent': 'fortee-catalog-engine/1.0' } },
  );
  if (!r.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await r.json();
  const products: Array<{ handle?: string; title?: string; tags?: string[] }> =
    data?.resources?.results?.products ?? [];
  if (products.length === 0) return null;

  const styleUpper = style.toUpperCase();
  const matched = products.find((p) => {
    const title = String(p.title ?? '').toUpperCase();
    const tags = (p.tags ?? []).map((t: string) => String(t).toUpperCase());
    return (
      title.includes(styleUpper) ||
      tags.some((t: string) => t === styleUpper || t.endsWith(styleUpper))
    );
  });
  return matched?.handle ?? products[0].handle ?? null;
}

async function fetchCSWProduct(handle: string): Promise<{ images: Array<{ src: string }> } | null> {
  const r = await fetch(`${CSW_BASE}/products/${handle}.json`, {
    headers: { 'User-Agent': 'fortee-catalog-engine/1.0' },
  });
  if (!r.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await r.json();
  const p = data?.product;
  if (!p) return null;
  const images: Array<{ src: string }> = Array.isArray(p.images)
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p.images.map((img: any) => ({ src: String(img.src ?? '') }))
    : [];
  return { images };
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve a pid to its supplier-canonical front image URL.
 *
 * Dispatch order (each branch short-circuits on miss):
 *   1. `/^H08/i` → return null without any network call (D-22 headwear exclusion).
 *   2. `routesViaSS(pid)` → S&S Canada REST. Matches `/^S/i` (native S&S),
 *                  `/^A\d/i` (adidas A-family), `/^CE\d/i` (adidas CE-family),
 *                  or `SS_ROUTABLE_PIDS.has(pid)` (Bella+Canvas / Gildan /
 *                  Next Level / Comfort Colors / American Apparel / Richardson).
 *                  resolveStyleId → /products/?style= → take the matching color's
 *                  `colorFrontImage` (or first variant if no colorName) and run
 *                  it through makeSSLargeUrl (`_fm` → `_fl`). Returns
 *                  `{ url, source: 'ss', styleId }` or null.
 *                  Phase 17 17-04 added the brand-prefix widening — see
 *                  RESEARCH Findings 1 + 2 + Open Question 4.
 *   3. `/^L/i`   → CSW Shopify. findCSWHandle → fetchCSWProduct → match by
 *                  filename slug when colorName provided, else first image
 *                  `src`. Returns `{ url, source: 'csw', styleId: handle }` or
 *                  null.
 *   4. Else      → silent null. Truly unsupported brands (M786, NE220, anvil
 *                  9xx, QTB6000) are handled by Plan 17-05 manual triage.
 *
 * Phase 17 17-02 — per-color resolution. When `colorName` is provided:
 *   - S&S branch filters `/products/?style=` response by case-insensitive,
 *     whitespace-trimmed equality on each variant's `colorName`. The chosen
 *     variant must also carry a non-empty `colorFrontImage`; if it does not,
 *     the resolver falls through to the first front-image-bearing variant.
 *   - CSW branch does best-effort filename-substring match: the colorName is
 *     lowercased, trimmed, and spaces replaced by hyphens, then the slug is
 *     searched within each `images[].src` filename. CSW does not carry first-
 *     class color metadata — match is fragile by design (see RESEARCH §17-02
 *     Finding 4).
 *   - In either branch, if a `colorName` was provided but no match found, the
 *     result falls back to the first variant AND sets `wasFallback: true` so
 *     callers can choose strict vs loose handling.
 *
 * Phase 16 behavior is preserved when `colorName` is omitted: the first
 * front-image-bearing variant (S&S) / first image (CSW) is returned with
 * `wasFallback` unset.
 *
 * IMPORTANT (per Phase 16 memory `feedback_strict_side_profile` and
 * `scripts/fetch-ss-images-fixed.ts:132-138`): S&S `colorSideImage` is sometimes
 * an on-model side view, NOT a true side profile. This resolver MUST NEVER
 * return `colorSideImage` as canonical. Only `colorFrontImage` is exposed —
 * downstream verifiers treat front as the truth source.
 *
 * Rate-limit (T-16-05): every successful branch calls `throttle()` per source
 * before each fetch. The throttle uses a module-global `lastRequestAt`, so
 * sequential calls observe the 1100ms (S&S) / 1000ms (CSW) gap.
 *
 * @param pid Style/product identifier (BR productId).
 * @param colorName Optional BR row colorName cell value. Case-insensitive,
 *                  whitespace-trimmed match on S&S; best-effort
 *                  filename-substring match on CSW. When omitted, the
 *                  pre-Phase-17 first-variant behavior is preserved.
 */
export async function resolveSupplierCanonical(
  pid: string,
  colorName?: string,
): Promise<CanonicalResult | null> {
  // Headwear exclusion (D-22) — short-circuit BEFORE any network call.
  if (/^H08/i.test(pid)) return null;

  // Phase 17 17-04: brand-prefix dispatch routes adidas + KNOWN_SUPPLIER_PREFIXES
  // pids through the existing S&S branch. No new scrapers needed — S&S Canada
  // carries adidas (exclusive — RESEARCH Finding 1) plus Bella+Canvas / Gildan /
  // Next Level / Comfort Colors / American Apparel / Richardson (Finding 2).
  // Order matters: routesViaSS check includes /^S/i so S* pids behave as before.
  // CSW (L*) does NOT match routesViaSS and falls through to its own branch.
  if (routesViaSS(pid)) {
    // Surface which routing rule matched (operator observability — when an
    // audit run produces unexpected results, this log reveals the dispatch).
    const rule = /^S/i.test(pid)
      ? 'S*'
      : /^A\d/i.test(pid)
        ? 'A*'
        : /^CE\d/i.test(pid)
          ? 'CE*'
          : 'KNOWN_PREFIX';
    logger.info(
      `[supplier-canonical] routing ${pid} via S&S (${rule})${colorName ? ` colorName=${colorName}` : ''}`,
    );

    await throttle('ss');
    const auth = getSSAuth();
    const ssId = await resolveSSStyleId(pid, auth);
    if (ssId === null) return null;

    await throttle('ss');
    // Phase 17 17-02: also request colorName so we can filter per-color.
    const products = await ssGet<Array<{ colorName?: string; colorFrontImage?: string }>>(
      `/products/?style=${ssId}&fields=colorName,colorFrontImage`,
      auth,
    );
    if (!products || products.length === 0) return null;

    // Phase 17 17-02: per-color filter, with fallback to first front-image-
    // bearing variant. Only `colorFrontImage` is canonical (see JSDoc
    // T-16-side-trust caveat above — colorSideImage / colorDirectSideImage are
    // intentionally NOT read).
    let match: { colorName?: string; colorFrontImage?: string } | undefined;
    let wasFallback = false;

    if (colorName) {
      const target = colorName.toUpperCase().trim();
      match = products.find(
        (p) =>
          p.colorFrontImage &&
          String(p.colorName ?? '').toUpperCase().trim() === target,
      );
      if (!match) {
        wasFallback = true;
      }
    }
    // Fall back to first front-image-bearing variant (preserves Phase 16 default).
    if (!match) {
      match = products.find((p) => p.colorFrontImage);
    }
    if (!match || !match.colorFrontImage) return null;

    logger.info(
      `[supplier-canonical] S&S resolved ${pid}${colorName ? ` colorName=${colorName}` : ''}${wasFallback ? ' (fallback)' : ''} -> ${match.colorFrontImage}`,
    );

    return {
      url: makeSSLargeUrl(match.colorFrontImage),
      source: 'ss',
      styleId: ssId,
      ...(wasFallback ? { wasFallback: true } : {}),
    };
  }

  // CSW (Canada Sportswear)
  if (/^L/i.test(pid)) {
    await throttle('csw');
    const handle = await findCSWHandle(pid);
    if (!handle) return null;

    await throttle('csw');
    const product = await fetchCSWProduct(handle);
    if (!product || !product.images || product.images.length === 0) return null;

    // Phase 17 17-02: CSW best-effort filename-substring match. CSW does not
    // expose per-color metadata; filenames sometimes embed a color token
    // (e.g. `L00660-Black-front.jpg`). Slug = lowercase + trim + spaces→hyphens.
    let chosen: { src: string } | undefined;
    let wasFallback = false;

    if (colorName) {
      const colorSlug = colorName.toLowerCase().trim().replace(/\s+/g, '-');
      chosen = product.images.find((img) => {
        const filename = String(img.src.split('/').pop() ?? '').toLowerCase();
        return filename.includes(colorSlug);
      });
      if (!chosen) {
        wasFallback = true;
      }
    }
    if (!chosen) chosen = product.images[0];
    if (!chosen?.src) return null;

    logger.info(
      `[supplier-canonical] CSW resolved ${pid}${colorName ? ` colorName=${colorName}` : ''}${wasFallback ? ' (fallback)' : ''} -> ${chosen.src}`,
    );

    return {
      url: chosen.src,
      source: 'csw',
      styleId: handle,
      ...(wasFallback ? { wasFallback: true } : {}),
    };
  }

  // Truly unknown prefix (M786, NE220, anvil 9xx, QTB6000, etc.) — silent null.
  // Phase 17 17-04 dispatched the former KNOWN_SUPPLIER_PREFIXES allowlist
  // through the S&S branch above, so the legacy "D-12 expansion candidate" log
  // path is no longer reachable. Pids that fall through here are handled by
  // Plan 17-05 manual triage.
  return null;
}
