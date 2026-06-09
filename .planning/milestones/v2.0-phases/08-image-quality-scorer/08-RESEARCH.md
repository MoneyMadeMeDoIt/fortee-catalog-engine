# Phase 08: Image Quality Scorer - Research

**Researched:** 2026-03-26
**Domain:** Image quality analysis with sharp (Node.js) — blur detection, resolution checks, garment proportion validation, content suitability heuristics
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 (Score Output Shape):** Function returns `{ score: number (0-100), verdict: 'pass' | 'fail', reasons: string[], dimensions: { blur: number, resolution: number, proportion: number, content: number } }`. Numeric score required for Phase 10 candidate ranking. Verdict required for Phase 12 pipeline gating.
- **D-02 (Quality Dimensions):** Blur (Laplacian variance on trimmed region), resolution (minimum pixel dimensions after trim), garment proportion (garment-to-canvas ratio vs target range), content suitability (QUAL-04).
- **D-03 (Content Suitability Fails):** Flag these as `fail` with descriptive reason: garments with existing prints/logos (high-frequency content in garment center), watermarked images (repeating pattern overlay), on-model photos (skin-tone pixel ratio heuristic), non-white backgrounds (background color deviation from white).
- **D-04 (Calibration):** Calibration script fetches ~50-60 images from existing Shopify products, scores them, outputs a report. User reviews and flags wrong verdicts. Thresholds adjusted until false-reject rate on known-good samples is below 5%.
- **D-05 (Proportion Criteria):** Uses existing `REFERENCE_RATIOS` (0.73 tops, 0.78 hoodies) as targets. Tolerance band determined during calibration. Fail if outside target range.

### Claude's Discretion

- Specific blur threshold values (Laplacian variance cutoff) — determined during calibration
- Resolution minimum pixel dimensions — determined during calibration
- Watermark detection algorithm choice (frequency domain vs template matching)
- On-model detection heuristic tuning
- Background whiteness threshold value
- Internal function decomposition and module structure

### Deferred Ideas (OUT OF SCOPE)

- Contextual on-model photos: Generate 1 on-model mannequin photo per product (belongs in future phase after Phase 10 AI Image Generation)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QUAL-01 | System scores each product image for blur, exposure, and resolution using sharp-based analysis on the trimmed garment region | sharp `stats()`, `convolve()`, `metadata()` all confirmed working on real buffers — see Code Examples below |
| QUAL-02 | System flags images below minimum quality thresholds as needing replacement | Verdict + reasons structure confirmed in D-01; calibration script (D-04) sets thresholds |
| QUAL-03 | Quality thresholds calibrated against 50+ real supplier images before production use | Calibration script pattern documented in Architecture Patterns |
| QUAL-04 | Quality criteria account for mockup/visual generation use case — images must be clean blank garments suitable for design overlays | Content checks (print detection, watermark, on-model, background) all verified implementable with sharp alone |
| QUAL-05 | Scorer flags images where garment proportion within the canvas is outside the target range | `detectGarmentBounds()` returns bounds; proportion ratio math verified — `garmentH / originalH` compared to `REFERENCE_RATIOS` |
</phase_requirements>

---

## Summary

Phase 08 builds `scoreImageQuality(buffer)` — a pure-sharp image analysis function that operates entirely within the already-installed `sharp` 0.34.5 library. No new npm dependencies are required. The function reuses `detectGarmentBounds()` from `image-standardizer.ts` to isolate the garment region before running any analysis, which prevents false rejects on white-background supplier images.

All four quality dimensions — blur, resolution, proportion, and content suitability — are implementable using sharp's native API: `stats()` for blur and whiteness, `metadata()` for resolution, `extract()` for region isolation, `convolve()` with a Laplacian kernel for high-frequency content detection, and `raw()` for per-pixel skin-tone heuristics. These were all verified with actual sharp 0.34.5 API calls in this research session.

The calibration script is a separate concern from the scorer function itself. The scorer is built first with placeholder thresholds; calibration then fixes those thresholds against real data. The file belongs at `src/shopify/image-scorer.ts` following the established module convention.

