---
phase: 02-google-sheets-integration
plan: 02
subsystem: api
tags: [google-sheets, merge, enrichment, batch-write, cli]

requires:
  - phase: 02-google-sheets-integration
    provides: SheetRow types, column mapping, Sheets client, readAllRows reader
  - phase: 01-supplier-data-extraction
    provides: SupplierProduct types, extractFromSupplier, SizeSpec
provides:
  - Fill-gaps-only merge logic (buildUpdates, formatSizeChart, mapSupplierToSheetFields)
  - Batch writer with RAW valueInputOption (writeUpdates)
  - Enrichment orchestrator with dry-run support (enrichSheet)
  - CLI entry point with --supplier, --dry-run, --help flags
affects: [03-shopify-product-creation, enrichment-pipeline]

tech-stack:
  added: []
  patterns: [fill-gaps-only-merge, single-batch-write, structured-size-chart-text]

key-files:
  created:
    - src/sheets/merge.ts
    - src/sheets/writer.ts
    - src/sheets/enrich.ts
    - scripts/enrich.ts
    - tests/sheets/merge.test.ts
    - tests/sheets/writer.test.ts
  modified: []

key-decisions:
  - "Image fields map positionally: images[0]=Front, images[1]=Back, images[2]=Side"
  - "Size chart stored as structured text not URLs (e.g., 'S: Chest 36 | M: Chest 38')"
  - "Supplier product lookup keyed by adapter:styleNumber for cross-supplier uniqueness"

patterns-established:
  - "Fill-gaps-only merge: check if cell is empty (falsy/whitespace) before writing"
  - "Single batch write: collect all EnrichmentUpdate then one batchUpdate call with RAW mode"
  - "CLI pattern: --help exits 0, parseArgs validates, main prints summary, exit 1 on errors"

requirements-completed: [SHEET-02, SHEET-03]

duration: 3min
completed: 2026-03-05
---

# Phase 2 Plan 2: Merge, Writer, and Enrichment CLI Summary

**Fill-gaps-only merge logic with batch writer and enrichment CLI that populates empty sheet cells from supplier data without overwriting existing values**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-05T15:04:48Z
- **Completed:** 2026-03-05T15:07:30Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Merge logic that only fills empty cells, preserving all existing data including images
- Size chart data converted to structured text format instead of URLs
- Batch writer sends all changes in a single API call with RAW valueInputOption
- Enrichment orchestrator with full read-extract-merge-write pipeline
- CLI script with --supplier filter, --dry-run preview, and --help documentation
- 12 new tests (31 total across sheets test suite)

## Task Commits

Each task was committed atomically:

1. **Task 1: Merge logic and batch writer with tests** - `77c300c` (feat)
2. **Task 2: Enrichment orchestrator and CLI script** - `3981d12` (feat)

_Note: Task 1 followed TDD (RED/GREEN phases combined into feat commit)._

## Files Created/Modified
- `src/sheets/merge.ts` - formatSizeChart, mapSupplierToSheetFields, buildUpdates
- `src/sheets/writer.ts` - writeUpdates with batchUpdate RAW mode
- `src/sheets/enrich.ts` - enrichSheet orchestrator with dry-run support
- `scripts/enrich.ts` - CLI entry point with arg parsing and summary output
- `tests/sheets/merge.test.ts` - 9 tests for merge logic
- `tests/sheets/writer.test.ts` - 3 tests for batch writer

## Decisions Made
- Image fields mapped positionally (images[0]=Front, [1]=Back, [2]=Side) matching FIELD_MAPPING paths
- Size chart stored as structured text ("S: Chest 36 | M: Chest 38") per plan requirement
- Supplier product lookup uses composite key (adapter:styleNumber) to avoid cross-supplier collisions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required

Same environment variables as Plan 01 (already documented):
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - GCP service account email
- `GOOGLE_PRIVATE_KEY` - Private key from GCP service account JSON
- `GOOGLE_SPREADSHEET_ID` - Spreadsheet ID from Google Sheets URL
- `GOOGLE_SHEET_NAME` - Tab name (defaults to "Sheet1")

## Next Phase Readiness
- Full Google Sheets integration complete: read, merge, write pipeline operational
- Ready for Phase 3 (Shopify product creation) which consumes enriched sheet data
- Run command: `npx tsx scripts/enrich.ts` (or `--dry-run` to preview)

---
*Phase: 02-google-sheets-integration*
*Completed: 2026-03-05*
