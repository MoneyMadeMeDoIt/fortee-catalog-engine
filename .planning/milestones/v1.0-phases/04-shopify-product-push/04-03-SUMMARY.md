---
phase: 04-shopify-product-push
plan: 03
subsystem: api
tags: [shopify, graphql, metaobjects, product-push, metafields, print-areas]

requires:
  - phase: 04-shopify-product-push/01
    provides: "Variant builder, template map, mutations, types"
  - phase: 04-shopify-product-push/02
    provides: "Image standardizer with staged uploads"
provides:
  - "pushProduct orchestrator wiring all foundation modules into complete push pipeline"
  - "getExistingPrintAreaGids for looking up front-dtf and back-print metaobjects"
  - "buildProductSetInput with category gating and files parameter"
  - "Product-level metafields: Print Areas (metaobject refs) and Minimum Order Quantity"
  - "Variant-level print_area_position metafield via productSet"
  - "setupVariantMetafieldDefinition and setupMinOrderQtyMetafieldDefinition"
affects: [04-shopify-product-push]

tech-stack:
  added: []
  patterns: ["metaobject lookup by handle (not creation)", "null-return pattern for unsupported categories"]

key-files:
  created: []
  modified:
    - src/shopify/metaobjects.ts
    - src/shopify/product-push.ts
    - src/shopify/metaobject-setup.ts
    - src/shopify/index.ts
    - scripts/push-product.ts
    - tests/shopify/metaobjects.test.ts
    - tests/shopify/product-push.test.ts

key-decisions:
  - "Metaobjects looked up by handle (front-dtf, back-print) instead of created per-push"
  - "buildProductSetInput returns null for unsupported categories instead of throwing"
  - "Print Areas and MOQ set via separate metafieldsSet call after productSet"
  - "setupPrintAreaDefinitions now also creates print_area_position and minimum_order_quantity definitions"

patterns-established:
  - "Null-return pattern: buildProductSetInput returns null for unsupported categories, pushProduct throws"
  - "Metaobject lookup pattern: getExistingPrintAreaGids queries by handle, throws if missing"

requirements-completed: [SHOP-01, SHOP-02, SHOP-03, SHOP-04, SHOP-05, SHOP-06, SHOP-07]

duration: 4min
completed: 2026-03-09
---

# Phase 4 Plan 3: Product Push Orchestrator Summary

**pushProduct wires variant builder, image standardizer, and metaobject lookup into complete Shopify push pipeline with 3-option products, print area metafields, and MOQ**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-09T13:56:41Z
- **Completed:** 2026-03-09T14:01:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Reworked metaobjects.ts from creating metaobjects to looking up existing front-dtf/back-print by handle
- Reworked product-push.ts to orchestrate: category check -> image processing -> productSet -> metafieldsSet
- Added print_area_position and minimum_order_quantity metafield definitions to setup
- Updated CLI with old store format help text and unsupported category handling
- All 69 shopify tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Rework metaobjects and product push (RED)** - `f1b3fa1` (test)
2. **Task 1: Rework metaobjects and product push (GREEN)** - `ab0983f` (feat)
3. **Task 2: Update CLI and metaobject-setup** - `d5fd75e` (feat)

**Plan metadata:** (pending)

## Files Created/Modified
- `src/shopify/metaobjects.ts` - Lookup existing metaobjects by handle, removed creation functions
- `src/shopify/product-push.ts` - Full push orchestrator with category gating and metafields
- `src/shopify/metaobject-setup.ts` - Added variant and product metafield definitions
- `src/shopify/index.ts` - Added getExistingPrintAreaGids export
- `scripts/push-product.ts` - Updated CLI for old store format
- `tests/shopify/metaobjects.test.ts` - Tests for getExistingPrintAreaGids
- `tests/shopify/product-push.test.ts` - Tests for reworked buildProductSetInput

## Decisions Made
- Metaobjects looked up by handle instead of created per-push (front-dtf, back-print must pre-exist)
- buildProductSetInput returns null for unsupported categories, pushProduct throws descriptive error
- Print Areas and MOQ metafields set via separate metafieldsSet call after productSet mutation
- setupPrintAreaDefinitions expanded to create print_area_position (JSON, PRODUCTVARIANT) and minimum_order_quantity (number_integer, PRODUCT)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete push pipeline ready for live testing with real Shopify store
- Requires existing front-dtf and back-print metaobjects in the store (run --setup first)
- All foundation modules (variants, images, metaobjects, orchestrator) tested and integrated

---
*Phase: 04-shopify-product-push*
*Completed: 2026-03-09*