**Primary recommendation:** Implement scorer with sharp-only analysis, reuse `detectGarmentBounds()` for trimming, use Laplacian stdev (via `convolve`) as the blur metric, and build the calibration script as a standalone script under `scripts/`.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| sharp | 0.34.5 (installed) | Image analysis primitives: `stats()`, `convolve()`, `extract()`, `raw()`, `metadata()` | Already the project's only image library; all needed operations verified available |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| typescript (project) | ^5.9.3 | Type interfaces for scorer result | Existing — define `ImageQualityResult` in `types.ts` |
| vitest | 4.1.1 (latest) / ^4.0.18 (installed) | Unit tests for scorer | Existing test framework — add `tests/shopify/image-scorer.test.ts` |
| logger | (project) | Consistent log output | Existing — `src/lib/logger.ts` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Laplacian stdev via `convolve()` | sharp built-in `stats().sharpness` | Built-in sharpness uses Laplacian of Gaussian but was observed to be non-monotonic with blur level in testing (blur-50 scored higher than blur-15). Manual `convolve()` with a pure Laplacian kernel is monotonically decreasing — more reliable. |
| Per-pixel raw buffer for skin detection | sharp `dominant` color | `dominant` color is less precise for per-pixel threshold counting. Raw buffer allows exact RGB thresholding verified in tests. |
| Background check via corner sampling | Background check via `offsetTop` strip | Using `GarmentBounds.offsetTop` gives a known-clean background strip; corner sampling is fragile if garment is flush to corner. |

**Installation:** No new packages required. All analysis is done with the existing `sharp` 0.34.5 installation.

**Version verification:** sharp 0.34.5 — confirmed installed and tested. vitest 4.1.1 latest, 4.0.18 installed.

---

## Architecture Patterns

### Recommended Project Structure

```
src/shopify/
├── image-scorer.ts       # scoreImageQuality() function (new)
├── image-standardizer.ts # detectGarmentBounds() reused here
└── types.ts              # Add ImageQualityResult interface here

scripts/
└── calibrate-scorer.ts   # Standalone calibration script (new)

tests/shopify/
└── image-scorer.test.ts  # Unit tests with synthetic sharp buffers
```

### Pattern 1: Score Function Architecture

**What:** `scoreImageQuality(buffer: Buffer): Promise<ImageQualityResult>` orchestrates 4 sub-checks, each returning a `{ score: number, reasons: string[] }`. Final score is a weighted composite; verdict is `pass` if score >= threshold and no hard-fail reasons exist.

**When to use:** Called from Phase 10 candidate ranking and Phase 12 audit runner.

**Example:**
```typescript
// src/shopify/image-scorer.ts
import sharp from 'sharp';
import { detectGarmentBounds } from './image-standardizer.js';
import { logger } from '../lib/logger.js';
import type { ImageQualityResult } from './types.js';

export async function scoreImageQuality(buffer: Buffer): Promise<ImageQualityResult> {
  const bounds = await detectGarmentBounds(buffer);

  // Extract trimmed garment region for analysis
  const garmentBuffer = await sharp(buffer)
    .extract({
      left: bounds.offsetLeft,
      top: bounds.offsetTop,
      width: bounds.width,
      height: bounds.height,
    })
    .png()
    .toBuffer();

  const [blurResult, resolutionResult, proportionResult, contentResult] = await Promise.all([
    checkBlur(garmentBuffer),
    checkResolution(bounds),
    checkProportion(bounds),
    checkContentSuitability(buffer, garmentBuffer, bounds),
  ]);

  const reasons = [
    ...blurResult.reasons,
    ...resolutionResult.reasons,
    ...proportionResult.reasons,
    ...contentResult.reasons,
  ];

  const score = Math.round(
    (blurResult.score * 0.3) +
    (resolutionResult.score * 0.2) +
    (proportionResult.score * 0.2) +
    (contentResult.score * 0.3)
  );

  const verdict: 'pass' | 'fail' = reasons.length > 0 ? 'fail' : 'pass';

  return {
    score,
    verdict,
    reasons,
    dimensions: {
      blur: blurResult.score,
      resolution: resolutionResult.score,
      proportion: proportionResult.score,
      content: contentResult.score,
    },
  };
}
```

### Pattern 2: Blur Detection (Laplacian Stdev)

**What:** Apply a 3x3 Laplacian convolution kernel to the greyscale garment region. The standard deviation of the result is the blur metric. Higher = sharper. Monotonically decreasing as blur increases.

**When to use:** Inside `checkBlur()`. Apply to the extracted garment buffer, not the full canvas.

