# Phase 09: Image Sourcing - Research

**Researched:** 2026-03-26
**Domain:** Multi-supplier image fetching with quality-score ranking
**Confidence:** HIGH

## Summary

Phase 09 implements `sourceImages(styleId)` by fetching front/back/side images from three suppliers simultaneously (OMG OneSource, S&S Canada REST API, CSW Shopify storefront), scoring each candidate with the existing `scoreImageQuality()`, and returning the best-scoring URL per view.

The critical discovery is that S&S Canada exposes two separate API surfaces: the OneSource PromoStandards SOAP endpoint (already used in `ss-canada.ts` for product data) and a distinct REST API at `api.ssactivewear.com` that returns `colorBackImage`/`colorSideImage` as relative paths. These require separate credentials — account number + API key — that are **not yet in the project `.env`**. Only `S&S_SUPPLIER_CODE` is currently set.

CSW (canadasportswear.com) is a Shopify storefront with product images at `//canadasportswear.com/cdn/shop/files/`. Investigation of the L00550 product page confirmed that **only front-view images are available** on the CSW website — filenames follow the pattern `{StyleNumber}-{Color}-front.jpg`. There are no back or side images accessible via scraping the CSW storefront.

**Primary recommendation:** Implement three independent fetcher functions returning `SourcedView | null` per view, merged via `Promise.allSettled` with quality-score winner selection. CSW is front-only; back/side must come from OMG OneSource classType IDs or S&S Canada REST API.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Fetch from ALL three suppliers in parallel (OMG, CSW, S&S Canada), not sequentially. Merge the best image per view (front/back/side) using quality scores. This replaces the simple fallback chain with a "try all, pick best" approach.
- **D-02:** Quality scoring via `scoreImageQuality()` (Phase 08) picks the winner per view. The highest-scoring candidate wins regardless of source.
- **D-03:** If a supplier image fails quality scoring, do NOT discard it. Flag it for AI enhancement (Phase 10) instead. A bad supplier image is still useful as input to AI enhancement. Only return `null` for a view if NO supplier has any image at all.
- **D-04:** `sourceImages()` returns `{ front: { url, score, verdict } | null, back: { url, score, verdict } | null, side: { url, score, verdict } | null }`. URLs + quality scores, not buffers. Downstream phases download as needed. Lighter weight.
- **D-05:** No caching of sourced URLs. Supplier APIs are fast and free. Re-fetch each time. No cache invalidation complexity.
- **D-06:** Return `null` for views where no supplier has an image. Clean contract: `null` means "needs AI generation" (Phase 10). No placeholders or stand-in images.

### Claude's Discretion
- How to identify image views (front/back/side) from supplier API responses that don't explicitly label them
- S&S Canada API field extraction approach for `colorBackImage`/`colorSideImage`
- CSW scraper strategy for additional image angles
- Error handling when individual supplier APIs fail (should not block other suppliers)
- Internal function decomposition (per-supplier fetcher functions vs monolithic)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SRC-01 | System fetches product images from OrderMyGear OneSource API as a sourcing channel | OMG OneSource `getMediaContent` already implemented; classType IDs 1006/1007/1008/1009/1010 identify views |
| SRC-02 | System re-fetches back and side images from S&S Canada API fields (colorBackImage, colorSideImage) | S&S Canada REST API (`api.ssactivewear.com/v2/products/?styleid=`) returns these fields; separate credentials needed |
| SRC-03 | System re-scrapes Canada Sportswear for additional image angles when available | CSW Shopify storefront confirmed front-only; only primary URL extraction from CDN is viable |
| SRC-04 | System implements a fallback chain (OMG → CSW → S&S → existing URL → AI generation) prioritizing cheapest sources first | Decided: parallel fetch + quality-score winner selection replaces sequential fallback |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-in `fetch` | Node 24.11.0 (native) | HTTP requests to supplier APIs | Already used throughout codebase; no extra deps |
| `sharp` | ^0.34.5 | Image buffer processing for quality scoring | Already in use; `scoreImageQuality()` requires Buffer input |
| `cheerio` | ^1.2.0 | XML/HTML parsing for OneSource SOAP + CSW HTML | Already used in `onesource-client.ts` and `ss-canada.ts` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `Promise.allSettled` | Built-in | Parallel supplier fetch with per-supplier failure isolation | All three supplier calls; do NOT use `Promise.all` (one failure would abort all) |
| `downloadImage(url)` | Internal (`image-standardizer.ts`) | Fetch image buffer from URL for scoring | Required before calling `scoreImageQuality(buffer)` |
| `scoreImageQuality(buffer)` | Internal (`image-scorer.ts`) | Quality score per candidate image | Returns `{ score, verdict, reasons }` — score is the ranking key |

