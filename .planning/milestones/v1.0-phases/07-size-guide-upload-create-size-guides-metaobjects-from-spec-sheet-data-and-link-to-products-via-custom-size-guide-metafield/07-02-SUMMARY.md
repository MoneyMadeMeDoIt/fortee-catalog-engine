---
phase: 07-size-guide-upload
plan: "02"
subsystem: shopify-metaobjects
tags: [size-guide, metaobjects, spec-sheet, product-push]
dependency_graph:
  requires:
    - phase: 07-01
      provides: upsertSizeGuideMetaobject, linkSizeGuideToProduct, readSpecSheetStructured
  provides: [size-guide-integration-in-pushProduct]
  affects: [src/shopify/product-push.ts]
tech_stack:
  added: []
  patterns: [non-fatal-try-catch, env-var-guard, inline-enrichment-step]
key_files:
  created: []
  modified:
    - src/shopify/product-push.ts
    - tests/shopify/product-push.test.ts
key-decisions:
  - "Size guide step is non-fatal: wrapped in try/catch, failure logs warn and does not abort product push"
  - "SPEC_SHEET_GOOGLE_SPREADSHEET_ID guard skips size guide silently when env var is unset"
  - "Spec sheet is read once per pushProduct call via readSpecSheetStructured (not per variant)"
  - "Step placed as 13b: after metafieldsSet (Print Areas + MOQ), before media query step 14"
requirements-completed: [SG-01, SG-02, SG-03, SG-04, SG-05, SG-06]
metrics:
  duration: "3min"
  completed: "2026-03-11"
  tasks_completed: 1
  tasks_total: 1
  files_created: 0
  files_modified: 2
---

# Phase 7 Plan 02: Size Guide Integration in pushProduct Summary

**pushProduct now auto-creates and links a size_guides metaobject per product using spec sheet data, gated by SPEC_SHEET_GOOGLE_SPREADSHEET_ID env var, with non-fatal error handling so missing specs never break a product push.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-11T13:08:00Z
- **Completed:** 2026-03-11T13:11:00Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Wired `upsertSizeGuideMetaobject` and `linkSizeGuideToProduct` into `pushProduct` as step 13b
- Step reads spec sheet once via `readSpecSheetStructured`, looks up specs by `rows[0].productId`
- Full try/catch wrapping: any size guide failure logs a warning and continues (product push is not aborted)
- Env var guard: if `SPEC_SHEET_GOOGLE_SPREADSHEET_ID` is not set, step is silently skipped
- Warning logged when spec data exists for the product ID but is empty/missing
- 4 source-verification tests added to product-push.test.ts; full suite 212/212 green

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire size guide upsert and link into pushProduct** - `682a652` (feat)

## Files Created/Modified
- `src/shopify/product-push.ts` - Added imports and step 13b size guide block
- `tests/shopify/product-push.test.ts` - Added 4 source-verification tests for wiring

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Non-fatal try/catch around size guide step | Same pattern as print_area_media batch errors — enrichment failures must not abort a product push |
| Spec sheet read once per pushProduct call | Spec data is needed for a single product, one API call is sufficient and correct |
| SPEC_SHEET_GOOGLE_SPREADSHEET_ID guard skips silently | Not all environments have spec sheets — env var absence is not an error |
| Step placed as 13b (after MOQ metafields, before media query) | Natural ordering: all product-level enrichment before media/variant metafields |

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required beyond the existing `SPEC_SHEET_GOOGLE_SPREADSHEET_ID` env var (already documented from Phase 2).

## Next Phase Readiness

- Phase 7 complete: size guide functions (Plan 01) and product push integration (Plan 02) are both done
- Every `pushProduct` run now automatically creates/updates the size guide metaobject and links it to the product when spec data is available
- Ready for Phase 6 (Live Inventory Sync) or any subsequent phase

---
*Phase: 07-size-guide-upload*
*Completed: 2026-03-11*