**Example:**
```typescript
// Verified with sharp 0.34.5 — monotonically decreasing with blur level
async function checkBlur(garmentBuffer: Buffer): Promise<DimensionResult> {
  const stats = await sharp(garmentBuffer)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1], // Laplacian kernel
    })
    .stats();

  const laplacianStdev = stats.channels[0].stdev;
  // THRESHOLD: set during calibration — placeholder below
  const BLUR_THRESHOLD = 10.0; // tune against 50+ images in calibrate-scorer.ts
  const pass = laplacianStdev >= BLUR_THRESHOLD;

  return {
    score: Math.min(100, Math.round((laplacianStdev / BLUR_THRESHOLD) * 100)),
    reasons: pass ? [] : [`Image is too blurry (sharpness score: ${laplacianStdev.toFixed(1)}, min: ${BLUR_THRESHOLD})`],
  };
}
```

### Pattern 3: Resolution Check

**What:** Use `GarmentBounds.width` and `.height` (trimmed region) as the resolution measure. Supplier images should have the garment rendered at sufficient resolution for mockup use.

**When to use:** Inside `checkResolution()`. Use bounds directly — no additional sharp call needed.

**Example:**
```typescript
function checkResolution(bounds: GarmentBounds): DimensionResult {
  const MIN_GARMENT_PX = 400; // tune during calibration
  const shortSide = Math.min(bounds.width, bounds.height);
  const pass = shortSide >= MIN_GARMENT_PX;

  return {
    score: Math.min(100, Math.round((shortSide / MIN_GARMENT_PX) * 100)),
    reasons: pass ? [] : [`Garment resolution too low: ${bounds.width}x${bounds.height}px (min: ${MIN_GARMENT_PX}px short side)`],
  };
}
```

### Pattern 4: Proportion Check

**What:** Compare `bounds.height / bounds.originalHeight` (garment height fraction of canvas) to `REFERENCE_RATIOS[categoryGroup].targetHeightFrac`. Flag if outside tolerance band.

**When to use:** Inside `checkProportion()`. Note: the scorer receives only a buffer — it doesn't know the category group at call time. Two options: (a) accept `categoryGroup` as optional parameter and default to 'tops', or (b) compare against the broadest acceptable range spanning both tops (0.73) and hoodies (0.78) plus calibrated tolerance.

**Example:**
```typescript
import { REFERENCE_RATIOS } from './image-standardizer.js';

function checkProportion(bounds: GarmentBounds): DimensionResult {
  const heightFrac = bounds.height / bounds.originalHeight;
  // Use the min of tops target (0.73) minus tolerance as floor,
  // and max of hoodies (0.78) plus tolerance as ceiling
  // TOLERANCE: tune during calibration — placeholder ±0.20
  const PROPORTION_TOLERANCE = 0.20;
  const minFrac = Math.min(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) - PROPORTION_TOLERANCE;
  const maxFrac = Math.max(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) + PROPORTION_TOLERANCE;
  const pass = heightFrac >= minFrac && heightFrac <= maxFrac;

  return {
    score: pass ? 100 : 0,
    reasons: pass ? [] : [`Garment proportion out of range: ${(heightFrac * 100).toFixed(0)}% height (expected ${(minFrac*100).toFixed(0)}–${(maxFrac*100).toFixed(0)}%)`],
  };
}
```

### Pattern 5: Content Suitability Checks

**What:** Four sub-checks using sharp on the garment region and original image.

**When to use:** Inside `checkContentSuitability()`.

**5a. Existing Print Detection (high-frequency center content)**
```typescript
// Center 50% of garment region — blank garment has near-zero Laplacian stdev
const center = await sharp(garmentBuffer)
  .extract({
    left: Math.floor(bounds.width * 0.25),
    top: Math.floor(bounds.height * 0.25),
    width: Math.floor(bounds.width * 0.5),
    height: Math.floor(bounds.height * 0.5),
  })
  .png()
  .toBuffer();
const centerStats = await sharp(center)
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1,-1,-1,-1,8,-1,-1,-1,-1] })
  .stats();
// Verified: blank solid-color garment stdev = 0; printed/logo garment stdev >> 0
// THRESHOLD: tune during calibration (placeholder: 15.0)
const PRINT_THRESHOLD = 15.0;
if (centerStats.channels[0].stdev > PRINT_THRESHOLD) {
  reasons.push(`Garment appears to have existing print/logo (content score: ${centerStats.channels[0].stdev.toFixed(1)})`);
}
```

