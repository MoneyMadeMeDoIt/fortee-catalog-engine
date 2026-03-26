# Phase 11: Image Standardization & Safe Upload - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Update `standardizeImage()` to use a single fixed garment proportion (85% max height) instead of per-category ratios, ensuring all products appear at the same visual scale on a 2000x2000px canvas. Standardized images are written back to Google Sheets only — NO Shopify uploads in this phase. The existing product push flow handles Shopify upload separately when the user is ready.

**Important scope change from ROADMAP:** The roadmap mentions "uploaded to Shopify by merging with existing media GIDs." Per user decision, this phase does NOT upload to Shopify. It standardizes images and updates Google Sheets URLs. The Shopify GID-based upload is deferred.

</domain>

<decisions>
## Implementation Decisions

### Uniform Garment Scale
- **D-01:** Replace per-category `REFERENCE_RATIOS` (73% tops, 78% hoodies) with a single universal target: 85% max height. Every garment, regardless of type, occupies the same vertical space (1700px on 2000x2000 canvas).
- **D-02:** Canvas size remains 2000x2000px. Output format is PNG (lossless, matching existing pipeline).

### Upload Strategy
- **D-03:** Do NOT upload to Shopify in this phase. Only update image URLs in Google Sheets with standardized images. The user's existing store images must not be changed.
- **D-04:** Standardized images should be hosted somewhere accessible by URL (e.g., uploaded to Shopify's staged uploads for URL generation, but NOT attached to products). Or stored locally and referenced by path.

### Image Format
- **D-05:** Output as PNG (lossless). Matches existing pipeline. No format change needed.

### Claude's Discretion
- How to update `standardizeImage()` to use fixed 85% target instead of per-category ratios (refactor approach)
- Whether to keep `REFERENCE_RATIOS` for backward compatibility or remove entirely
- Storage/hosting mechanism for standardized images (local files, staged uploads for URLs, etc.)
- How to update Google Sheets with new image URLs
- Error handling for images that fail standardization

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Image Pipeline
- `src/shopify/image-standardizer.ts` — Contains `standardizeImage()`, `placeGarmentOnCanvas()`, `detectGarmentBounds()`, `REFERENCE_RATIOS`, and `processProductImages()`. This is the PRIMARY file being modified.
- `src/shopify/image-scorer.ts` — `scoreImageQuality(buffer)` for validating standardized output quality.
- `src/shopify/mutations.ts` — `STAGED_UPLOADS_CREATE` mutation (may be used for URL generation only).

### Upstream Phases
- `src/lib/image-sourcer.ts` — `sourceImages()` returns `SourcedView | null` per view (Phase 09).
- `src/lib/ai-image-generator.ts` — `generateGarmentView()` and `enhanceFrontImage()` (Phase 10).

### Google Sheets Integration
- `src/sheets/` — Existing sheets integration. `column-map.ts` has `BackImage` and `DirectSideImage` mappings.

### Requirements
- `.planning/REQUIREMENTS.md` — STD-01, STD-02, OUT-02

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `standardizeImage(buffer, categoryGroup)` — already does trim → place → canvas. Needs 85% fixed target instead of per-category ratios.
- `placeGarmentOnCanvas(garmentBuffer, targetHeight, topOffset, canvasSize)` — generic placement function, reusable as-is.
- `detectGarmentBounds(buffer)` — garment region extraction, reusable as-is.
- `processProductImages()` — orchestrates standardization + upload. Needs modification to write to sheets instead of Shopify.
- `stagedUploadsCreate` mutation — could be used to generate hosted URLs for standardized images without attaching to products.

### Established Patterns
- Image processing uses `sharp` throughout — 2000x2000 canvas, PNG output
- `REFERENCE_RATIOS` used by both `standardizeImage()` and `image-scorer.ts` (proportion check)
- Existing tests in `tests/shopify/image-standardizer.test.ts` cover the current pipeline

### Integration Points
- Phase 12 audit runner will call the standardization function as part of the end-to-end pipeline
- Google Sheets columns `BackImage` and `DirectSideImage` need to be updated with standardized image URLs

</code_context>

<specifics>
## Specific Ideas

- User explicitly said "please don't change my store images, only change the images in the Google Sheets"
- Alt text cannot be changed for existing Shopify images — this ruled out alt-text-based view matching
- The 85% target replaces ALL category-specific ratios — one size fits all

</specifics>

<deferred>
## Deferred Ideas

- **Shopify GID-based media replacement** — Originally in this phase's roadmap scope but deferred per user decision. When the user is ready to update Shopify product images, this should be implemented with position-based view matching (1st=front, 2nd=back, 3rd=side).
- **Contextual on-model photos** (from Phase 08) — Still deferred.

</deferred>

---

*Phase: 11-image-standardization-safe-upload*
*Context gathered: 2026-03-26*