**Installation:** No new packages required. All dependencies exist in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── lib/
│   └── image-sourcer.ts     # NEW — sourceImages() + per-supplier fetchers
├── suppliers/
│   └── ss-canada.ts         # EXTEND — add fetchSSImagesByStyle() using REST API
│   └── types.ts             # EXTEND — add ImageView type and SourcedView interface
└── shopify/
    └── image-scorer.ts      # EXISTING — scoreImageQuality(buffer) used as-is
    └── image-standardizer.ts # EXISTING — downloadImage(url) used as-is
```

### Pattern 1: Parallel Supplier Fetch with Promise.allSettled

**What:** Fire all three supplier fetch functions simultaneously. Collect results with `allSettled` so individual failures do not block the others. Map settled results to arrays of candidates per view.

**When to use:** Always — this is the mandated approach (D-01).

**Example:**
```typescript
// src/lib/image-sourcer.ts
import { downloadImage } from '../shopify/image-standardizer.js';
import { scoreImageQuality } from '../shopify/image-scorer.js';

export interface SourcedView {
  url: string;
  score: number;
  verdict: 'pass' | 'fail';
}

export interface SourcedImages {
  front: SourcedView | null;
  back: SourcedView | null;
  side: SourcedView | null;
}

export async function sourceImages(styleId: string): Promise<SourcedImages> {
  const [omgResult, cswResult, ssResult] = await Promise.allSettled([
    fetchOMGImages(styleId),
    fetchCSWImages(styleId),
    fetchSSCanadaImages(styleId),
  ]);

  const candidates = {
    front: [] as SourcedView[],
    back: [] as SourcedView[],
    side: [] as SourcedView[],
  };

  for (const result of [omgResult, cswResult, ssResult]) {
    if (result.status === 'fulfilled') {
      for (const [view, sourced] of Object.entries(result.value)) {
        if (sourced) candidates[view as keyof typeof candidates].push(sourced);
      }
    }
    // rejected: log warning, continue
  }

  return {
    front: pickBest(candidates.front),
    back: pickBest(candidates.back),
    side: pickBest(candidates.side),
  };
}

function pickBest(views: SourcedView[]): SourcedView | null {
  if (views.length === 0) return null;
  // Highest score wins; ties broken by first encountered (OMG inserted first)
  return views.reduce((a, b) => (b.score > a.score ? b : a));
}
```

### Pattern 2: Score-before-return (download only for scoring, return URL)

**What:** For each candidate URL, download the buffer, score it, then return only `{ url, score, verdict }` — not the buffer. Downstream phases re-download as needed (D-04).

**When to use:** Always — this is what `sourceImages()` must return.

**Example:**
```typescript
async function scoreUrl(url: string): Promise<SourcedView> {
  const buffer = await downloadImage(url);
  const result = await scoreImageQuality(buffer);
  return { url, score: result.score, verdict: result.verdict };
}
```

### Pattern 3: OMG OneSource View Identification via PromoStandards classTypeId

**What:** `parseMediaContentFromXml` already extracts `classTypes: Array<{ id: number; name: string }>`. Use classTypeId to identify view angle.

**PromoStandards Media Service 1.1.0 classType IDs (verified against docs.psrestful.com):**
| classTypeId | View |
|-------------|------|
| 1006 | Primary (treat as front if no 1007 present) |
| 1007 | Front |
| 1008 | Rear (back) |
| 1009 | Right side |
| 1010 | Left side |
| 1001 | Blank garment (usable as front if no 1007) |

**When to use:** In `fetchOMGImages()` when processing `parseMediaContentFromXml` results.

**Example:**
```typescript
function classifyView(classTypes: Array<{ id: number; name: string }>): 'front' | 'back' | 'side' | null {
  const ids = classTypes.map(c => c.id);
  if (ids.includes(1007)) return 'front';
  if (ids.includes(1006) || ids.includes(1001)) return 'front'; // fallback primary
  if (ids.includes(1008)) return 'back';
  if (ids.includes(1009) || ids.includes(1010)) return 'side';
  return null; // unknown — skip
}
```

### Pattern 4: S&S Canada REST API (separate from OneSource SOAP)

**What:** S&S Canada exposes a REST API at `api.ssactivewear.com/v2/` that returns `colorBackImage`, `colorSideImage`, `colorFrontImage` as relative image paths. This is separate from the OneSource SOAP endpoint already used.

**Authentication:** HTTP Basic Auth — Username = Account Number, Password = API Key.

**Image URL construction:** `https://www.ssactivewear.com/{relativePath}` — append `_fl` suffix variant for large images (replace `_fm` with `_fl`).