**5b. On-Model Detection (skin-tone pixel ratio)**
```typescript
// Downsample for speed, then count skin-tone pixels in raw buffer
const downsampled = await sharp(buffer).resize(100, 100, { fit: 'cover' }).raw().toBuffer();
let skinPixels = 0;
for (let i = 0; i < downsampled.length; i += 3) {
  const r = downsampled[i], g = downsampled[i + 1], b = downsampled[i + 2];
  if (r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15) skinPixels++;
}
const skinRatio = skinPixels / (downsampled.length / 3);
// THRESHOLD: tune during calibration (placeholder: 0.05 = 5% skin pixels)
const SKIN_THRESHOLD = 0.05;
if (skinRatio > SKIN_THRESHOLD) {
  reasons.push(`Image appears to show an on-model photo (skin-tone ratio: ${(skinRatio * 100).toFixed(1)}%)`);
}
```

**5c. Non-White Background Detection**
```typescript
// Use top strip of background (above garment) as sample — requires offsetTop > 10px
// Falls back to corner check if offset is too small
if (bounds.offsetTop >= 10) {
  const bgStrip = await sharp(buffer)
    .extract({ left: 0, top: 0, width: bounds.originalWidth, height: bounds.offsetTop })
    .stats();
  const bgMean = (bgStrip.channels[0].mean + bgStrip.channels[1].mean + bgStrip.channels[2].mean) / 3;
  // THRESHOLD: tune during calibration (placeholder: 230 = near-white)
  const BG_WHITE_THRESHOLD = 230;
  if (bgMean < BG_WHITE_THRESHOLD) {
    reasons.push(`Background is not white (mean brightness: ${bgMean.toFixed(0)}, min: ${BG_WHITE_THRESHOLD})`);
  }
}
```

**5d. Watermark Detection**
Use `convolve` Laplacian stdev on the FULL garment region (not just center). A watermark adds periodic high-frequency content across the entire garment surface. If `fullGarmentLaplacianStdev` is high but `centerLaplacianStdev` is also high and distributed (not localized), it indicates a watermark rather than a single print. This is a heuristic — tune threshold during calibration. If frequency-domain periodicity detection is needed, it cannot be done with sharp alone and would require a different tool — but the stdev approach should handle most real supplier watermarks sufficiently.

### Pattern 6: Calibration Script Structure

**What:** Standalone script at `scripts/calibrate-scorer.ts` that fetches real supplier images from Shopify, runs the scorer, and outputs a report.

**When to use:** Phase 08 Wave 2 — after scorer is built, before thresholds are finalized.

**Example structure:**
```typescript
// scripts/calibrate-scorer.ts
import { downloadImage } from '../src/shopify/image-standardizer.js';
import { scoreImageQuality } from '../src/shopify/image-scorer.js';

// 1. Fetch ~50-60 image URLs from Shopify (existing products via GraphQL)
// 2. Score each image
// 3. Output CSV or table: url | score | verdict | reasons
// Usage: npx tsx scripts/calibrate-scorer.ts > calibration-report.txt
// User reviews, marks wrong verdicts, adjusts THRESHOLDS in image-scorer.ts
```

### Anti-Patterns to Avoid

- **Analyzing the full canvas for blur:** A white-background garment image is dominated by white pixels. Laplacian stdev on the full canvas will be near-zero regardless of garment sharpness. Always extract the trimmed garment region first.
- **Using sharp's built-in `stats().sharpness` as the blur metric:** Testing showed this metric is non-monotonic with blur levels (higher blur-50 sharpness than blur-15 in some cases). Use `convolve()` with a Laplacian kernel and read `stdev` instead — confirmed monotonically decreasing.
- **Hard-coding thresholds without calibration:** Supplier image quality varies widely. Placeholder thresholds in the initial implementation must be replaced by calibration against real data (D-04). Do not skip calibration.
- **Calling `detectGarmentBounds()` multiple times per image:** Call once, extract the garment buffer once, then pass to all sub-checks.
- **Checking `density` (DPI) from `metadata()` for resolution:** DPI is `undefined` for most supplier PNGs without EXIF data. Use pixel dimensions (`bounds.width`, `bounds.height`) instead.
- **Classifying `detectGarmentBounds` fallback (full bounds) as a quality failure:** When trim falls back to full dimensions, the scorer should still run — just flag the proportion check result accordingly, not the fallback itself.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Blur measurement | Custom FFT-based frequency analysis | sharp `convolve()` with Laplacian kernel + `stats().stdev` | Verified working in sharp 0.34.5; FFT would require a new dependency |
| Image region extraction | Manual pixel buffer slicing | sharp `extract()` | sharp handles all edge cases and format conversion |
| Color statistics | Custom channel histogram code | sharp `stats()` | Returns `min, max, mean, stdev` per channel — exactly what's needed |
| Background check | Flood-fill or connected components | `extract()` top strip + `stats()` mean | Sufficient for white-background guarantee without added complexity |
| Resolution check | Decode full image to check size | Use `GarmentBounds.width/.height` from `detectGarmentBounds()` which already calls `metadata()` | Avoids a second metadata call |

