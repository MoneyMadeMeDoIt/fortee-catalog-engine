---
phase: 04-shopify-product-push
plan: 01
subsystem: shopify
tags: [shopify, graphql, variants, metafields, print-areas, template-map, category-map]

# Dependency graph
requires:
  - phase: 03-decoration-pricing
    provides: "GarmentCategory type, category-map, decoration rules"
provides:
  - "3-option variant builder (Color x Size x # of Print Areas) with variant metafields"
  - "Category-based print area coordinates (tops vs hoodies)"
  - "Simplified template mapping (all supported -> quick-order)"
  - "Crewneck as new GarmentCategory with aliases"
  - "MetafieldInput, StagedUploadInput, StagedTarget, CategoryGroup types"
  - "METAOBJECT_BY_HANDLE query and STAGED_UPLOADS_CREATE mutation"
affects: [04-02, 04-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [variant-doubling, category-group-mapping, alt-text-contract]

key-files:
  created: []
  modified:
    - src/shopify/variants.ts
    - src/shopify/types.ts
    - src/shopify/mutations.ts
    - src/shopify/template-map.ts
    - src/shopify/product-push.ts
    - src/decoration/types.ts
    - src/decoration/category-map.ts
    - tests/shopify/variants.test.ts
    - tests/shopify/handles.test.ts
    - tests/shopify/template-map.test.ts
    - tests/shopify/product-push.test.ts

key-decisions:
  - "Crewneck added as standalone GarmentCategory (not alias of existing type)"
  - "getCategoryGroup returns null for unsupported categories (Cap, Beanie, etc.)"
  - "Same SKU for both 1-area and 2-area variants of same Color/Size combo"
  - "Front/Back image alt text uses exact strings 'Front Print'/'Back Print' matching print area keys"

patterns-established:
  - "Variant doubling: each sheet row produces 2 Shopify variants (1-area + 2-area)"
  - "Category group mapping: supported categories -> tops/hoodies for coordinate lookup"
  - "Alt text contract: Front Print / Back Print must match print_area_position JSON keys"

requirements-completed: [SHOP-01, SHOP-02, SHOP-06, SHOP-07]

# Metrics
duration: 4min
completed: 2026-03-09
---

# Phase 4 Plan 01: Shopify Foundation Rework Summary

**3-option variant builder with category-based print_area_position metafields, simplified quick-order template, and Crewneck category support**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-09T13:49:56Z
- **Completed:** 2026-03-09T13:53:54Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Reworked variant builder to produce 2 variants per row (1-area and 2-area) with 3 option values each
- Added variant-level print_area_position metafield with category-based JSON coordinates (tops vs hoodies)
- Simplified template-map to return 'quick-order' for all 4 supported categories
- Added Crewneck as new GarmentCategory with crewneck/crewnecks aliases
- Updated types with MetafieldInput, StagedUploadInput, StagedTarget, CategoryGroup
- Added METAOBJECT_BY_HANDLE query and increased variant response limit to 250

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Update types, mutations, template-map, and category-map**
   - `70ea8ea` (test) - Failing tests for template-map and Crewneck
   - `adc2be2` (feat) - Types, mutations, template-map, category-map implementation
2. **Task 2: Rework variant builder with 3-option support and metafields**
   - `51fec45` (test) - Failing tests for variants and handles
   - `5f752dc` (feat) - Variant builder rework with metafields
   - `4a8d2d3` (fix) - Product-push compatibility update

## Files Created/Modified
- `src/shopify/variants.ts` - 3-option variant builder with PRINT_AREA_COORDINATES, getCategoryGroup, buildVariants, buildFiles
- `src/shopify/types.ts` - Added MetafieldInput, StagedUploadInput, StagedTarget, CategoryGroup
- `src/shopify/mutations.ts` - Added METAOBJECT_BY_HANDLE query, variants(first: 250)
- `src/shopify/template-map.ts` - Simplified to Set-based quick-order for 4 categories
- `src/shopify/product-push.ts` - Updated to pass categoryGroup to buildVariants, added 3rd option
- `src/decoration/types.ts` - Added Crewneck to GarmentCategory union
- `src/decoration/category-map.ts` - Added crewneck/crewnecks aliases
- `tests/shopify/variants.test.ts` - 22 tests for 3-option variants
- `tests/shopify/handles.test.ts` - 7 tests for handle generation
- `tests/shopify/template-map.test.ts` - 9 tests for quick-order template
- `tests/shopify/product-push.test.ts` - Updated 2 tests for new variant count and template

## Decisions Made
- Crewneck is a standalone GarmentCategory value (not an alias of Hoodie or other type), maps to 'tops' group for coordinates
- getCategoryGroup returns null for unsupported categories, enabling early filtering in the push pipeline
- Both 1-area and 2-area variants share the same SKU (ProductId-Color-Size) per user decision
- Front/Back image alt text uses exact "Front Print"/"Back Print" strings to match print_area_position JSON keys and metaobject display names

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated product-push.ts for new buildVariants signature**
- **Found during:** Task 2 (overall verification)
- **Issue:** buildVariants changed from 1 arg to 2 args, breaking product-push.ts and its tests
- **Fix:** Added categoryGroup parameter, updated productOptions to include 3rd option, updated 2 failing tests
- **Files modified:** src/shopify/product-push.ts, tests/shopify/product-push.test.ts
- **Verification:** All 75 shopify tests pass
- **Committed in:** 4a8d2d3

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary fix for breaking change in buildVariants signature. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All pure-function builders updated for old store format
- Variant builder, types, mutations, and template-map ready for plan 03 orchestrator
- 75 tests passing across all shopify test files

## Self-Check: PASSED

All 11 files verified present. All 5 commits verified in git log.

---
*Phase: 04-shopify-product-push*
*Completed: 2026-03-09*
