# Phase 12: Audit Runner - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

A single `auditProductImages(styleID)` function that orchestrates the complete per-product image pipeline: score existing images → source replacements for missing/failed views → AI-generate remaining gaps → standardize all to 85% uniform scale → write CDN URLs to Google Sheets. Each step is logged with a structured per-product audit report.

This is pure orchestration — wiring Phase 08-11 functions together. No new image processing logic.

</domain>

<decisions>
## Implementation Decisions

### Pipeline Flow
- **D-01:** Linear pipeline: Score → Source all missing/failed → Generate remaining → Standardize → Write to sheets. Not per-view, not batch — one product flows through the full pipeline sequentially.
- **D-02:** Always re-standardize to 85% uniform scale, even if all views pass quality scoring. Existing images may not be at the correct scale. The runner ensures every product ends up standardized in sheets.
- **D-03:** For views that pass quality scoring AND already have an image, still standardize but don't source or generate. Only source/generate for missing or failing views.

### Output Target
- **D-04:** Write to Google Sheets only (no Shopify uploads). Inherits D-03 from Phase 11 — the user's store images must not be changed.

### Claude's Discretion
- Logging format and structure (structured JSON recommended per product)
- How to fetch existing product images for scoring (from current sheet URLs or from Shopify media query)
- Error handling when individual pipeline steps fail (skip view, skip product, or abort)
- Whether to return a summary object from auditProductImages()
- How to wire the CostTracker ($200 budget) across multiple product audits
- Internal function decomposition

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 08 — Image Quality Scorer
- `src/shopify/image-scorer.ts` — `scoreImageQuality(buffer)` returns `ImageQualityResult` with score/verdict/reasons

### Phase 09 — Image Sourcing
- `src/lib/image-sourcer.ts` — `sourceImages(styleId)` returns `SourcedImages` with front/back/side `SourcedView | null`

### Phase 10 — AI Image Generation
- `src/lib/ai-image-generator.ts` — `generateGarmentView(frontBuffer, view, garmentType, colorName)` and `enhanceFrontImage(frontBuffer)`
- `src/lib/cost-tracker.ts` — `CostTracker` class for $200 budget enforcement

### Phase 11 — Image Standardization
- `src/shopify/image-standardizer.ts` — `standardizeImagesToSheets()`, `standardizeImage()`, `downloadImage()`, `uploadStagedImage()`

### Supporting
- `src/shopify/template-map.ts` — garment category lookup for prompt templates
- `src/sheets/` — Google Sheets integration for writing updates
- `src/lib/logger.ts` — structured logging utility

### Requirements
- `.planning/REQUIREMENTS.md` — Phase 12 has no new requirements (integration phase wiring QUAL, SRC, AIGEN, STD, OUT)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scoreImageQuality(buffer)` — calibrated scorer (Phase 08)
- `sourceImages(styleId)` — parallel supplier fetch with quality-scored merge (Phase 09)
- `generateGarmentView()` / `enhanceFrontImage()` — OpenAI generation with retry + budget (Phase 10)
- `standardizeImagesToSheets()` — standardize + CDN URL + sheets write (Phase 11)
- `downloadImage(url)` — fetch image buffer from URL
- `CostTracker` — $200 budget tracking across products

### Established Patterns
- All image functions accept/return Buffers
- Error handling: non-fatal with warnings, graceful fallbacks
- Functions return typed result objects

### Integration Points
- Phase 13 CLI will call `auditProductImages()` with a style ID
- CostTracker must be shared across all products in a batch run (not per-product)

</code_context>

<specifics>
## Specific Ideas

- The runner is the "glue" — it calls existing functions in sequence, decides what to do based on scoring results, and logs everything
- CostTracker should be passed in (not created internally) so batch runs share one budget
- Each product audit should produce a structured result showing what happened per view

</specifics>

<deferred>
## Deferred Ideas

- **Shopify GID-based media replacement** (from Phase 11) — still deferred
- **Contextual on-model photos** (from Phase 08) — still deferred

</deferred>

---

*Phase: 12-audit-runner*
*Context gathered: 2026-03-27*
