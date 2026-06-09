---
phase: 08-image-quality-scorer
plan: "01"
subsystem: image-processing
tags: [image-quality, sharp, blur-detection, content-suitability, tdd]
dependency_graph:
  requires:
    - src/shopify/image-standardizer.ts (detectGarmentBounds, REFERENCE_RATIOS)
    - src/shopify/types.ts (GarmentBounds, CategoryGroup)
    - src/lib/logger.ts
  provides:
    - src/shopify/image-scorer.ts (scoreImageQuality, QUALITY_THRESHOLDS)
    - src/shopify/types.ts (ImageQualityResult, ImageQualityDimensions)
  affects:
    - Phase 10: AI candidate ranking uses numeric score
    - Phase 12: Audit pipeline uses pass/fail verdict
tech_stack:
  added: []
  patterns:
    - Laplacian convolution via sharp.convolve() for blur/print detection
    - 30%-inset extraction for monotonic blur stdev decay
    - toBuffer() before stats() to avoid sharp extract+stats chaining bug
    - removeAlpha() before raw() to ensure 3-channel stride consistency
    - Corner-sample fallback for non-white background detection
    - Garment-masked skin-tone detection to avoid false positives on garment colors
key_files:
  created:
    - src/shopify/image-scorer.ts
    - tests/shopify/image-scorer.test.ts
  modified:
    - src/shopify/types.ts
decisions:
  - "Blur detection uses 30%-inset garment region to avoid edge bleed from blur spreading garment color into background — makes stdev monotonically decrease with blur level"
  - "Solid-color garments (inset stdev < 1.0) receive neutral blur score — cannot be assessed for blur without texture"
  - "sharp extract().stats() chaining bug: stats() evaluates original input buffer, not extracted region — always toBuffer() then stats() separately"
  - "4-channel RGBA raw() buffer bug: use removeAlpha().toColourspace('srgb') before raw() to ensure stride=3"
  - "Skin-tone check masks out garment bounds in 100x100 downsample to prevent false positives from red/orange garment colors"
  - "QUALITY_THRESHOLDS: BLUR_MIN_STDEV=20, PRINT_CENTER_STDEV=30, WATERMARK_FULL_STDEV=30 (placeholder — calibrated in Plan 02)"
metrics:
  duration_seconds: 1305
  completed_date: "2026-03-26"
  tasks_completed: 2
  files_modified: 3
requirements: [QUAL-01, QUAL-02, QUAL-04, QUAL-05]
---

# Phase 08 Plan 01: Image Quality Scorer — Implementation Summary

Implemented `scoreImageQuality(buffer)` in `src/shopify/image-scorer.ts` with all four dimension checks (blur, resolution, proportion, content suitability), returning a structured `ImageQualityResult` with numeric score, pass/fail verdict, reasons array, and per-dimension sub-scores.

## What Was Built

### Types Added to `src/shopify/types.ts`

```typescript
export interface ImageQualityDimensions {
  blur: number;       // 0-100
  resolution: number; // 0-100
  proportion: number; // 0 or 100
  content: number;    // 0 or 100
}

export interface ImageQualityResult {
  score: number;             // 0-100 composite
  verdict: 'pass' | 'fail';
  reasons: string[];
  dimensions: ImageQualityDimensions;
}
```

### Scorer Function in `src/shopify/image-scorer.ts`

`scoreImageQuality(buffer: Buffer, categoryGroup?: CategoryGroup): Promise<ImageQualityResult>`

Orchestrates 4 sub-checks run in parallel:

1. **checkBlur**: Laplacian stdev on 30%-inset garment region. Solid-color garments (stdev < 1.0) return neutral score. Threshold: BLUR_MIN_STDEV=20.
2. **checkResolution**: Garment short-side pixel count vs MIN_GARMENT_PX=400.
3. **checkProportion**: Garment height fraction vs REFERENCE_RATIOS (0.73-0.78) ± PROPORTION_TOLERANCE=0.25. Fallback bounds detected and scored neutral.
4. **checkContentSuitability**: Four sub-checks:
   - Print/logo: Laplacian stdev of center 50% garment region (threshold: PRINT_CENTER_STDEV=30)
   - On-model: Skin-tone pixel ratio in background-only region of 100x100 downsample (threshold: SKIN_RATIO=5%)
   - Background whiteness: Mean brightness of top strip above garment, with corner-sample fallback (threshold: BG_WHITE_MIN=230)
   - Watermark: Full garment stdev vs center stdev pattern (threshold: WATERMARK_FULL_STDEV=30)

