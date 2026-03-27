---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Phase complete — ready for verification
stopped_at: Completed 12-01-PLAN.md — auditProductImages pipeline implemented and tested
last_updated: "2026-03-27T00:27:35.505Z"
progress:
  total_phases: 6
  completed_phases: 5
  total_plans: 8
  completed_plans: 8
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Phase 12 — audit-runner

## Current Position

Phase: 12 (audit-runner) — EXECUTING
Plan: 1 of 1

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Key decisions for v2.0:

- Quality scorer operates on trimmed garment region (not full canvas) — mandatory to avoid false rejects on white-background images
- Supplier re-fetch before AI generation — OMG → CSW → S&S fallback chain exhausted before spending AI budget
- AI generation produces 3 candidates per view; quality scorer selects best — never auto-accept first output
- Use `productCreateMedia` / `productDeleteMedia` for surgical replacement — never re-push full `productSet` with images (destroys existing GIDs)
- Only new npm dependency: `openai` v6.33.0 — all other stack components exist in v1.0
- [Phase 08]: Blur detection uses 30%-inset garment region for monotonic stdev decay
- [Phase 08]: sharp extract().stats() chaining bug: always toBuffer() then stats() separately
- [Phase 08]: QUALITY_THRESHOLDS placeholders (BLUR_MIN_STDEV=20, PRINT_CENTER_STDEV=30) — calibrated in Plan 02
- [Phase 08-image-quality-scorer]: BLUR_MIN_STDEV set to 1.5 — calibrated against 243 real images (stdev range 1.1–20.0, mean 8.2); old value of 20.0 was rejecting 71% of normal supplier photos
- [Phase 08-image-quality-scorer]: WATERMARK_FULL_STDEV set to 120.0, PRINT_CENTER_STDEV to 100.0, SKIN_RATIO to 0.30 — all calibrated from real image data to eliminate false rejects
- [Phase 09]: pickBest returns best-scoring regardless of verdict — failed images retained for Phase 10 AI enhancement (D-03)
- [Phase 09]: colorName param threaded to fetchOMGImages for Phase 12 per-color image fetching
- [Phase 10-ai-image-generation]: sharp.stats().dominant bins colors in 4096-bin histogram; test assertions for dominant RGB must use range checks, not exact equality
- [Phase 10-ai-image-generation]: CostTracker.estimateCost(n) returns n * CANDIDATES_PER_CALL * COST_PER_IMAGE (D-08 minimum estimate, excludes retry cost)
- [Phase 10]: vitest 4.x clearAllMocks clears call history but NOT mockResolvedValueOnce queue; achromatic bypass test must not set candidate Once items since candidates skip extractDominantHue
- [Phase 10]: callImagesEdit uses optional client param for dependency injection; avoids mocking createOpenAIClient factory
- [Phase 11-image-standardization-safe-upload]: FIXED_GARMENT_HEIGHT_FRAC=0.85 replaces per-category REFERENCE_RATIOS in standardizeImage() — uniform 1700px garment height on 2000px canvas for all categories per D-01
- [Phase 11-image-standardization-safe-upload]: standardizeImagesToSheets() uses staged uploads for CDN URL generation only — no productCreateMedia or productSet calls (D-03: store images unchanged)
- [Phase 12-audit-runner]: sourceImages called once per product, not per view — source all missing/failing in a single batch to avoid redundant network calls
- [Phase 12-audit-runner]: CostTracker always injected into auditProductImages — never created internally to preserve shared budget across batch runs

### Pending Todos

None yet.

### Blockers/Concerns

- OMG API catalog access scope unknown — verify which CSW/S&S styles are accessible before building Phase 09 (flagged for research-phase)
- AI prompt quality uncertain for hoodies/polos/jackets — plan for 1-2 prompt refinement cycles in Phase 10 (flagged for research-phase)
- Print Area metaobject `media` field population status unconfirmed in v1.0 — verify before Phase 12 GID update logic (flagged for research-phase)

## Session Continuity

Last session: 2026-03-27T00:27:35.501Z
Stopped at: Completed 12-01-PLAN.md — auditProductImages pipeline implemented and tested
Resume file: None