**Key insight:** Everything needed for this scorer is already in sharp. The temptation to reach for OpenCV, Jimp, or frequency-domain tools is unnecessary for the quality checks defined in CONTEXT.md.

---

## Common Pitfalls

### Pitfall 1: White Canvas Dominating Blur Analysis

**What goes wrong:** Laplacian stdev on a full white-background garment image approaches zero even for a crisp garment, because white pixels produce no edge response.

**Why it happens:** The garment occupies maybe 30-50% of the total canvas. White pixels have no frequency content.

**How to avoid:** Always call `detectGarmentBounds()` first, then `sharp(buffer).extract(bounds)` before any frequency analysis. Verified working in existing tests.

**Warning signs:** Blur scores of 0 on known-sharp images; all images getting the same blur score.

### Pitfall 2: `detectGarmentBounds()` Fallback Triggering on Dark Garments

**What goes wrong:** Very dark garments (near-black) on a white background may have low contrast with the threshold of `10` used in the trim call. If trim removes >70% it falls back to full bounds.

**Why it happens:** `trim({ background: '#ffffff', threshold: 10 })` — threshold 10 means pixels within 10/255 luminance of white are trimmed. Very light garments (off-white, cream) will over-trim.

**How to avoid:** The fallback (full bounds) is already handled gracefully in `detectGarmentBounds()`. The scorer should log a warning when fallback is used but not fail the image solely because of it. Proportion check will still run (with less reliable bounds).

**Warning signs:** Proportion check failing on images that look fine visually; `logger.warn` messages about full-bounds fallback.

### Pitfall 3: Skin-Tone Heuristic False-Positives on Certain Garment Colors

**What goes wrong:** Orange, peach, tan, or cream-colored garments can match the skin-tone RGB range `(R > 95, G > 40, B > 20, R > G > B, R-G > 15)`.

**Why it happens:** The heuristic is designed for human skin but garment colors can overlap.

**How to avoid:** Apply the skin-tone check to the full image at a downsampled resolution (100x100), but only count pixels outside the detected garment region — or calibrate the threshold conservatively (e.g., 15% instead of 5%) to tolerate garment color bleed. During calibration, if orange/peach garments are flagged as on-model, raise the `SKIN_THRESHOLD`.

**Warning signs:** High false-reject rate on orange, peach, tan garments.

### Pitfall 4: Watermark and Print Check Confusion

**What goes wrong:** The watermark check (high-frequency content across full garment) and the print/logo check (high-frequency content in garment center) both use the same Laplacian stdev metric but need different thresholds and region sizes.

**Why it happens:** Both look like high-frequency content but at different spatial scales.

**How to avoid:** Implement them as separate sub-checks with separate thresholds. Print check: center 50% region. Watermark check: full garment region minus center. If full-region stdev is high but center stdev is low, it's likely a watermark (pattern distributed across the surface). If both are high, it could be either — fail with "print or watermark detected."

**Warning signs:** Watermark check and print check triggering simultaneously with identical scores — means they're running the same analysis on the same region.

### Pitfall 5: `extract()` Failing on Out-of-Bounds Region

**What goes wrong:** `sharp(buffer).extract({ left: offsetLeft, top: offsetTop, width: w, height: h })` throws if the region extends beyond the image dimensions. This can happen with the Laplacian stdev check on a center-50% sub-region of the garment.

**Why it happens:** Floating-point math in proportion calculation can produce `left + width > imageWidth` by 1px.

