---
phase: 04-shopify-product-push
plan: 02
subsystem: api
tags: [sharp, image-processing, shopify-staged-uploads, png]

requires:
  - phase: 04-shopify-product-push
    provides: "Shopify client, types, mutations from plan 01"
provides:
  - "Image download/standardize/upload pipeline for product images"
  - "standardizeImage, downloadImage, uploadStagedImage, processProductImages exports"
affects: [04-shopify-product-push]

tech-stack:
  added: [sharp]
  patterns: [staged-upload-3-step-flow, graceful-skip-on-failure]

key-files:
  created:
    - src/shopify/image-standardizer.ts
    - tests/shopify/image-standardizer.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "sharp with fit:contain and white background for consistent 2000x2000 output"
  - "30-second AbortController timeout on image downloads"
  - "Individual image failures skip gracefully without failing entire product"

patterns-established:
  - "Staged upload pattern: mutation -> PUT -> resourceUrl for Shopify image hosting"
  - "Alt text convention: Front Print / Back Print for print area overlay images"

requirements-completed: [SHOP-05]

duration: 2min
completed: 2026-03-09
---

# Phase 4 Plan 02: Image Standardization Pipeline Summary

**sharp-based image pipeline: download, resize to 2000x2000 with white background, upload via Shopify staged uploads with print-area alt text**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-09T13:50:05Z
- **Completed:** 2026-03-09T13:52:34Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments
- standardizeImage resizes any input to exactly 2000x2000 PNG with white background using sharp fit:contain
- downloadImage fetches with 30s timeout and descriptive error messages including URL and status
- uploadStagedImage handles full 3-step Shopify staged upload flow (mutation -> PUT -> resourceUrl)
- processProductImages orchestrates pipeline with correct "Front Print" / "Back Print" alt text
- Graceful error handling: failed individual images are skipped without crashing the pipeline
- 12 unit tests covering all functions and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Install sharp and create image standardizer module** - `546bfb3` (feat)

## Files Created/Modified
- `src/shopify/image-standardizer.ts` - Image download, standardization, and staged upload pipeline
- `tests/shopify/image-standardizer.test.ts` - 12 unit tests for all exported functions
- `package.json` - Added sharp dependency
- `package-lock.json` - Lock file updated with sharp

## Decisions Made
- Used sharp with `fit: 'contain'` and white background `{r:255, g:255, b:255, alpha:1}` for consistent 2000x2000 output regardless of input aspect ratio
- 30-second AbortController timeout on image downloads to prevent hanging
- Individual image failures logged as warnings and skipped (do not fail entire product)
- PNG output format for all standardized images (lossless, supports transparency)
- Client typed as interface with `request` method to match existing codebase pattern

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] STAGED_UPLOADS_CREATE mutation already existed**
- **Found during:** Task 1
- **Issue:** Plan noted to add mutation inline if plan 01 hadn't run; plan 01 had already committed it
- **Fix:** No action needed, imported directly from mutations.ts
- **Files modified:** None
- **Verification:** Import resolves, tests pass

---

**Total deviations:** 1 (non-issue, dependency already satisfied)
**Impact on plan:** None - plan 01 ran first and provided all dependencies.

## Issues Encountered
- Test mock for "skips failed image downloads" used callCount-based logic that conflicted with URL-based checks; fixed by using URL pattern matching for all mock branches

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Image standardization pipeline ready for integration in plan 03 (product push orchestrator)
- processProductImages returns FileSetInput[] compatible with productSet mutation files field

---
*Phase: 04-shopify-product-push*
*Completed: 2026-03-09*