**Example:**
```typescript
async function fetchSSCanadaImages(styleId: string): Promise<Partial<Record<'front'|'back'|'side', SourcedView>>> {
  const accountNumber = process.env.SS_ACCOUNT_NUMBER;
  const apiKey = process.env.SS_API_KEY;
  if (!accountNumber || !apiKey) {
    logger.warn('S&S Canada REST credentials not set — skipping');
    return {};
  }

  const url = `https://api.ssactivewear.com/v2/products/?styleid=${encodeURIComponent(styleId)}&fields=colorFrontImage,colorBackImage,colorSideImage`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountNumber}:${apiKey}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) return {};

  const products = await response.json() as Array<{
    colorFrontImage?: string;
    colorBackImage?: string;
    colorSideImage?: string;
  }>;

  const first = products[0];
  if (!first) return {};

  const SS_BASE = 'https://www.ssactivewear.com/';
  const result: Partial<Record<'front'|'back'|'side', SourcedView>> = {};

  if (first.colorFrontImage) result.front = await scoreUrl(SS_BASE + first.colorFrontImage);
  if (first.colorBackImage) result.back = await scoreUrl(SS_BASE + first.colorBackImage);
  if (first.colorSideImage) result.side = await scoreUrl(SS_BASE + first.colorSideImage);

  return result;
}
```

### Pattern 5: CSW Front-Only via CDN URL Construction

**What:** canadasportswear.com is a Shopify storefront. Investigation confirmed only front-view images exist. The CDN naming convention is `{StyleNumber}-{Color}-front.jpg`. There is no programmatic way to discover the exact filename without fetching the product page HTML. Use `cheerio` to extract `og:image` or the first product image from the page.

**CSW product page URL:** `https://canadasportswear.com/products/{handle}` where handle is a slugified combination of style number and product name. **The handle cannot be reliably derived from styleId alone** — it includes the product name. Fetching the Shopify JSON endpoint is more reliable.

**Shopify JSON endpoint (no auth required):** `https://canadasportswear.com/products/{handle}.json` or use `https://canadasportswear.com/search?q={styleId}&type=product` to find the handle.