**How to avoid:** Always clamp extracted regions: `Math.min(left + width, imageWidth) - left` for width, same for height.

---

## Code Examples

Verified patterns from sharp 0.34.5 testing (2026-03-26):

### Laplacian Stdev Blur Detection
```typescript
// Source: verified in shell with sharp 0.34.5 — gradient test image
// blur-0: stdev 63.5, blur-10: stdev 32.0, blur-20: stdev 3.1 (monotonically decreasing)
const stats = await sharp(garmentBuffer)
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
  .stats();
const blurScore = stats.channels[0].stdev; // Higher = sharper
```

### Channel Stats for Background Check
```typescript
// Source: verified in shell — pure white image returns mean 255.0 exactly
// Gray (180,180,180) returns mean 180.0 exactly
const stats = await sharp(buffer)
  .extract({ left: 0, top: 0, width: originalWidth, height: offsetTop })
  .stats();
const bgBrightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
```

### Skin-Tone Detection from Raw Buffer
```typescript
// Source: verified in shell — skin (210,150,110) ratio = 1.0, blue garment ratio = 0.0
const raw = await sharp(buffer).resize(100, 100, { fit: 'cover' }).raw().toBuffer();
let skinCount = 0;
for (let i = 0; i < raw.length; i += 3) {
  const r = raw[i], g = raw[i + 1], b = raw[i + 2];
  if (r > 95 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15) skinCount++;
}
const skinRatio = skinCount / (raw.length / 3);
```

### Print Detection on Garment Center
```typescript
// Source: verified in shell — blank solid garment stdev = 0, garment with white logo stdev = 34.97
const centerW = Math.floor(bounds.width * 0.5);
const centerH = Math.floor(bounds.height * 0.5);
const centerStats = await sharp(garmentBuffer)
  .extract({
    left: Math.floor(bounds.width * 0.25),
    top: Math.floor(bounds.height * 0.25),
    width: centerW,
    height: centerH,
  })
  .greyscale()
  .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
  .stats();
const printScore = centerStats.channels[0].stdev;
```

### Resolution from GarmentBounds
```typescript
// No additional sharp call needed — detectGarmentBounds already calls metadata()
const shortSide = Math.min(bounds.width, bounds.height);
// Check against minimum — density/DPI is undefined for most supplier PNGs
```

### Proportion Check Math
```typescript
// Source: verified — REFERENCE_RATIOS.tops.targetHeightFrac = 0.73
// garmentH/canvasH = 0.40 -> outside 15% band = true; 0.73 -> false
const heightFrac = bounds.height / bounds.originalHeight;
const targetFrac = REFERENCE_RATIOS['tops'].targetHeightFrac; // 0.73
const TOLERANCE = 0.20; // calibrated
const pass = Math.abs(heightFrac - targetFrac) <= TOLERANCE;
```

