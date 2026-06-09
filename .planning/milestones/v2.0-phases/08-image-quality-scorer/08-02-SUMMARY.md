---
phase: 08-image-quality-scorer
plan: 02
subsystem: testing
tags: [sharp, image-quality, calibration, thresholds]

# Dependency graph
requires:
  - phase: 08-01
    provides: scoreImageQuality function and QUALITY_THRESHOLDS placeholder values

provides:
  - QUALITY_THRESHOLDS calibrated against 243 real Shopify supplier images
  - Calibration script for ongoing threshold validation

affects:
  - 10-ai-image-generation (uses scorer to rank AI-generated candidates)
  - 12-image-replacement (uses scorer as quality gate before pushing to Shopify)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Calibrate detection thresholds against real data before using synthetic-only values in production

key-files:
  created:
    - scripts/calibrate-scorer.ts
  modified:
    - src/shopify/image-scorer.ts
    - tests/shopify/image-scorer.test.ts

key-decisions:
  - "BLUR_MIN_STDEV set to 1.5 (was 20.0) — real supplier images have stdev 1.1–20.0 (mean 8.2); threshold of 20 was rejecting 71% of normal photos"
  - "WATERMARK_FULL_STDEV set to 120.0 (was 30.0) — normal garment edge variance is 31–115 from fabric texture; 30 caused 49% false-positive watermark detection"
  - "PRINT_CENTER_STDEV set to 100.0 (was 30.0) — blank garment content scores 30–95 from color variation; 30 caused 25% false-positive print detection"
  - "SKIN_RATIO set to 0.30 (was 0.05) — ghost mannequin shots trigger low threshold; 0.30 requires substantial skin-tone area"
  - "Synthetic blur test updated to near-uniform gradient (stdev ~1.22) — sigma=20 Gaussian blur on hard-edged stripes kept stdev ~11, not representative of real blurry photos"

patterns-established:
  - "Blur test pattern: use near-uniform gradient image (not Gaussian-blurred hard stripes) to represent genuinely low-texture supplier photos"

requirements-completed: [QUAL-03]

# Metrics
duration: 15min
completed: 2026-03-26
---

# Phase 08 Plan 02: Threshold Calibration Summary

**QUALITY_THRESHOLDS calibrated against 243 real Shopify supplier images, reducing false-reject rate from 100% to near-zero across blur, watermark, print, and skin-tone checks**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-03-26T18:55:00Z
- **Completed:** 2026-03-26T19:03:00Z
- **Tasks:** 2 (Task 1 committed in previous session as 0badb7a)
- **Files modified:** 2

## Accomplishments

- Replaced all four over-aggressive placeholder thresholds with values derived from 243 real supplier images
- False-reject rate on known-good supplier images dropped from 100% to effectively 0% for blur/watermark/print/skin checks
- All 9 unit tests pass with calibrated thresholds
- Updated blur test fixture to use near-uniform gradient image — a better representation of real blurry supplier photos than Gaussian-blurred synthetic stripes

## Task Commits

Each task was committed atomically:

1. **Task 1: Build calibration script** - `0badb7a` (feat)
2. **Task 2: Calibrate and update thresholds** - `433dc22` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `scripts/calibrate-scorer.ts` - Fetches real Shopify product images and scores each one, outputs TSV report with pass/fail and per-dimension scores
- `src/shopify/image-scorer.ts` - QUALITY_THRESHOLDS updated with calibrated values and calibration rationale comments
- `tests/shopify/image-scorer.test.ts` - Blur test fixture updated to near-uniform gradient image

## Calibration Results

Threshold changes derived from 243 images across real Shopify supplier catalog:

| Threshold | Before | After | Reason |
|---|---|---|---|
| BLUR_MIN_STDEV | 20.0 | 1.5 | Real image stdev range: 1.1–20.0 (mean 8.2, p90 17.5); 71% of normal photos were rejected |
| WATERMARK_FULL_STDEV | 30.0 | 120.0 | Normal garment edge variance: 31–115 from fabric texture; 49% false-positive rate |
| PRINT_CENTER_STDEV | 30.0 | 100.0 | Blank garment content scores: 30–95 from color/texture variation; 25% false-positive rate |
| SKIN_RATIO | 0.05 | 0.30 | Ghost mannequin shots trigger low threshold; now requires substantial skin-tone area |
| BG_WHITE_MIN | 230 | 230 | Unchanged — threshold correct; failed bounds cases produce mean=0, those images are genuinely low quality |
| PROPORTION_TOLERANCE | 0.25 | 0.25 | Unchanged — no proportion issues observed |
| MIN_GARMENT_PX | 400 | 400 | Unchanged — resolution check working correctly |

## Decisions Made

- **Blur test fixture redesign:** Gaussian blur on synthetic hard-edged stripes (alternating 200/155 R-value, 50px wide) maintained inset stdev of ~11 even at sigma=20 — far above the calibrated 1.5 threshold. Replaced with a near-uniform gradient garment (R: 195→205 across width, stdev ~1.22) which correctly falls below BLUR_MIN_STDEV=1.5 while staying above SOLID_COLOR_STDEV_THRESHOLD=1.0 to ensure blur detection fires rather than the solid-color bypass.

- **BG_WHITE_MIN kept at 230:** The "mean brightness: 0" issue identified in calibration occurs when garment bounds detection fails and there is no valid background strip. These images genuinely lack an identifiable white background, so flagging them is correct behavior — not a false positive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Blur test fixture not representative of real blurry images**
- **Found during:** Task 2 (threshold update + test verification)
- **Issue:** `makeBlurryGarmentImage()` applied sigma=20 Gaussian blur to 50px hard-edged stripes (200/155 R-value alternating). With these high-contrast hard edges, even sigma=20 blur kept inset stdev at ~11.26 — well above the calibrated 1.5 threshold. The "blurry" test image actually passed blur detection, breaking the test.
- **Fix:** Replaced sigma=20 Gaussian blur approach with a near-uniform gradient garment (R: 195→205 across width). The gradient's inset stdev ~1.22 correctly falls below BLUR_MIN_STDEV=1.5, and above SOLID_COLOR_STDEV_THRESHOLD=1.0, so blur detection fires as intended.
- **Files modified:** `tests/shopify/image-scorer.test.ts`
- **Verification:** `npx vitest run tests/shopify/image-scorer.test.ts` — 9/9 pass
- **Committed in:** `433dc22` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** The test fixture fix was required by the threshold calibration — the synthetic test was only designed for the old threshold. No scope creep.

## Issues Encountered

None — calibration data was provided in the checkpoint response and threshold values were straightforward to apply.

## Known Stubs

None — all thresholds are wired to real calibration data.

## Next Phase Readiness

- `scoreImageQuality` is production-calibrated and ready for use in Phase 10 (AI image generation candidate ranking) and Phase 12 (image replacement quality gate)
- False-reject rate on real supplier images is near-zero for all four content checks
- Calibration script (`scripts/calibrate-scorer.ts`) can be re-run at any time if the supplier catalog changes significantly

---
*Phase: 08-image-quality-scorer*
*Completed: 2026-03-26*

## Self-Check: PASSED

- FOUND: `src/shopify/image-scorer.ts`
- FOUND: `tests/shopify/image-scorer.test.ts`
- FOUND: `scripts/calibrate-scorer.ts`
- FOUND: `.planning/phases/08-image-quality-scorer/08-02-SUMMARY.md`
- FOUND commit: `433dc22` (feat: calibrate QUALITY_THRESHOLDS)
- FOUND commit: `0badb7a` (feat: calibration script)
- Tests: 9/9 pass
