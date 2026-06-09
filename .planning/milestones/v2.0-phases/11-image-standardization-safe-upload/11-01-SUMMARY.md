---
phase: 11-image-standardization-safe-upload
plan: 01
subsystem: image-processing
tags: [sharp, image-standardization, garment-detection, tdd]

# Dependency graph
requires: []
provides:
  - "FIXED_GARMENT_HEIGHT_FRAC=0.85 and FIXED_TOP_OFFSET_FRAC=0.075 constants exported from image-standardizer.ts"
  - "standardizeImage() uses uniform 85% garment height regardless of category (D-01)"
  - "REFERENCE_RATIOS deprecated but preserved for image-scorer.ts backward compat"
  - "Overflow assertion guarding top+height > canvasSize"
affects:
  - "11-02 — safe upload pipeline uses standardized sizing from this plan"
  - "image-scorer.ts — imports REFERENCE_RATIOS (still works, backward compat maintained)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed constants over per-category lookup tables for uniform visual scale"
    - "Overflow guard assertion after computing placement dimensions"
    - "TDD red-green cycle: failing tests committed before implementation"

key-files:
  created: []
  modified:
    - src/shopify/image-standardizer.ts
    - tests/shopify/image-standardizer.test.ts

key-decisions:
  - "FIXED_GARMENT_HEIGHT_FRAC=0.85 (1700px on 2000px canvas) — single uniform height for all categories per D-01"
  - "FIXED_TOP_OFFSET_FRAC=0.075 (150px top, 150px bottom) — equal whitespace above and below garment"
  - "categoryGroup parameter retained in standardizeImage() signature — still needed by derivePrintAreaCoords via processProductImages"
  - "REFERENCE_RATIOS kept as deprecated export — image-scorer.ts checkProportion() imports it; removing would break scorer"

patterns-established:
  - "Fixed sizing constants: prefer exported numeric constants over map lookups for uniform behavior across categories"
  - "Overflow assertion pattern: validate top+height <= canvasSize immediately after computing placement"

requirements-completed: [STD-01]

# Metrics
duration: 10min
completed: 2026-03-26
---

# Phase 11 Plan 01: Image Standardizer Fixed Height Refactor Summary

**Replaced per-category REFERENCE_RATIOS sizing in standardizeImage() with FIXED_GARMENT_HEIGHT_FRAC=0.85 constants, ensuring all garments render at 1700px height on 2000x2000 canvas regardless of category**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-03-26T23:53:00Z
- **Completed:** 2026-03-26T23:56:00Z
- **Tasks:** 1 (TDD: RED then GREEN)
- **Files modified:** 2

## Accomplishments

- Added `FIXED_GARMENT_HEIGHT_FRAC = 0.85` and `FIXED_TOP_OFFSET_FRAC = 0.075` as exported constants
- Replaced category-based `REFERENCE_RATIOS[categoryGroup]` lookup inside `standardizeImage()` with fixed constants
- Added overflow assertion: throws if `top + height > canvasSize`
- Deprecated `REFERENCE_RATIOS` with JSDoc comment while preserving its export for image-scorer.ts
- Added 4 new tests: 85% height target, 150px top offset, uniform scale across categories, constant values
- Updated `placeGarmentOnCanvas` test values from (1460, 120) to (1700, 150)
- All 23 image-standardizer tests pass; all 9 image-scorer tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add fixed garment constants and refactor standardizeImage()** - `8f296d3` (feat)

**Plan metadata:** _(docs commit — see below)_

## Files Created/Modified

- `src/shopify/image-standardizer.ts` — Added FIXED_GARMENT_HEIGHT_FRAC/FIXED_TOP_OFFSET_FRAC constants, refactored standardizeImage() to use them, added overflow assertion, deprecated REFERENCE_RATIOS
- `tests/shopify/image-standardizer.test.ts` — Added new constant exports import, 4 new test cases verifying fixed 85% behavior, updated placeGarmentOnCanvas test values

## Decisions Made

- `categoryGroup` parameter kept in `standardizeImage()` signature even though it no longer affects sizing — `processProductImages()` still passes it to `derivePrintAreaCoords()`, so removing it would break the caller signature
- `REFERENCE_RATIOS` kept as deprecated export — `image-scorer.ts` imports it directly; deleting would break scorer tests and production scoring logic

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all behavior is fully wired. `standardizeImage()` returns real computed placement values.

## Next Phase Readiness

- Fixed-height standardization complete and tested; ready for Phase 11 Plan 02 (safe upload pipeline)
- `image-scorer.ts` backward compatibility confirmed (all 9 scorer tests pass)
- No blockers

---
*Phase: 11-image-standardization-safe-upload*
*Completed: 2026-03-26*
