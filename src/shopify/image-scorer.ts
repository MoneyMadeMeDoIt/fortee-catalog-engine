import sharp from 'sharp';
import { detectGarmentBounds, REFERENCE_RATIOS } from './image-standardizer.js';
import { logger } from '../lib/logger.js';
import type { ImageQualityResult, GarmentBounds, CategoryGroup } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DimensionResult {
  score: number;   // 0-100
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Exported threshold constants (calibrated in Plan 02 against 243 real images)
// ---------------------------------------------------------------------------

export const QUALITY_THRESHOLDS = {
  // Calibrated against 243 real Shopify supplier images (2026-03-26).
  // Real image sharpness: min 1.1, max 20.0, mean 8.2, p90 17.5 — threshold of 1.5
  // catches only truly unusable blurry images while passing normal supplier photos.
  BLUR_MIN_STDEV: 1.5,
  MIN_GARMENT_PX: 400,
  PROPORTION_TOLERANCE: 0.25,
  // Real content scores on blank garments: 30–95 due to fabric texture and color variation.
  // Threshold of 100 ensures only images with clear existing prints/logos fail.
  PRINT_CENTER_STDEV: 100.0,
  // Ghost mannequin shots and some garment colors trigger false positives at 0.05.
  // Threshold of 0.30 requires a substantial skin-tone area — clear on-model photos only.
  SKIN_RATIO: 0.30,
  BG_WHITE_MIN: 230,
  // Normal garment images have high edge variance (31–115) from fabric texture.
  // Threshold of 120 catches only true watermark overlays — not texture-induced variance.
  WATERMARK_FULL_STDEV: 120.0,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a product image across four quality dimensions and return a structured
 * pass/fail result suitable for Phase 10 candidate ranking and Phase 12 gating.
 *
 * @param buffer - Raw image buffer (any format sharp supports)
 * @param categoryGroup - Optional garment category for proportion check context
 */
export async function scoreImageQuality(
  buffer: Buffer,
  categoryGroup?: CategoryGroup,
): Promise<ImageQualityResult> {
  const bounds = await detectGarmentBounds(buffer);

  // Extract trimmed garment region once — content checks operate on this
  const garmentBuffer = await sharp(buffer)
    .extract({
      left: bounds.offsetLeft,
      top: bounds.offsetTop,
      width: bounds.width,
      height: bounds.height,
    })
    .png()
    .toBuffer();

  // Extract a 30%-inset garment region for blur detection.
  // Inset avoids the edge bleed from blur spreading garment color into the background,
  // which would otherwise inflate stdev and make blurry images appear sharper.
  // The inner region stdev drops monotonically as blur increases — reliable detection.
  const blurBuffer = await extractInsetGarment(garmentBuffer, bounds, 0.30);

  const [blurResult, resolutionResult, proportionResult, contentResult] = await Promise.all([
    checkBlur(blurBuffer),
    Promise.resolve(checkResolution(bounds)),
    Promise.resolve(checkProportion(bounds, categoryGroup)),
    checkContentSuitability(buffer, garmentBuffer, bounds),
  ]);

  const reasons = [
    ...blurResult.reasons,
    ...resolutionResult.reasons,
    ...proportionResult.reasons,
    ...contentResult.reasons,
  ];

  const score = Math.round(
    blurResult.score * 0.3 +
    resolutionResult.score * 0.2 +
    proportionResult.score * 0.2 +
    contentResult.score * 0.3,
  );

  const verdict: 'pass' | 'fail' = reasons.length > 0 ? 'fail' : 'pass';

  logger.debug(
    `scoreImageQuality: score=${score} verdict=${verdict} reasons=${reasons.length}`,
  );

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the inner portion of the garment region by inset fraction.
 * Inset = 0.30 removes 30% from each edge, keeping the inner 40%x40% of the garment.
 * This removes the garment-to-background transition zone that causes blur spreading,
 * and ensures the stdev measured decreases monotonically with blur level.
 */
async function extractInsetGarment(
  garmentBuffer: Buffer,
  bounds: GarmentBounds,
  insetFrac: number,
): Promise<Buffer> {
  const shortSide = Math.min(bounds.width, bounds.height);
  const inset = Math.floor(shortSide * insetFrac);

  const left = inset;
  const top = inset;
  const width = Math.max(1, bounds.width - 2 * inset);
  const height = Math.max(1, bounds.height - 2 * inset);

  if (inset <= 0 || width <= 0 || height <= 0) {
    return garmentBuffer;
  }

  return sharp(garmentBuffer)
    .extract({ left, top, width, height })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Dimension checks
// ---------------------------------------------------------------------------

// Below this stdev, the inset region is considered solid-color (no detectable texture).
// Solid-color garments cannot be assessed for blur — return neutral score.
const SOLID_COLOR_STDEV_THRESHOLD = 1.0;

/**
 * Blur detection using Laplacian stdev on the inset garment region.
 *
 * The inset region (inner 40%) excludes garment edge zones where blur spreading
 * from background creates artificially high-frequency content. The inner region's
 * stdev decreases monotonically as blur increases — reliable for real garment textures.
 *
 * Solid-color garments have zero inner stdev (no texture to blur), so they get a
 * neutral score of 100 to avoid penalizing uniformly-colored products. This behavior
 * is calibrated in Plan 02 against real supplier images.
 */
async function checkBlur(insetGarmentBuffer: Buffer): Promise<DimensionResult> {
  const stats = await sharp(insetGarmentBuffer)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .stats();
  const stdev = stats.channels[0].stdev;

  // Solid-color garment: no detectable texture — skip blur assessment
  if (stdev < SOLID_COLOR_STDEV_THRESHOLD) {
    return { score: 100, reasons: [] };
  }

  const { BLUR_MIN_STDEV } = QUALITY_THRESHOLDS;
  const pass = stdev >= BLUR_MIN_STDEV;

  return {
    score: Math.min(100, Math.round((stdev / BLUR_MIN_STDEV) * 100)),
    reasons: pass
      ? []
      : [`Image is too blurry (sharpness: ${stdev.toFixed(1)}, min: ${BLUR_MIN_STDEV})`],
  };
}

/**
 * Resolution check using trimmed garment pixel dimensions.
 * No additional sharp call needed — detectGarmentBounds already called metadata().
 */
function checkResolution(bounds: GarmentBounds): DimensionResult {
  const { MIN_GARMENT_PX } = QUALITY_THRESHOLDS;
  const shortSide = Math.min(bounds.width, bounds.height);
  const pass = shortSide >= MIN_GARMENT_PX;

  return {
    score: Math.min(100, Math.round((shortSide / MIN_GARMENT_PX) * 100)),
    reasons: pass
      ? []
      : [
          `Garment resolution too low: ${bounds.width}x${bounds.height}px (min: ${MIN_GARMENT_PX}px short side)`,
        ],
  };
}

/**
 * Proportion check: garment height fraction of canvas vs REFERENCE_RATIOS target range.
 *
 * Fallback bounds detection: when trim returned full-image bounds (all offsets = 0 AND
 * width/height equal original), return neutral score to avoid false proportion fails.
 */
function checkProportion(bounds: GarmentBounds, _categoryGroup?: CategoryGroup): DimensionResult {
  // Detect fallback bounds (detectGarmentBounds returned full image dimensions)
  const isFallback =
    bounds.offsetLeft === 0 &&
    bounds.offsetTop === 0 &&
    bounds.width === bounds.originalWidth &&
    bounds.height === bounds.originalHeight;

  if (isFallback) {
    return {
      score: 50,
      reasons: ['Garment bounds detection failed — proportion unknown'],
    };
  }

  const { PROPORTION_TOLERANCE } = QUALITY_THRESHOLDS;
  const heightFrac = bounds.height / bounds.originalHeight;

  const minFrac =
    Math.min(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) -
    PROPORTION_TOLERANCE;
  const maxFrac =
    Math.max(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) +
    PROPORTION_TOLERANCE;

  const pass = heightFrac >= minFrac && heightFrac <= maxFrac;

  return {
    score: pass ? 100 : 0,
    reasons: pass
      ? []
      : [
          `Garment proportion out of range: ${(heightFrac * 100).toFixed(0)}% height (expected ${(minFrac * 100).toFixed(0)}–${(maxFrac * 100).toFixed(0)}%)`,
        ],
  };
}

/**
 * Content suitability — four sub-checks:
 * 5a. Existing print/logo (high-frequency content in garment center)
 * 5b. On-model detection (skin-tone pixel ratio OUTSIDE garment bounds)
 * 5c. Non-white background (above-garment strip brightness + corner check)
 * 5d. Watermark detection (full-garment Laplacian stdev vs center stdev pattern)
 */
async function checkContentSuitability(
  originalBuffer: Buffer,
  garmentBuffer: Buffer,
  bounds: GarmentBounds,
): Promise<DimensionResult> {
  const reasons: string[] = [];
  const w = bounds.width;
  const h = bounds.height;

  // 5a: Print/logo detection — center 50% of garment region
  const centerLeft = Math.floor(w * 0.25);
  const centerTop = Math.floor(h * 0.25);
  const centerWidth = Math.min(Math.floor(w * 0.5), w - centerLeft);
  const centerHeight = Math.min(Math.floor(h * 0.5), h - centerTop);

  let centerStdev = 0;
  if (centerWidth > 0 && centerHeight > 0) {
    // Extract center region to buffer first, then apply greyscale + convolve + stats
    // (avoids sharp extract+stats chaining issue where stats() evaluates original input)
    const centerBuf = await sharp(garmentBuffer)
      .extract({ left: centerLeft, top: centerTop, width: centerWidth, height: centerHeight })
      .toBuffer();
    const centerStats = await sharp(centerBuf)
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
      .stats();

    centerStdev = centerStats.channels[0].stdev;
    const { PRINT_CENTER_STDEV } = QUALITY_THRESHOLDS;
    if (centerStdev > PRINT_CENTER_STDEV) {
      reasons.push(
        `Garment appears to have existing print/logo (content score: ${centerStdev.toFixed(1)})`,
      );
    }
  }

  // 5b: On-model detection — skin-tone pixel ratio on 100x100 downsample
  // Strategy:
  //   - When garment bounds are reliable (non-fallback), only count pixels OUTSIDE the
  //     garment bounding box to avoid false positives from garment colors (e.g., red,
  //     orange, tan) that overlap with skin-tone ranges.
  //   - When bounds are fallback (full image), count ALL pixels since we cannot isolate
  //     the background — if the whole image is skin-tone, it's likely an on-model photo.
  const isFallbackBounds =
    bounds.offsetLeft === 0 &&
    bounds.offsetTop === 0 &&
    bounds.width === bounds.originalWidth &&
    bounds.height === bounds.originalHeight;

  // Force 3-channel RGB to ensure predictable stride in the raw pixel buffer.
  // The source image may be RGBA (4 channels), which would misalign our stride-3 loop.
  const raw = await sharp(originalBuffer)
    .resize(100, 100, { fit: 'cover' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();

  let skinPixels = 0;
  let countedPixels = 0;

  if (isFallbackBounds) {
    // Count all pixels when we can't distinguish garment from background
    for (let i = 0; i < raw.length; i += 3) {
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      countedPixels++;
      if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15) {
        skinPixels++;
      }
    }
  } else {
    // Scale garment bounds to 100x100 for masking
    const scaleX = 100 / bounds.originalWidth;
    const scaleY = 100 / bounds.originalHeight;
    const garmentLeft100 = Math.floor(bounds.offsetLeft * scaleX);
    const garmentTop100 = Math.floor(bounds.offsetTop * scaleY);
    const garmentRight100 = Math.ceil((bounds.offsetLeft + bounds.width) * scaleX);
    const garmentBottom100 = Math.ceil((bounds.offsetTop + bounds.height) * scaleY);

    for (let py = 0; py < 100; py++) {
      for (let px = 0; px < 100; px++) {
        // Skip pixels inside the garment region
        if (
          px >= garmentLeft100 &&
          px < garmentRight100 &&
          py >= garmentTop100 &&
          py < garmentBottom100
        ) {
          continue;
        }
        const i = (py * 100 + px) * 3;
        const r = raw[i];
        const g = raw[i + 1];
        const b = raw[i + 2];
        countedPixels++;
        if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15) {
          skinPixels++;
        }
      }
    }
  }

  if (countedPixels > 0) {
    const skinRatio = skinPixels / countedPixels;
    const { SKIN_RATIO } = QUALITY_THRESHOLDS;
    if (skinRatio > SKIN_RATIO) {
      reasons.push(
        `Image appears to show an on-model photo (skin-tone ratio: ${(skinRatio * 100).toFixed(1)}%)`,
      );
    }
  }

  // 5c: Background whiteness check
  // Primary: use top strip above garment (if offsetTop >= 10, skip last 5px to avoid edge bleed)
  // Fallback: sample image corners when offsetTop < 10 (catches non-white backgrounds even when
  // bounds detection falls back to full-image dimensions)
  //
  // IMPORTANT: sharp's .extract().stats() does not chain — stats() evaluates the original
  // input, not the extracted region. Always .toBuffer() first, then .stats() on the result.
  const { BG_WHITE_MIN } = QUALITY_THRESHOLDS;
  const stripHeight = bounds.offsetTop - 5;

  if (stripHeight >= 5) {
    // Extract to buffer first, THEN compute stats (avoids sharp extract+stats chaining bug)
    const bgBuf = await sharp(originalBuffer)
      .extract({ left: 0, top: 0, width: bounds.originalWidth, height: stripHeight })
      .toBuffer();
    const bgStats = await sharp(bgBuf).stats();

    const mean =
      (bgStats.channels[0].mean + bgStats.channels[1].mean + bgStats.channels[2].mean) / 3;
    if (mean < BG_WHITE_MIN) {
      reasons.push(
        `Background is not white (mean brightness: ${mean.toFixed(0)}, min: ${BG_WHITE_MIN})`,
      );
    }
  } else {
    // Corner sampling fallback — check 20x20 corners to detect non-white backgrounds
    const cornerMeans = await sampleImageCorners(originalBuffer, 20);
    const cornerMean = cornerMeans.reduce((a, b) => a + b, 0) / cornerMeans.length;
    if (cornerMean < BG_WHITE_MIN) {
      reasons.push(
        `Background is not white (mean brightness: ${cornerMean.toFixed(0)}, min: ${BG_WHITE_MIN})`,
      );
    }
  }

  // 5d: Watermark detection — full garment Laplacian stdev
  // If full-garment stdev is high but center stdev was low, the pattern is distributed
  // across the surface (watermark) rather than localized (print/logo).
  const fullStats = await sharp(garmentBuffer)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .stats();

  const fullStdev = fullStats.channels[0].stdev;
  const { WATERMARK_FULL_STDEV, PRINT_CENTER_STDEV } = QUALITY_THRESHOLDS;
  if (fullStdev > WATERMARK_FULL_STDEV && centerStdev < PRINT_CENTER_STDEV) {
    reasons.push(`Image appears to have watermark overlay (edge score: ${fullStdev.toFixed(1)})`);
  }

  return {
    score: reasons.length === 0 ? 100 : 0,
    reasons,
  };
}

/**
 * Sample mean brightness from all four 20x20 corners of an image.
 * Used as background check fallback when garment fills most of the canvas.
 */
async function sampleImageCorners(buffer: Buffer, cornerSize: number): Promise<number[]> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? 100;
  const h = meta.height ?? 100;
  const cs = Math.min(cornerSize, Math.floor(w / 4), Math.floor(h / 4));

  const corners = [
    { left: 0, top: 0 },
    { left: w - cs, top: 0 },
    { left: 0, top: h - cs },
    { left: w - cs, top: h - cs },
  ];

  const means: number[] = [];
  for (const { left, top } of corners) {
    // Always toBuffer() before stats() — sharp extract().stats() chaining doesn't work
    const cornerBuf = await sharp(buffer).extract({ left, top, width: cs, height: cs }).toBuffer();
    const stats = await sharp(cornerBuf).stats();
    const mean = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
    means.push(mean);
  }
  return means;
}
