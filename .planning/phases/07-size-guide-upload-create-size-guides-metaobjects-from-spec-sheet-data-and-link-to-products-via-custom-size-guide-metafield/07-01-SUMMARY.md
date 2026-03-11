---
phase: 07-size-guide-upload
plan: "01"
subsystem: shopify-metaobjects
tags: [size-guide, metaobjects, spec-sheet, tdd]
dependency_graph:
  requires: []
  provides: [size-guide-functions, readSpecSheetStructured, UPSERT_SIZE_GUIDE]
  affects: [src/shopify/metaobjects.ts, src/shopify/mutations.ts, src/sheets/spec-sheet.ts]
tech_stack:
  added: []
  patterns: [pure-function-builders, tdd-red-green, json-encoding]
key_files:
  created:
    - tests/shopify/size-guide.test.ts
  modified:
    - src/shopify/mutations.ts
    - src/shopify/metaobjects.ts
    - src/sheets/spec-sheet.ts
    - .planning/phases/07-size-guide-upload-create-size-guides-metaobjects-from-spec-sheet-data-and-link-to-products-via-custom-size-guide-metafield/07-VALIDATION.md
decisions:
  - "linkSizeGuideToProduct uses metaobject_reference (single, not list) with raw GID string as value"
  - "transformSpecsToSizeGuide preserves first-appearance order for sizes and variables (caller provides sorted input)"
  - "readSpecSheetStructured sorts by sizeOrder column when present, falls back to standard XS/S/M/L/XL/2XL/3XL/4XL/5XL/6XL ordering"
  - "UPSERT_SIZE_GUIDE is identical to UPSERT_PRINT_AREA (generic metaobjectUpsert mutation works for any type)"
  - "buildSizeGuideMetaobjectFields limits to 5 variables and emits console.warn on overflow"
metrics:
  duration: "3 minutes"
  completed: "2026-03-11"
  tasks_completed: 1
  tasks_total: 1
  files_created: 1
  files_modified: 4
---

# Phase 7 Plan 01: Size Guide Functions Summary

**One-liner:** Size guide metaobject functions with UPSERT_SIZE_GUIDE mutation, field builder encoding sizes as JSON arrays and dimensions as {value,unit} objects, spec sheet structured reader with sizeOrder sorting, and product linking via single metaobject_reference.

## Tasks Completed

| # | Task | Commit | Status |
|---|------|--------|--------|
| 1 | Add readSpecSheetStructured and size guide builder functions with tests | fc00c2b | Done |

TDD RED commit: 35f6c0b

## What Was Built

### src/shopify/mutations.ts
- Added `UPSERT_SIZE_GUIDE` mutation string (identical shape to `UPSERT_PRINT_AREA` — generic metaobjectUpsert works for any type)

### src/shopify/metaobjects.ts
- Added `SizeGuideFields` interface (`sizes`, `variables`, `title`)
- Added `buildSizeGuideMetaobjectFields(guide)` — encodes sizes as `JSON.stringify(array)`, each variable's values as `JSON.stringify([{value, unit:'in'},...])`, description as empty rich text JSON, title as string. Limits to 5 variables with `console.warn` on overflow.
- Added `transformSpecsToSizeGuide(productId, productName, specs)` — groups `SizeSpec[]` into `SizeGuideFields`, preserving first-appearance order for sizes and variables with parallel value arrays.
- Added `upsertSizeGuideMetaobject(client, productId, productName, specs)` — calls `UPSERT_SIZE_GUIDE` with `size_guides` type, returns GID string.
- Added `linkSizeGuideToProduct(client, productGid, sizeGuideGid)` — uses `METAFIELDS_SET` with `metaobject_reference` (single, not list), raw GID string as value.

### src/sheets/spec-sheet.ts
- Added `readSpecSheetStructured(sheets, spreadsheetId, sheetName)` — returns `Map<string, SizeSpec[]>` grouped by `styleName`, sorted by `sizeOrder` column when present, falling back to standard size ordering `['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL']`. Does not modify existing `readSpecSheet()`.

### tests/shopify/size-guide.test.ts
- 17 unit tests covering all functions: grouping, sizeOrder sort, standard fallback sort, empty data, field encoding, 5-variable limit, float parsing, linkage metafield input, userErrors handling.

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| `linkSizeGuideToProduct` uses `metaobject_reference` (single) | Plan spec: size_guide is single reference, not a list |
| `transformSpecsToSizeGuide` preserves first-appearance order | `readSpecSheetStructured` handles sorting before calling this function |
| `UPSERT_SIZE_GUIDE` identical to `UPSERT_PRINT_AREA` | `metaobjectUpsert` is generic — same GraphQL works for any metaobject type |
| `buildSizeGuideMetaobjectFields` uses `console.warn` for overflow | Matches project pattern; logger not available as pure function side effect |

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx vitest run tests/shopify/size-guide.test.ts`: 17/17 passed
- `npx vitest run`: 208/208 passed (20 test files, no regressions)
- 07-VALIDATION.md: `wave_0_complete: true`, `nyquist_compliant: true`

## Self-Check: PASSED

- tests/shopify/size-guide.test.ts: FOUND
- src/shopify/metaobjects.ts: FOUND
- src/sheets/spec-sheet.ts: FOUND
- Commit fc00c2b: FOUND
- Commit 35f6c0b: FOUND