**Better approach — Shopify product search:**
```typescript
async function fetchCSWImages(styleId: string): Promise<Partial<Record<'front'|'back'|'side', SourcedView>>> {
  // CSW is front-only per confirmed investigation
  const searchUrl = `https://canadasportswear.com/search?q=${encodeURIComponent(styleId)}&type=product`;
  // Parse HTML for first og:image or product image
  // Return as 'front' only
}
```

### Anti-Patterns to Avoid

- **`Promise.all` for supplier fetch:** One failed supplier aborts the whole call. Always use `Promise.allSettled`.
- **Passing URLs directly to `scoreImageQuality`:** The scorer takes a Buffer. Call `downloadImage(url)` first.
- **Discarding failed-quality images:** D-03 requires returning them with their score and verdict. `pickBest` must return the best-scoring candidate regardless of verdict — even if all candidates fail, pick the best failing one.
- **Assuming classType is always present:** Some OMG media items have empty `classTypes` arrays. Handle gracefully with `null` classification → skip.
- **Blocking on S&S REST API when credentials missing:** Check env vars first, log warning, return `{}` if absent.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Parallel fetch with failure isolation | Custom try/catch loop over suppliers | `Promise.allSettled` | Built-in, semantically correct for "try all, continue on failure" |
| Image download with timeout | Custom fetch wrapper | `downloadImage(url)` from `image-standardizer.ts` | Already implemented with 30-second abort timeout |
| Quality ranking | Custom scoring heuristics | `scoreImageQuality(buffer)` from `image-scorer.ts` | Calibrated against 243 real images in Phase 08 |
| XML parsing | Custom XML parser | `parseMediaContentFromXml` + `findByLocal` from `onesource-client.ts` | Already handles namespace prefixes and error extraction |
| Base64 auth | Custom encoding | `Buffer.from('user:pass').toString('base64')` | Node built-in, one-liner |
| HTTP Basic Auth header | Custom auth middleware | Inline `Authorization` header in `fetch` options | S&S API is a simple REST GET, no middleware needed |

**Key insight:** The entire scoring and download infrastructure is already built in Phase 08. Phase 09 is primarily orchestration: call existing functions, collect results, pick winners.

## Common Pitfalls

### Pitfall 1: S&S Canada Has Two API Surfaces

**What goes wrong:** Developer assumes `ss-canada.ts` (which already calls OneSource) covers the `colorBackImage`/`colorSideImage` requirement. It does not. The OneSource SOAP API is used for product data (variants, specs). The REST API at `api.ssactivewear.com` is a separate endpoint that exposes per-color image URLs including back/side.

**Why it happens:** Both share "S&S Canada" branding but are different services with different auth.

**How to avoid:** `fetchSSCanadaImages()` must call `api.ssactivewear.com/v2/products/?styleid=`, not OneSource.

**Warning signs:** If back/side images look like OneSource media content (SOAP response), something is wrong.

### Pitfall 2: S&S Canada REST Credentials Not in .env

**What goes wrong:** `fetchSSCanadaImages()` silently returns `{}` because `SS_ACCOUNT_NUMBER` and `SS_API_KEY` are not set. Back/side images appear missing even though S&S has them.

**Why it happens:** Current `.env` only has `S&S_SUPPLIER_CODE` (used for OneSource supplier code). The REST API requires separate account number and API key.

**How to avoid:** Add required env vars to `.env` before testing. Add a startup check that warns (does not throw) if these are absent — graceful degradation is correct per D-01 (if one supplier fails, continue).

**Warning signs:** Phase 09 returns `null` for back/side even for styles S&S carries.

### Pitfall 3: CSW Has No Back or Side Images

**What goes wrong:** Building a CSW scraper that attempts to find back/side images returns nothing, wasting implementation time.

**Why it happens:** Expectation that SRC-03 means CSW has multiple angles. Investigation confirmed the CDN filenames always end in `-front.jpg`.

**How to avoid:** `fetchCSWImages()` should only ever return a `front` view. Return `{}` for back and side immediately.

**Warning signs:** `fetchCSWImages()` returning non-null `back` or `side` — indicates a bug.

### Pitfall 4: OMG OneSource Returns Multiple Images Per View

**What goes wrong:** Multiple media items have classTypeId 1007 (Front) for different colors. Without color filtering, the function may return a front image for the wrong color.

**Why it happens:** OneSource `getMediaContent` returns ALL colors' images for a style. The `color` field on each media item identifies which color it applies to.

**How to avoid:** When building the candidate list, prefer images whose `color` field matches the requested color (if color context is available), or accept the first valid match if no color specified. Document the current Phase 09 behavior — if `sourceImages(styleId)` doesn't take a `colorName` parameter, this ambiguity must be noted for Phase 12 integration.

**Warning signs:** Returned front image shows wrong color garment.

### Pitfall 5: pickBest Must Return Best Even If All Fail

**What goes wrong:** Filtering candidates to only `verdict === 'pass'` before calling `pickBest()` means failed-quality images are discarded rather than returned for AI enhancement.

**Why it happens:** Natural instinct is to only return "good" images.

**How to avoid:** `pickBest()` ranks ALL candidates by score and returns the highest regardless of verdict. D-03 is explicit: failed-quality images should be returned so Phase 10 can enhance them.

**Warning signs:** Returning `null` for a view when a supplier had an image (even a bad one).

### Pitfall 6: sharp extract+stats Chaining Bug (Known From Phase 08)

**What goes wrong:** Calling `.extract()` then `.stats()` in a chain on the same sharp instance evaluates stats on the original input, not the extracted region.

**Why it happens:** sharp's lazy evaluation pipeline quirk.

**How to avoid:** Always `.toBuffer()` after `.extract()`, then create a new `sharp(buf).stats()` call. This is already documented and handled in `image-scorer.ts`.

**Warning signs:** Score values identical regardless of region extracted.

## Code Examples

Verified patterns from existing codebase and official documentation:

### Promise.allSettled for Supplier Parallelism
```typescript
// Pattern already used in ss-canada.ts fetchProduct()
const [mediaImages, webSizeChart] = await Promise.all([...]);
// For suppliers where any can fail independently, use allSettled:
const [omgResult, cswResult, ssResult] = await Promise.allSettled([
  fetchOMGImages(styleId),
  fetchCSWImages(styleId),
  fetchSSCanadaImages(styleId),
]);
```

### S&S Canada REST API (verified from api.ssactivewear.com/V2/Products.aspx)
```typescript
// Full URL for style lookup:
// GET https://api.ssactivewear.com/v2/products/?styleid={styleId}
// Auth: Basic base64(accountNumber:apiKey)
// Response: array of product objects with:
//   colorFrontImage: "Images/Color/17130_fm.jpg"    <- relative path
//   colorBackImage:  "Images/Color/17130_b_fm.jpg"  <- relative path
//   colorSideImage:  "Images/Color/17130_s_fm.jpg"  <- relative path
// Full URL: "https://www.ssactivewear.com/" + relativePath
// Large version: replace "_fm" with "_fl"
```

### OMG OneSource classType IDs (verified from docs.psrestful.com)
```typescript
// classTypeId values for view identification:
const VIEW_CLASS_TYPES = {
  PRIMARY: 1006,
  FRONT: 1007,
  REAR: 1008,   // back view
  RIGHT: 1009,  // side view
  LEFT: 1010,   // side view
  BLANK: 1001,  // blank garment — usable as front
} as const;
```

### CSW Product Image (verified from canadasportswear.com)
```typescript
// CDN URL pattern (confirmed front-only):
// https://canadasportswear.com/cdn/shop/files/L00550-Black-front.jpg?v={version}
// Only 'front' view exists on CSW. No back or side images available.
```

### downloadImage + scoreImageQuality (from image-standardizer.ts and image-scorer.ts)
```typescript
// Source: src/shopify/image-standardizer.ts:230
// Source: src/shopify/image-scorer.ts:49
async function scoreUrl(url: string): Promise<SourcedView> {
  const buffer = await downloadImage(url);        // 30s timeout built-in
  const result = await scoreImageQuality(buffer); // returns { score, verdict, reasons }
  return { url, score: result.score, verdict: result.verdict };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Sequential fallback (OMG → CSW → S&S) | Parallel fetch all, pick best by score | Phase 09 decision (D-01) | Faster, surfaces best image regardless of source order |
| Discard low-quality images | Return with score+verdict for AI enhancement | Phase 09 decision (D-03) | Phase 10 can use imperfect images as AI input |
| Download buffers and pass downstream | Return URLs only, downstream re-downloads | Phase 09 decision (D-04) | Lighter memory, no buffer serialization between phases |

## Open Questions

1. **Color scoping for OMG OneSource media**
   - What we know: `getMediaContent(productId)` returns ALL colors. `color` field on each media item identifies the color.
   - What's unclear: Does `sourceImages(styleId)` need a `colorName` parameter to filter to the correct color's images? Phase 12 will call this per-product-per-color.
   - Recommendation: Add an optional `colorName?: string` parameter to `sourceImages()`. When provided, prefer media items where `color` field matches. When absent, return first valid match. Planner should decide whether Phase 09 adds this parameter or defers to Phase 12 to call with color context.

2. **S&S Canada REST API credential setup**
   - What we know: `.env` has `S&S_SUPPLIER_CODE` but not `SS_ACCOUNT_NUMBER` or `SS_API_KEY`.
   - What's unclear: Whether the user has REST API access credentials separate from OneSource credentials.
   - Recommendation: Phase 09 plan should include a Wave 0 task to verify credentials exist and add env var scaffolding. The fetcher must degrade gracefully if absent.

3. **CSW handle lookup reliability**
   - What we know: CSW uses Shopify with handle format `l0550-vault-adult-pullover-hooded-sweatshirt` (note: L00550 became "l0550"). Handle includes product name, not just style number.
   - What's unclear: Whether a consistent URL pattern allows style number → handle derivation, or whether an HTML search is required.
   - Recommendation: Use `https://canadasportswear.com/search?type=product&q={styleId}` and parse the first result link. This is robust to handle variations.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js native fetch | All HTTP requests | ✓ | Node 24.11.0 | — |
| sharp | `scoreImageQuality` buffer ops | ✓ | ^0.34.5 | — |
| cheerio | OneSource XML + CSW HTML | ✓ | ^1.2.0 | — |
| ONESOURCE_KEY_ID / ONESOURCE_KEY_PASSWORD | OMG OneSource fetch | ✓ | — (set in .env) | Graceful skip |
| CSW_SUPPLIER_CODE | OneSource CSW supplier code | ✓ | — (set in .env) | — |
| SS_ACCOUNT_NUMBER | S&S Canada REST API | ✗ | — | Graceful skip (warn + return {}) |
| SS_API_KEY | S&S Canada REST API | ✗ | — | Graceful skip (warn + return {}) |

**Missing dependencies with no fallback:**
- None that block execution — S&S REST credentials degrade gracefully per D-01.

**Missing dependencies with fallback:**
- `SS_ACCOUNT_NUMBER` / `SS_API_KEY` — S&S Canada back/side images unavailable until credentials added. `fetchSSCanadaImages()` must check, warn, and return `{}`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (vitest.config.ts) |
| Config file | vitest.config.ts (project root) |
| Quick run command | `npm run test -- tests/suppliers/image-sourcer.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SRC-01 | OMG media classType IDs map to correct views | unit | `npm run test -- tests/suppliers/image-sourcer.test.ts` | ❌ Wave 0 |
| SRC-02 | S&S Canada REST URL constructed correctly; missing creds degrade gracefully | unit | `npm run test -- tests/suppliers/image-sourcer.test.ts` | ❌ Wave 0 |
| SRC-03 | CSW returns front-only; null for back/side | unit | `npm run test -- tests/suppliers/image-sourcer.test.ts` | ❌ Wave 0 |
| SRC-04 | `pickBest()` selects highest score across suppliers; returns failed-quality when no pass | unit | `npm run test -- tests/suppliers/image-sourcer.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test -- tests/suppliers/image-sourcer.test.ts`
- **Per wave merge:** `npm run test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/suppliers/image-sourcer.test.ts` — covers SRC-01 through SRC-04 with mocked `downloadImage` and `scoreImageQuality`

## Sources

### Primary (HIGH confidence)
- `docs.psrestful.com/standards/media-content-1.1.0` — PromoStandards classTypeId values 1006-1010 for view classification
- `api.ssactivewear.com/V2/Products.aspx` — S&S Canada REST API field names, auth method, image URL construction
- `canadasportswear.com/products/l0550-vault-adult-pullover-hooded-sweatshirt` — CSW product page confirmed front-only images

### Secondary (MEDIUM confidence)
- `src/lib/onesource-client.ts` — `parseMediaContentFromXml` already extracts `classTypes` array; view classification just needs ID lookup
- `src/shopify/image-standardizer.ts` — `downloadImage(url)` with 30s timeout; used as-is
- `src/shopify/image-scorer.ts` — `scoreImageQuality(buffer)` returns `{ score, verdict, reasons }`

### Tertiary (LOW confidence)
- WebSearch result noting S&S REST API JSON includes `colorBackImage` as relative path — verified against official API docs page

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in project, versions verified via package.json
- Architecture: HIGH — PromoStandards classType IDs verified, S&S API docs confirmed, CSW investigation confirmed
- Pitfalls: HIGH for known items (S&S dual API, credentials gap, CSW front-only); MEDIUM for OMG color scoping (depends on Phase 12 requirements)

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (stable APIs; S&S REST API and PromoStandards classType IDs are versioned and stable)
