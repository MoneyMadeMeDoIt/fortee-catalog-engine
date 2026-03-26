import { describe, it, expect } from 'vitest';
import { rgbToHue, hueDrift, isAchromatic, extractDominantHue } from '../../src/lib/hue-utils.js';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// rgbToHue
// ---------------------------------------------------------------------------

describe('rgbToHue', () => {
  it('returns 0 for red (255, 0, 0)', () => {
    expect(rgbToHue(255, 0, 0)).toBe(0);
  });

  it('returns 120 for green (0, 255, 0)', () => {
    expect(rgbToHue(0, 255, 0)).toBe(120);
  });

  it('returns 240 for blue (0, 0, 255)', () => {
    expect(rgbToHue(0, 0, 255)).toBe(240);
  });

  it('returns 0 for achromatic gray (128, 128, 128)', () => {
    expect(rgbToHue(128, 128, 128)).toBe(0);
  });

  it('returns 0 for black (0, 0, 0)', () => {
    expect(rgbToHue(0, 0, 0)).toBe(0);
  });

  it('returns 0 for white (255, 255, 255)', () => {
    expect(rgbToHue(255, 255, 255)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hueDrift
// ---------------------------------------------------------------------------

describe('hueDrift', () => {
  it('returns 20 for hues 10 and 350 (circular wrap)', () => {
    expect(hueDrift(10, 350)).toBe(20);
  });

  it('returns 0 when both hues are identical', () => {
    expect(hueDrift(0, 0)).toBe(0);
  });

  it('returns 180 for maximum drift (0 and 180)', () => {
    expect(hueDrift(180, 0)).toBe(180);
  });

  it('is commutative', () => {
    expect(hueDrift(30, 300)).toBe(hueDrift(300, 30));
  });

  it('returns correct non-circular drift for close hues', () => {
    expect(hueDrift(60, 80)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// isAchromatic
// ---------------------------------------------------------------------------

describe('isAchromatic', () => {
  it('returns true for neutral gray (128, 128, 128)', () => {
    expect(isAchromatic({ r: 128, g: 128, b: 128 })).toBe(true);
  });

  it('returns true when delta is just under 25 (128, 128, 150 — delta=22)', () => {
    expect(isAchromatic({ r: 128, g: 128, b: 150 })).toBe(true);
  });

  it('returns false for vibrant red (200, 50, 50 — delta=150)', () => {
    expect(isAchromatic({ r: 200, g: 50, b: 50 })).toBe(false);
  });

  it('returns true for white (255, 255, 255)', () => {
    expect(isAchromatic({ r: 255, g: 255, b: 255 })).toBe(true);
  });

  it('returns true for black (0, 0, 0)', () => {
    expect(isAchromatic({ r: 0, g: 0, b: 0 })).toBe(true);
  });

  it('returns false for a clearly saturated color (0, 128, 0 — delta=128)', () => {
    expect(isAchromatic({ r: 0, g: 128, b: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractDominantHue
// ---------------------------------------------------------------------------

describe('extractDominantHue', () => {
  it('returns achromatic=false for a solid red 1x1 PNG', async () => {
    const buffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await extractDominantHue(buffer);

    // Red is not achromatic
    expect(result.achromatic).toBe(false);
    // Hue should be 0 (red)
    expect(result.hue).toBe(0);
    // sharp's 4096-bin histogram rounds dominant color — allow ±10 from exact pixel value
    expect(result.rgb.r).toBeGreaterThan(240);
    expect(result.rgb.g).toBeLessThan(20);
    expect(result.rgb.b).toBeLessThan(20);
  });

  it('returns achromatic=true for a solid gray 1x1 PNG', async () => {
    const buffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toBuffer();

    const result = await extractDominantHue(buffer);
    expect(result.achromatic).toBe(true);
  });

  it('returns hue=240 for a solid blue 1x1 PNG', async () => {
    const buffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await extractDominantHue(buffer);
    expect(result.hue).toBe(240);
    expect(result.achromatic).toBe(false);
  });
});