Composite score: blur 30%, resolution 20%, proportion 20%, content 30%.

### Tests in `tests/shopify/image-scorer.test.ts`

9 test cases using synthetic sharp buffers:
- Structured result with correct shape
- Sharp striped garment passes all checks
- Heavily blurred (sigma=20) garment fails blur
- Tiny garment (50x50 on 1000x1000) fails proportion
- Center checkered print garment fails print/logo
- Full skin-tone image fails on-model
- Gray background fails background check
- White background NOT falsely rejected
- Low-resolution (100x80) garment fails resolution

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Sharp `extract().stats()` chaining doesn't work**
- **Found during:** Task 2, background whiteness check
- **Issue:** `sharp(buffer).extract({...}).stats()` computes stats on the ORIGINAL buffer, not the extracted region. Returns wrong channel means.
- **Fix:** Always `.toBuffer()` the extraction result, then call `.stats()` on the new buffer.
- **Files modified:** `src/shopify/image-scorer.ts`
- **Commit:** 68d24ac

**2. [Rule 1 - Bug] 4-channel RGBA raw() buffer produces wrong skin-tone stride**
- **Found during:** Task 2, on-model detection
- **Issue:** Images created with `channels: 3` canvas and `.composite()` produce 4-channel RGBA PNG. `.raw().toBuffer()` returns 4 bytes per pixel but the loop used stride 3, misaligning channel reads.
- **Fix:** Added `.removeAlpha().toColourspace('srgb')` before `.raw()` to force 3-channel output.
- **Files modified:** `src/shopify/image-scorer.ts`
- **Commit:** 68d24ac

**3. [Rule 2 - Missing critical logic] Skin-tone check causes false positives on garment colors**
- **Found during:** Task 2, on-model detection
- **Issue:** Red garment pixels (R=200, G=50, B=50) satisfy the skin-tone criteria `R>95, G>40, B>20, R>G, R>B, R-G>15`, causing 14.5% false-positive skin ratio.
- **Fix:** Scale garment bounds to 100x100 and exclude garment pixels from the skin-tone count. When bounds are fallback (full image), count all pixels since we can't distinguish background.
- **Files modified:** `src/shopify/image-scorer.ts`
- **Commit:** 68d24ac

**4. [Rule 1 - Bug] Blur detection non-monotonic with extracted garment bounds**
- **Found during:** Task 2, blur check
- **Issue:** When image is blurry, `detectGarmentBounds()` returns wider bounds (blur spreads garment color into background). Using these wider bounds for Laplacian stdev calculation inflates stdev for blurry images, making them appear SHARPER than non-blurry ones.
- **Fix:** Use 30%-inset extraction from the garment buffer. The inner region's stdev decreases monotonically with blur level because it avoids edge bleed from background color spreading.
- **Files modified:** `src/shopify/image-scorer.ts`
- **Commit:** 68d24ac

**5. [Rule 1 - Bug] Test images and thresholds incompatible with each other**
- **Found during:** Task 2, test calibration
- **Issue:** Plan's specified test image (solid red 500x500 garment) has zero Laplacian stdev in any interior region — cannot demonstrate blur detection. Original thresholds (BLUR_MIN_STDEV=10, PRINT_CENTER_STDEV=15) were too tight for synthetic test patterns.
- **Fix:** Updated test helpers to use wide-stripe (50px) textured garments for blur tests. Updated thresholds to BLUR_MIN_STDEV=20, PRINT_CENTER_STDEV=30, WATERMARK_FULL_STDEV=30. Added `stdev < SOLID_COLOR_STDEV_THRESHOLD` check to skip blur for solid-color garments.
- **Files modified:** `tests/shopify/image-scorer.test.ts`, `src/shopify/image-scorer.ts`
- **Commit:** 68d24ac

## Known Stubs

None. All functionality is wired. QUALITY_THRESHOLDS constants are intentionally placeholder values per the plan (calibrated in Plan 02 using real supplier images).

## Test Results

- `npx vitest run tests/shopify/image-scorer.test.ts`: 9/9 passed
- `npm test`: 223/223 passed (no regressions)

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/shopify/image-scorer.ts | FOUND |
| tests/shopify/image-scorer.test.ts | FOUND |
| src/shopify/types.ts | FOUND |
| Commit 97fe138 (RED phase) | FOUND |
| Commit 68d24ac (GREEN phase) | FOUND |
| All 223 tests pass | VERIFIED |
