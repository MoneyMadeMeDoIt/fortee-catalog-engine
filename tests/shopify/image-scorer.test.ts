import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { scoreImageQuality } from '../../src/shopify/image-scorer.js';

// ---------------------------------------------------------------------------
// Synthetic image helpers
// ---------------------------------------------------------------------------

/**
 * Create a garment image with wide vertical stripes on a 1000x1000 white canvas.
 *
 * 50px vertical stripes simulate fabric texture:
 * - Sharp image: inset stdev ~25 → passes blur detection (>20 threshold)
 * - Center stdev ~25 → passes print check (<30 threshold)
 * - On white background → passes background check
 *
 * Used as the baseline "good quality" test image.
 */
async function makeSharpGarmentImage(): Promise<Buffer> {
  const stripeWidth = 50;
  const garmentW = 500;
  const garmentH = 600; // taller garment for realistic proportion (~60% of 1000px canvas)

  const garmentData = Buffer.alloc(garmentW * garmentH * 3);
  for (let y = 0; y < garmentH; y++) {
    for (let x = 0; x < garmentW; x++) {
      const isLight = Math.floor(x / stripeWidth) % 2 === 0;
      const idx = (y * garmentW + x) * 3;
      garmentData[idx] = isLight ? 200 : 155;      // R
      garmentData[idx + 1] = isLight ? 50 : 42;    // G
      garmentData[idx + 2] = isLight ? 50 : 42;    // B
    }
  }

  const garment = await sharp(garmentData, {
    raw: { width: garmentW, height: garmentH, channels: 3 },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: garment, left: 250, top: 100 }])
    .png()
    .toBuffer();
}

/**
 * Create a blurry garment image by applying sigma=20 Gaussian blur to a striped garment.
 * After blur(20), the 50px stripe's inner region stdev drops below the 20-threshold → FAIL.
 */
async function makeBlurryGarmentImage(): Promise<Buffer> {
  const base = await makeSharpGarmentImage();
  return sharp(base).blur(20).png().toBuffer();
}

/**
 * A 1000x1000 white canvas with a tiny 50x50 red garment in the center.
 * The garment occupies 5% height — far below any reasonable proportion threshold.
 */
async function makeTinyGarmentImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: garment, left: 475, top: 475 }])
    .png()
    .toBuffer();
}

/**
 * A 1000x1000 white canvas with a 500x600 red garment that has a bold checkered
 * print pattern (100x100 black/white tiles) in the center region, simulating an
 * existing logo. The high-contrast checkered pattern creates center stdev well above
 * the PRINT_CENTER_STDEV threshold (30).
 */
async function makePrintGarmentImage(): Promise<Buffer> {
  const garmentW = 500;
  const garmentH = 600;

  // Create garment with a checkered print in the center (rows 200-400, cols 150-350)
  const garmentData = Buffer.alloc(garmentW * garmentH * 3);
  const tileSize = 25;
  for (let y = 0; y < garmentH; y++) {
    for (let x = 0; x < garmentW; x++) {
      const idx = (y * garmentW + x) * 3;
      // Check if pixel is in the print area (center region)
      if (x >= 125 && x < 375 && y >= 150 && y < 450) {
        // Checkered print: black or white tiles
        const tileX = Math.floor((x - 125) / tileSize) % 2;
        const tileY = Math.floor((y - 150) / tileSize) % 2;
        const isWhiteTile = (tileX + tileY) % 2 === 0;
        garmentData[idx] = isWhiteTile ? 240 : 20;
        garmentData[idx + 1] = isWhiteTile ? 240 : 20;
        garmentData[idx + 2] = isWhiteTile ? 240 : 20;
      } else {
        // Plain red garment body
        garmentData[idx] = 200;
        garmentData[idx + 1] = 50;
        garmentData[idx + 2] = 50;
      }
    }
  }

  const garment = await sharp(garmentData, {
    raw: { width: garmentW, height: garmentH, channels: 3 },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: garment, left: 250, top: 100 }])
    .png()
    .toBuffer();
}

