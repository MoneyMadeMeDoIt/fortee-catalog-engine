# Phase 10: AI Image Generation - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A callable `generateGarmentView(frontBuffer, view, garmentType, colorName)` function that uses OpenAI `images.edit()` to generate back and side garment views from a front image. Produces 3 candidates per view, picks the best via quality scoring, rejects color-drifted outputs, and retries once on failure. Also handles AI enhancement of failing front images. Includes cost tracking with a $200 global budget cap.

</domain>

<decisions>
## Implementation Decisions

### Prompt Design
- **D-01:** Use garment-type-aware prompts. Different prompt templates per garment category (t-shirt, hoodie, polo, etc.) using the existing template-map categories. Example: "Back view of this [navy blue] [t-shirt] on a plain white background, blank garment, no print, no model."
- **D-02:** Include the garment's color name in the prompt to help prevent color drift. Pull color from product data.

### Candidate Selection
- **D-03:** Generate 3 candidates per view. Pick the highest quality-scored candidate that passes the 15-degree hue drift check.
- **D-04:** If ALL 3 candidates fail (color drift or quality), retry once with an adjusted prompt (stronger color instruction). Max 6 API calls per view. If still all fail after retry, return the best of the 6 candidates regardless.

### Failed Front Image Handling
- **D-05:** AI-enhance the existing front image via `images.edit()` with a cleanup prompt (e.g., "Clean up this garment photo: remove blur, fix lighting, plain white background"). Use the real garment as reference — do not generate from scratch.

### Cost and Rate Limiting
- **D-06:** Per-product cap: max 6 API calls per view (3 initial + 3 retry). This is a hard limit.
- **D-07:** Global budget cap: $200 total across all products. Track cumulative cost per API call. Stop generating and report when budget is exhausted.
- **D-08:** Dry-run mode should estimate cost before actual generation (count views needing generation, multiply by estimated cost per view).

### Claude's Discretion
- Specific prompt wording per garment type (researcher should experiment)
- OpenAI model selection (gpt-image-1 vs dall-e-3 vs whatever is current)
- Image size/quality parameters for images.edit()
- Hue comparison algorithm implementation (HSL conversion approach)
- Rate limiting strategy (concurrent requests, delays between calls)
- Cost tracking storage mechanism (in-memory vs file)
- How to handle OpenAI API errors (timeout, rate limit, content policy rejection)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Image Pipeline (Phase 08-09)
- `src/shopify/image-scorer.ts` — `scoreImageQuality(buffer)` for candidate ranking. `QUALITY_THRESHOLDS` for calibrated values.
- `src/lib/image-sourcer.ts` — `sourceImages()` returns `SourcedView | null` per view. `null` = needs generation. Failed verdict = needs AI enhancement.
- `src/shopify/image-standardizer.ts` — `downloadImage(url)`, `detectGarmentBounds(buffer)`, `REFERENCE_RATIOS` for garment proportions.

### Garment Categories
- `src/shopify/template-map.ts` — Maps style IDs to garment categories. Use for garment-type-aware prompt selection.

### Types
- `src/shopify/types.ts` — `ImageQualityResult`, `ImageQualityDimensions`, `GarmentBounds` interfaces.
- `src/suppliers/types.ts` — `SupplierProduct` with product data including color info.

### Requirements
- `.planning/REQUIREMENTS.md` — AIGEN-01 through AIGEN-04 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scoreImageQuality(buffer)` — calibrated scorer for candidate ranking (Phase 08)
- `downloadImage(url)` — image buffer fetcher with 30s timeout
- `detectGarmentBounds(buffer)` — garment region extraction for hue comparison
- `template-map.ts` — garment category lookup for prompt templates
- `sharp` — already a dependency, useful for hue/color extraction

### Established Patterns
- Image processing uses `sharp` throughout
- Functions return typed results with structured error info
- Error handling: non-fatal with warnings, graceful fallbacks
- No OpenAI SDK in project yet — needs to be added as dependency

### Integration Points
- Phase 12 audit runner will call `generateGarmentView()` for views where sourcing returned null or failed quality
- Input: front image buffer + view type + garment metadata
- Output: generated image buffer that passes quality scoring

</code_context>

<specifics>
## Specific Ideas

- User wants a $200 global budget cap across all products — system must track cumulative API cost and stop when exhausted
- Retry with stronger color instruction on all-fail rounds (not just repeat the same prompt)
- AI enhancement for bad fronts uses the real image as input, not generation from scratch

</specifics>

<deferred>
## Deferred Ideas

- **Contextual on-model photos** (from Phase 08): Generate 1 on-model mannequin photo per product where the model is contextually appropriate to the garment type. Not in scope for Phase 10.

</deferred>

---

*Phase: 10-ai-image-generation*
*Context gathered: 2026-03-26*
