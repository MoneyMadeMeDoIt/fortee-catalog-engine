---
phase: 04-shopify-product-push
plan: 01
subsystem: api
tags: [shopify, graphql, admin-api, variants, handles, template-map]

requires:
  - phase: 01-supplier-data-extraction
    provides: SheetRow type definition for variant building
  - phase: 03-decoration-rules-pricing
    provides: GarmentCategory type for template mapping
provides:
  - Shopify Admin API client factory (createShopifyClient)
  - GraphQL mutation strings (productSet, metafieldsSet, metaobject ops)
  - Variant builder mapping SheetRow[] to Shopify variant inputs
  - Handle generator for deterministic URL-safe product handles
  - Image file builder with cross-row deduplication
  - Template suffix map for all 7 garment categories
affects: [04-02, 04-03, shopify-product-push]

tech-stack:
  added: [@shopify/admin-api-client]
  patterns: [pure-function builders, TDD for data transforms, GraphQL mutation strings as constants]

key-files:
  created:
    - src/shopify/types.ts
    - src/shopify/client.ts
    - src/shopify/mutations.ts
    - src/shopify/template-map.ts
    - src/shopify/variants.ts
    - tests/shopify/template-map.test.ts
    - tests/shopify/variants.test.ts
    - tests/shopify/handles.test.ts
  modified: [package.json, package-lock.json]

key-decisions:
  - "API version 2025-01 for Shopify Admin API client"
  - "Pure function builders with no API calls for independent testability"
  - "URL deduplication via Set in buildFiles for cross-row image collection"

patterns-established:
  - "Shopify mutation strings as exported constants for reuse"
  - "Builder functions that transform SheetRow[] into Shopify input types"

requirements-completed: [SHOP-01, SHOP-02, SHOP-06, SHOP-07]

duration: 2min
completed: 2026-03-06
---

# Phase 4 Plan 1: Shopify Foundation Summary

**Shopify client factory, GraphQL mutations, variant/handle/image builders, and template suffix map using @shopify/admin-api-client**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-06T11:54:13Z
- **Completed:** 2026-03-06T11:56:19Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Installed @shopify/admin-api-client and created typed client factory with env var validation
- Built complete set of GraphQL mutation strings for productSet, metafieldsSet, and metaobject operations
- Implemented pure-function builders for variants, handles, and image files with full test coverage
- Template suffix map covers all 7 garment categories for Dawn theme integration

## Task Commits

Each task was committed atomically:

1. **Task 1: Shopify types, client, mutations, and template map** - `8086b67` (feat)
2. **Task 2: Variant builder, handle generator, and image file builder** - `77ccbe5` (feat)

## Files Created/Modified
- `src/shopify/types.ts` - ProductSetInput, variant, file, metaobject TypeScript interfaces
- `src/shopify/client.ts` - createShopifyClient factory reading SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN
- `src/shopify/mutations.ts` - GraphQL mutation strings for productSet, metafieldsSet, metaobject ops
- `src/shopify/template-map.ts` - GarmentCategory to Dawn template suffix mapping
- `src/shopify/variants.ts` - buildVariants, buildHandle, buildFiles pure functions
- `tests/shopify/template-map.test.ts` - 9 tests for template suffix mapping
- `tests/shopify/handles.test.ts` - 7 tests for handle generation
- `tests/shopify/variants.test.ts` - 14 tests for variant and file building
- `package.json` - Added @shopify/admin-api-client dependency

## Decisions Made
- API version 2025-01 for Shopify Admin API client (latest stable)
- Pure function builders with no API calls for independent testability
- URL deduplication via Set in buildFiles for cross-row image collection

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. Shopify credentials (SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN) will be needed at runtime but are read from environment variables.

## Next Phase Readiness
- All Shopify building blocks ready for Plan 02 (metaobject pipeline) and Plan 03 (product push orchestrator)
- Client, mutations, and builders are pure/testable with no side effects
- 30 tests pass across 3 test files in tests/shopify/

---
*Phase: 04-shopify-product-push*
*Completed: 2026-03-06*