### TypeScript Interface for Result (add to types.ts)
```typescript
/** Per-dimension score results from image quality analysis. */
export interface ImageQualityDimensions {
  blur: number;      // 0-100
  resolution: number; // 0-100
  proportion: number; // 0 or 100
  content: number;   // 0 or 100
}

/** Result from scoreImageQuality() — used by Phase 10 (ranking) and Phase 12 (gating). */
export interface ImageQualityResult {
  score: number;             // 0-100 composite
  verdict: 'pass' | 'fail';
  reasons: string[];         // empty array if pass
  dimensions: ImageQualityDimensions;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OpenCV.js or node-opencv for image analysis | sharp `convolve()` + `stats()` for all metrics | sharp added `convolve()` support in v0.21+ | No native module compilation issues; simpler dependency graph |
| Separate blur detection library (e.g., `opencv4nodejs`) | Sharp-only analysis | sharp 0.34+ has all needed primitives | Zero new dependencies needed for this phase |

**Deprecated/outdated:**
- `sharp.stats().sharpness`: While documented, observed to be non-monotonic with blur level in testing on 0.34.5. Do not use as the primary blur metric — use `convolve()` + `stdev` instead.
- DPI-based resolution checks: `metadata().density` is undefined for most web/supplier PNGs. Use pixel dimensions exclusively.

---

## Open Questions

1. **Category group parameter for proportion check**
   - What we know: `REFERENCE_RATIOS` has different targets for tops (0.73) and hoodies (0.78)
   - What's unclear: Should `scoreImageQuality(buffer)` accept a `categoryGroup` parameter, or use a unified range spanning both?
   - Recommendation: Accept optional `categoryGroup?: CategoryGroup` parameter defaulting to checking against the unified range (0.73-0.78 ± tolerance). Phase 10 and 12 callers can pass the known category when available. This is in Claude's Discretion per D-05.

2. **Watermark detection precision**
   - What we know: Full-garment Laplacian stdev can distinguish between clean and watermarked garments; but at what threshold depends on real supplier samples
   - What's unclear: Whether frequency-domain periodicity detection (DFT) is needed, or whether stdev suffices
   - Recommendation: Start with stdev approach. If calibration shows too many false negatives (watermarked images passing), revisit. DFT would require a new dependency (e.g., `mathjs`) — avoid unless stdev fails clearly.

3. **`detectGarmentBounds` fallback behavior impact on proportion scoring**
   - What we know: When trim fails, bounds returns full image dimensions. Proportion check then computes `originalHeight/originalHeight = 1.0` which will fail (too large).
   - What's unclear: Should a fallback-to-full-bounds condition auto-fail proportion, or should it produce a special "proportion unknown" state?
   - Recommendation: When fallback bounds are detected (offsetLeft + offsetTop = 0 AND width = originalWidth AND height = originalHeight), return proportion score of 50 (neutral) with reason "garment bounds detection failed — proportion unknown." This prevents false proportion fails on images that couldn't be trimmed.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — all analysis uses already-installed sharp 0.34.5; no new tools, services, or CLIs required)

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 (installed) |
| Config file | `vitest.config.ts` (exists — `{ test: { globals: false } }`) |
| Quick run command | `npx vitest run tests/shopify/image-scorer.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| QUAL-01 | `scoreImageQuality(buffer)` returns result with score, verdict, reasons, dimensions | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-01 | Blur check: blurry image scores lower than sharp image | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-02 | Known-blurry image returns `fail`; known-sharp image returns `pass` | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-03 | Calibration script runs and outputs threshold report (manual review) | manual | `npx tsx scripts/calibrate-scorer.ts` | Wave 2 |
| QUAL-04 | White-background garment does not false-reject on background check | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-04 | Skin-tone image returns `fail` with on-model reason | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-04 | Garment with center print returns `fail` with print reason | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-05 | Too-small garment (40% height) returns `fail` with proportion reason | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |
| QUAL-05 | Target-proportion garment (73% height) does not fail proportion check | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/shopify/image-scorer.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/shopify/image-scorer.test.ts` — covers QUAL-01, QUAL-02, QUAL-04, QUAL-05 (all unit tests using synthetic sharp buffers following the existing `image-standardizer.test.ts` pattern)

*(Note: `types.ts` and `vitest.config.ts` already exist. No framework install needed.)*

---

## Sources

### Primary (HIGH confidence)

- sharp 0.34.5 installed binary — `stats()`, `convolve()`, `extract()`, `raw()`, `metadata()` all verified by running actual API calls in this research session
- `src/shopify/image-standardizer.ts` — `detectGarmentBounds()`, `REFERENCE_RATIOS` — read directly from project source
- `tests/shopify/image-standardizer.test.ts` — established test patterns for synthetic buffer generation and sharp-based assertions

### Secondary (MEDIUM confidence)

- sharp documentation (libvips-based): `convolve()` kernel behavior described as standard 2D convolution — consistent with observed Laplacian stdev results
- Standard computer vision literature: Laplacian variance / Laplacian of Gaussian as blur metric — well-established technique, confirmed effective in testing

### Tertiary (LOW confidence)

- Skin-tone RGB heuristic formula `(R > 95, G > 40, B > 20, R > G > B, R-G > 15)` — sourced from general skin detection literature; works correctly in testing on synthetic data but real-world calibration required

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — sharp 0.34.5 verified installed; all API methods tested with real calls
- Architecture: HIGH — patterns derived directly from existing codebase conventions and verified API behavior
- Pitfalls: HIGH — most identified by actually running the API and observing behavior (blur metric non-monotonicity, canvas-dominance issue); skin-tone heuristic pitfall is MEDIUM (synthetic testing only)

**Research date:** 2026-03-26
**Valid until:** 2026-06-26 (stable — sharp API is stable; no version changes expected soon)