/**
 * A 1000x1000 image fully filled with skin-tone pixels (R=210, G=150, B=110).
 */
async function makeSkinToneImage(): Promise<Buffer> {
  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 210, g: 150, b: 110 } },
  })
    .png()
    .toBuffer();
}

/**
 * A 1000x1000 gray-background image (RGB 150,150,150) with a 500x600 red garment.
 */
async function makeGrayBackgroundImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 500, height: 600, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 150, g: 150, b: 150 } },
  })
    .composite([{ input: garment, left: 250, top: 100 }])
    .png()
    .toBuffer();
}

/**
 * A 200x200 image with a 100x80 red rectangle — garment region is too small.
 */
async function makeLowResolutionImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  return sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: garment, left: 50, top: 60 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreImageQuality', () => {
  it('returns an object with score, verdict, reasons, and dimensions', async () => {
    const buffer = await makeSharpGarmentImage();
    const result = await scoreImageQuality(buffer);

    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('verdict');
    expect(result).toHaveProperty('reasons');
    expect(result).toHaveProperty('dimensions');

    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);

    expect(['pass', 'fail']).toContain(result.verdict);
    expect(Array.isArray(result.reasons)).toBe(true);

    expect(result.dimensions).toHaveProperty('blur');
    expect(result.dimensions).toHaveProperty('resolution');
    expect(result.dimensions).toHaveProperty('proportion');
    expect(result.dimensions).toHaveProperty('content');
  });

  it('a sharp striped garment on 1000x1000 white canvas scores pass', async () => {
    const buffer = await makeSharpGarmentImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
    expect(result.score).toBeGreaterThan(50);
  });

  it('a heavily blurred image (sigma 20) scores fail with blur reason', async () => {
    const buffer = await makeBlurryGarmentImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const blurReason = result.reasons.find((r) => r.toLowerCase().includes('blurry'));
    expect(blurReason).toBeDefined();
  });

  it('a tiny garment (50x50 on 1000x1000) scores fail with proportion reason', async () => {
    const buffer = await makeTinyGarmentImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const proportionReason = result.reasons.find((r) =>
      r.toLowerCase().includes('proportion')
    );
    expect(proportionReason).toBeDefined();
  });

  it('an image with a high-contrast center pattern scores fail with print or logo reason', async () => {
    const buffer = await makePrintGarmentImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const printReason = result.reasons.find(
      (r) => r.toLowerCase().includes('print') || r.toLowerCase().includes('logo')
    );
    expect(printReason).toBeDefined();
  });

  it('an image with dominant skin-tone pixels scores fail with on-model reason', async () => {
    const buffer = await makeSkinToneImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const skinReason = result.reasons.find((r) => r.toLowerCase().includes('on-model'));
    expect(skinReason).toBeDefined();
  });

  it('a garment on a gray background scores fail with not-white or Background reason', async () => {
    const buffer = await makeGrayBackgroundImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const bgReason = result.reasons.find(
      (r) => r.toLowerCase().includes('not white') || r.toLowerCase().includes('background')
    );
    expect(bgReason).toBeDefined();
  });

  it('a white-background garment with good quality does NOT fail on background check', async () => {
    const buffer = await makeSharpGarmentImage();
    const result = await scoreImageQuality(buffer);

    const bgReason = result.reasons.find(
      (r) => r.toLowerCase().includes('not white') || r.toLowerCase().includes('background')
    );
    expect(bgReason).toBeUndefined();
  });

  it('a low-resolution image scores fail with resolution reason', async () => {
    const buffer = await makeLowResolutionImage();
    const result = await scoreImageQuality(buffer);

    expect(result.verdict).toBe('fail');
    const resReason = result.reasons.find((r) => r.toLowerCase().includes('resolution'));
    expect(resReason).toBeDefined();
  });
});
