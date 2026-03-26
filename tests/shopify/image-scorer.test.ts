import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { scoreImageQuality } from '../../src/shopify/image-scorer.js';

// ---------------------------------------------------------------------------
// Synthetic image helpers
// ---------------------------------------------------------------------------

/**
 * Create a sharp 1000x1000 white-background image with a 500x500 red garment
 * centered in the canvas.
 */
async function makeSharpGarmentImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 200, g: 50, b: 50 } },
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
 * Same as makeSharpGarmentImage but with blur(20) applied to simulate a blurry image.
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
 * A 1000x1000 white canvas with a 500x500 red garment that has a 200x200 white
 * rectangle composited in the center, simulating an existing print or logo.
 */
async function makePrintGarmentImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  // Composite a bright white rectangle in the center of the garment
  const logo = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();

  const garmentWithPrint = await sharp(garment)
    .composite([{ input: logo, left: 150, top: 150 }])
    .png()
    .toBuffer();

  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: garmentWithPrint, left: 250, top: 100 }])
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
 * A 1000x1000 gray-background image (RGB 150,150,150) with a 500x500 red garment.
 */
async function makeGrayBackgroundImage(): Promise<Buffer> {
  const garment = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 200, g: 50, b: 50 } },
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

  it('a sharp 500x500 garment on 1000x1000 white canvas scores pass', async () => {
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
