---
phase: 11-image-standardization-safe-upload
plan: 02
subsystem: image-processing
tags: [sharp, shopify, google-sheets, staged-uploads, image-standardization]

requires:
  - phase: 11-01
    provides: refactored standardizeImage() using FIXED_GARMENT_HEIGHT_FRAC (D-01), downloadImage, uploadStagedImage

provides:
  - buildStandardizationUpdates() — creates EnrichmentUpdates for K/L/M sheet columns without skip-if-nonempty guard
  - standardizeImagesToSheets() — orchestrates download/standardize/upload/write pipeline, D-03 compliant (no product mutations)

affects:
  - phase-12-gid-updates
  - any phase that calls the image standardization pipeline

tech-stack:
  added: []
  patterns:
    - "vi.mock for module-level mocks (sheets/writer.js) combined with vi.spyOn for fetch — enables testing composable async pipelines"
    - "vi.clearAllMocks() in beforeEach when vi.mock accumulates call counts across tests"
    - "Bypass skip-if-nonempty by constructing EnrichmentUpdates directly (not via buildUpdates())"

key-files:
  created: []
  modified:
    - src/shopify/image-standardizer.ts
    - tests/shopify/image-standardizer.test.ts

key-decisions:
  - "standardizeImagesToSheets() uses staged uploads for CDN URL generation only — no productCreateMedia or productSet calls (D-03: store images unchanged)"
  - "buildStandardizationUpdates() constructs EnrichmentUpdates directly with hardcoded K/L/M columns, intentionally bypassing buildUpdates() skip-if-nonempty guard"
  - "vi.clearAllMocks() required alongside vi.restoreAllMocks() when vi.mock module-level mocks accumulate call history across test cases"

patterns-established:
  - "Pattern: TDD with vi.mock for cross-module dependencies — mock at module level, clearAllMocks in beforeEach, assert call args with expect.arrayContaining()"
  - "Pattern: Sheet column targeting using hardcoded K/L/M for image columns — avoids columnToLetter() dependency and skip guard"

requirements-completed: [STD-02, OUT-02]

duration: 2min
completed: 2026-03-26
---

# Phase 11 Plan 02: Image Standardization — standardizeImagesToSheets Summary

**standardizeImagesToSheets() orchestrates download->standardize->upload->writeUpdates pipeline using Shopify staged uploads for CDN URLs only, writing K/L/M sheet columns without skip-if-nonempty guard (D-03: no product mutations)**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-26T23:56:41Z
- **Completed:** 2026-03-26T23:58:54Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `buildStandardizationUpdates()` that builds EnrichmentUpdate objects for FrontImage (K), BackImage (L), DirectSideImage (M) sheet columns with correct rowIndex+2 offset, intentionally bypassing the skip-if-nonempty guard from `buildUpdates()`
- Added `standardizeImagesToSheets()` that composes downloadImage -> standardizeImage -> uploadStagedImage (for CDN URLs) -> writeUpdates, with per-view error handling and printAreaCoords derived from front image
- Added 9 new tests covering buildStandardizationUpdates row arithmetic, column targeting, and standardizeImagesToSheets pipeline composition including graceful failure handling

## Task Commits

1. **Task 1: Create standardizeImagesToSheets() with direct sheet overwrite** - `a585d5a` (feat)

## Files Created/Modified

- `src/shopify/image-standardizer.ts` - Added `buildStandardizationUpdates()` and `standardizeImagesToSheets()` exports; added imports for googleapis/sheets, EnrichmentUpdate, and writeUpdates
- `tests/shopify/image-standardizer.test.ts` - Added `vi.mock` for sheets/writer.js; added describe blocks for both new functions (9 tests total)

## Decisions Made

- `buildStandardizationUpdates` uses hardcoded K/L/M column letters rather than `columnToLetter()` — avoids importing column-map.ts and matches the spec's explicit column targeting
- `vi.clearAllMocks()` added alongside `vi.restoreAllMocks()` in the standardizeImagesToSheets beforeEach — without this, the `vi.mock('../../src/sheets/writer.js')` call count accumulates across test cases and the "not called" assertion fails

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added vi.clearAllMocks() to fix mock call count bleeding between tests**
- **Found during:** Task 1 (GREEN phase — first test run)
- **Issue:** The "returns cellsWritten 0 and no coords when no images provided" test was asserting `expect(writeUpdates).not.toHaveBeenCalled()` but the mock's call count accumulated from previous tests in the describe block; the plan specified `vi.restoreAllMocks()` only, which restores spies but not vi.mock() call history
- **Fix:** Added `vi.clearAllMocks()` alongside `vi.restoreAllMocks()` in the beforeEach for the standardizeImagesToSheets describe block
- **Files modified:** tests/shopify/image-standardizer.test.ts
- **Verification:** All 32 tests pass, including the no-images test
- **Committed in:** a585d5a (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug fix)
**Impact on plan:** Minor test infrastructure fix — vi.clearAllMocks() is the standard vitest pattern when mixing vi.mock and vi.spyOn. No scope creep.

## Issues Encountered

None — implementation matched plan exactly. The one test failure during GREEN phase was immediately diagnosed as vi mock call count bleed (a known vitest behavior) and fixed with vi.clearAllMocks().

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `standardizeImagesToSheets()` is exported and tested — ready for use in any script that processes images for the sheet
- Phase 11 complete: both plans executed (01 — refactor standardizeImage, 02 — add standardizeImagesToSheets)
- The pipeline correctly writes to K/L/M columns with rowIndex+2 offset and overwrites existing values
- No blockers for downstream phases

---
*Phase: 11-image-standardization-safe-upload*
*Completed: 2026-03-26*
