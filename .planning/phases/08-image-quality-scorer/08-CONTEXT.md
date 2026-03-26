# Phase 08: Image Quality Scorer - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A callable `scoreImageQuality(buffer)` function that evaluates image quality across multiple dimensions — blur, resolution, garment proportion, and mockup suitability — returning a structured result with numeric score, pass/fail verdict, and descriptive reasons. The scorer operates on the trimmed garment region (not full white canvas) using the existing `detectGarmentBounds()` pipeline.

</domain>

<decisions>
## Implementation Decisions

### Score Output Shape
- **D-01:** Function returns a structured result with: numeric quality score (0-100), pass/fail verdict, array of reason strings, and per-dimension sub-scores (blur, resolution, proportion, content). Numeric score is required for Phase 10 comparative ranking (pick best of 3 AI candidates). Pass/fail verdict is required for Phase 12 pipeline gating.

### Quality Dimensions
- **D-02:** Scorer checks for blur (Laplacian variance on trimmed garment region), resolution (minimum pixel dimensions after trim), garment proportion (garment-to-canvas ratio vs target range), and content suitability (QUAL-04 checks below).
- **D-03:** Content suitability checks flag these as `fail` with descriptive reason:
  - Garments with existing prints/logos (high-frequency content in garment center region)
  - Watermarked images (repeating text/pattern overlay detection)
  - On-model photos (skin-tone pixel ratio heuristic)
  - Non-white backgrounds (background color deviation from white)

### Calibration Approach
- **D-04:** Calibration uses auto-fetched images from existing Shopify products (~50-60 images). A calibration script fetches, scores, and outputs a report. User reviews the report and flags wrong verdicts (false rejects/passes). Thresholds are adjusted iteratively until false-reject rate on known-good samples falls below 5%.

### Proportion Criteria
- **D-05:** Garment proportion check uses existing `REFERENCE_RATIOS` (73% height for tops, 78% for hoodies) as targets. Tolerance band determined during calibration. Images where garment is significantly smaller or larger than target range receive a `fail` verdict with proportion reason.

### Claude's Discretion
- Specific blur threshold values (Laplacian variance cutoff) — determined during calibration
- Resolution minimum pixel dimensions — determined during calibration
- Watermark detection algorithm choice (frequency domain vs template matching)
- On-model detection heuristic tuning
- Background whiteness threshold value
- Internal function decomposition and module structure

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Image Pipeline
- `src/shopify/image-standardizer.ts` — Contains `detectGarmentBounds()` (trim-based garment detection), `placeGarmentOnCanvas()`, `REFERENCE_RATIOS`, and `GARMENT_RELATIVE_PRINT_FRACTIONS`. Scorer MUST reuse `detectGarmentBounds()` for trimmed region analysis.
- `src/shopify/types.ts` — `GarmentBounds` type definition used by garment detection

### Requirements
- `.planning/REQUIREMENTS.md` §Image Quality Assessment — QUAL-01 through QUAL-05 requirements

### Dependencies
- `src/lib/logger.ts` — Existing logger utility for consistent log output

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `detectGarmentBounds(buffer)` in `image-standardizer.ts` — Returns `GarmentBounds` with offset, dimensions, and original size. Already handles trim failures gracefully. Scorer should use this to isolate garment region before analysis.
- `REFERENCE_RATIOS` in `image-standardizer.ts` — Target garment-to-canvas height fractions (0.73 tops, 0.78 hoodies). Proportion check can compare against these.
- `sharp` library — Already a project dependency. Provides all needed image analysis primitives (stats, metadata, raw pixel access).
- `logger` in `src/lib/logger.ts` — Consistent logging utility.

### Established Patterns
- Image processing uses `sharp` throughout — no other image libraries in the stack
- Functions return typed results (Zod-validated where external, plain TS interfaces for internal)
- Error handling: non-fatal with warnings (e.g., `detectGarmentBounds` falls back to full bounds on trim failure)

### Integration Points
- Phase 10 will call `scoreImageQuality()` to rank AI-generated candidates — needs numeric score for comparison
- Phase 12 audit runner will call `scoreImageQuality()` for pass/fail gating — needs verdict + reasons for logging
- New file likely at `src/shopify/image-scorer.ts` or `src/image/scorer.ts` — follows existing module organization

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for blur detection (Laplacian variance), resolution checking, and content analysis heuristics.

</specifics>

<deferred>
## Deferred Ideas

- **Contextual on-model photos**: Generate 1 on-model mannequin photo per product where the model is contextually appropriate to the garment type (e.g., construction vest → construction worker, chef coat → chef). This is a new image generation capability beyond quality scoring — belongs in a future phase after Phase 10 (AI Image Generation).

</deferred>

---

*Phase: 08-image-quality-scorer*
*Context gathered: 2026-03-26*
