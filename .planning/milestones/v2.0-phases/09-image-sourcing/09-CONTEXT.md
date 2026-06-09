# Phase 09: Image Sourcing - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A callable `sourceImages(styleId)` function that fetches front, back, and side product images from all three supplier APIs (OMG OneSource, CSW, S&S Canada) in parallel, scores each candidate with `scoreImageQuality()`, and returns the best image per view. Failed-quality images are flagged for AI enhancement rather than discarded.

</domain>

<decisions>
## Implementation Decisions

### Sourcing Strategy
- **D-01:** Fetch from ALL three suppliers in parallel (OMG, CSW, S&S Canada), not sequentially. Merge the best image per view (front/back/side) using quality scores. This replaces the simple fallback chain with a "try all, pick best" approach.
- **D-02:** Quality scoring via `scoreImageQuality()` (Phase 08) picks the winner per view. The highest-scoring candidate wins regardless of source.

### Quality Gating
- **D-03:** If a supplier image fails quality scoring, do NOT discard it. Flag it for AI enhancement (Phase 10) instead. A bad supplier image is still useful as input to AI enhancement. Only return `null` for a view if NO supplier has any image at all.

### Output Shape
- **D-04:** `sourceImages()` returns `{ front: { url, score, verdict } | null, back: { url, score, verdict } | null, side: { url, score, verdict } | null }`. URLs + quality scores, not buffers. Downstream phases download as needed. Lighter weight.
- **D-05:** No caching of sourced URLs. Supplier APIs are fast and free. Re-fetch each time. No cache invalidation complexity.

### Missing View Handling
- **D-06:** Return `null` for views where no supplier has an image. Clean contract: `null` means "needs AI generation" (Phase 10). No placeholders or stand-in images.

### Claude's Discretion
- How to identify image views (front/back/side) from supplier API responses that don't explicitly label them
- S&S Canada API field extraction approach for `colorBackImage`/`colorSideImage`
- CSW scraper strategy for additional image angles
- Error handling when individual supplier APIs fail (should not block other suppliers)
- Internal function decomposition (per-supplier fetcher functions vs monolithic)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Supplier Clients
- `src/lib/onesource-client.ts` — OMG OneSource API client. Already fetches `primaryImageUrl` and media images. Extend to identify front/back/side views.
- `src/suppliers/canada-sportswear.ts` — Maps OneSource products to `SupplierProduct` with images array. Already extracts `primaryImageUrl` and media content.
- `src/suppliers/ss-canada.ts` — S&S Canada API client. Needs `colorBackImage`/`colorSideImage` field extraction added.
- `src/suppliers/types.ts` — `SupplierProduct` and `ProductImage` interfaces. May need view-type field.

### Image Pipeline (from Phase 08)
- `src/shopify/image-scorer.ts` — `scoreImageQuality(buffer)` and `QUALITY_THRESHOLDS`. Used to pick best candidate per view.
- `src/shopify/image-standardizer.ts` — `downloadImage(url)` for fetching image buffers. `detectGarmentBounds()` used internally by scorer.

### Existing Image Mapping
- `src/sheets/column-map.ts` — `BackImage` and `DirectSideImage` column mappings show how views are currently tracked
- `src/shopify/product-push.ts` — Lines 121-122 show how back/side URLs flow to Shopify upload

### Requirements
- `.planning/REQUIREMENTS.md` -- SRC-01 through SRC-04 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `onesource-client.ts` — Full OneSource API client with product fetch, media content extraction. Already handles pagination and XML parsing.
- `canada-sportswear.ts` — `mapOneSourceProductToSupplierProduct()` maps OMG data to the common `SupplierProduct` type. Image URL extraction already works for primary + media images.
- `ss-canada.ts` — S&S Canada client exists. Currently does NOT extract `colorBackImage`/`colorSideImage` — these fields need to be added.
- `image-scorer.ts` — `scoreImageQuality(buffer)` with calibrated thresholds. Ready to use for candidate ranking.
- `image-standardizer.ts` — `downloadImage(url)` utility for fetching image buffers from URLs.

### Established Patterns
- Supplier clients implement the `SupplierSource` interface from `types.ts`
- Products use the `SupplierProduct` type with `images: ProductImage[]` array
- Image processing uses `sharp` throughout
- Error handling: non-fatal with warnings, graceful fallbacks

### Integration Points
- `sourceImages()` will be called by Phase 12 audit runner as the first step in the image pipeline
- Phase 10 AI generation receives `null` views or failed-quality views from this function
- The existing sheet-based `BackImage`/`DirectSideImage` columns become the "existing sheet URL" fallback

</code_context>

<specifics>
## Specific Ideas

- User wants AI enhancement for failed-quality supplier images rather than discarding them — this means the output should distinguish between "no image found" (null) and "image found but failed quality" (url + failing score + verdict)
- Parallel fetching from all 3 suppliers simultaneously for fastest results

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-image-sourcing*
*Context gathered: 2026-03-26*
