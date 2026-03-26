/**
 * Hue comparison utilities for AI image color drift detection (AIGEN-04).
 *
 * Uses sharp.stats().dominant (4096-bin histogram) to extract dominant color,
 * then compares hue angles to detect color drift in AI-generated garment images.
 */

import sharp from 'sharp';
import { ACHROMATIC_THRESHOLD } from './ai-image-types.js';

// ---------------------------------------------------------------------------
// RGB to HSL hue conversion
// ---------------------------------------------------------------------------

/**
 * Converts an RGB color to its HSL hue angle in degrees (0–360).
 *
 * Returns 0 for achromatic colors (white, black, gray) where hue is undefined.
 */
export function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  if (delta === 0) return 0; // achromatic

  let h = 0;
  if (max === rn) {
    h = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    h = (bn - rn) / delta + 2;
  } else {
    h = (rn - gn) / delta + 4;
  }

  return ((h * 60) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Circular hue distance
// ---------------------------------------------------------------------------

/**
 * Computes the circular angular distance between two hue values in degrees.
 *
 * Returns a value in [0, 180]. Wraps around 360 correctly.
 * Example: hueDrift(10, 350) === 20 (not 340).
 */
export function hueDrift(hue1: number, hue2: number): number {
  const diff = Math.abs(hue1 - hue2);
  return Math.min(diff, 360 - diff);
}

// ---------------------------------------------------------------------------
// Achromatic detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the RGB color is achromatic (white, black, or neutral gray).
 *
 * Achromatic garments have no meaningful hue, so the hue drift check should be
 * skipped for them. Threshold: max-min < ACHROMATIC_THRESHOLD (25 in RGB 0-255).
 */
export function isAchromatic(rgb: { r: number; g: number; b: number }): boolean {
  const { r, g, b } = rgb;
  return Math.max(r, g, b) - Math.min(r, g, b) < ACHROMATIC_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Dominant hue extraction from image buffer
// ---------------------------------------------------------------------------

/**
 * Extracts the dominant hue from an image buffer using sharp's 4096-bin
 * 3D color histogram (stats().dominant).
 *
 * Returns the hue angle, whether the dominant color is achromatic, and the
 * raw RGB values for debugging.
 */
export async function extractDominantHue(buffer: Buffer): Promise<{
  hue: number;
  achromatic: boolean;
  rgb: { r: number; g: number; b: number };
}> {
  const stats = await sharp(buffer).stats();
  const rgb = stats.dominant;
  const achromatic = isAchromatic(rgb);
  const hue = achromatic ? 0 : rgbToHue(rgb.r, rgb.g, rgb.b);

  return { hue, achromatic, rgb };
}
