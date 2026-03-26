/**
 * Core types and constants for the AI image generation pipeline (Phase 10).
 *
 * AI only generates back/side views — front images are sourced or enhanced, not generated.
 */

// ---------------------------------------------------------------------------
// View type
// ---------------------------------------------------------------------------

/** Views that AI generation produces. Front is sourced, not generated. */
export type AIView = 'back' | 'side';

// ---------------------------------------------------------------------------
// Cost constants (gpt-image-1, medium quality, 1024x1024 — per D-07 research)
// ---------------------------------------------------------------------------

/** Cost per image at medium quality, 1024x1024. */
export const COST_PER_IMAGE = 0.042;

/** Max API calls per view: 3 initial (n=3) + 3 retry (n=3) — per D-06. */
export const MAX_CALLS_PER_VIEW = 6;

/** Number of candidates generated per API call (n parameter) — per D-03. */
export const CANDIDATES_PER_CALL = 3;

// ---------------------------------------------------------------------------
// Quality / hue constants
// ---------------------------------------------------------------------------

/** Maximum allowed hue drift in degrees before a candidate is rejected — per D-03. */
export const HUE_DRIFT_THRESHOLD = 15;

/**
 * RGB max-min delta below which a color is considered achromatic (white/black/gray).
 * Achromatic garments bypass the hue check entirely — per research Pattern 2.
 * Scale: 0-255.
 */
export const ACHROMATIC_THRESHOLD = 25;

// ---------------------------------------------------------------------------
// Budget constant
// ---------------------------------------------------------------------------

/** Global budget cap in dollars — per D-07. */
export const DEFAULT_BUDGET = 200;

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

/** Result from a single generateGarmentView() call. */
export interface GenerateViewResult {
  /** Generated image as a PNG buffer. */
  buffer: Buffer;
  /** Quality score from scoreImageQuality() (0–100). */
  score: number;
  /** Verdict from quality scorer. */
  verdict: 'pass' | 'fail';
  /** Total API cost for this view's calls (all candidates, both rounds). */
  totalCost: number;
  /** Number of API calls made for this view. */
  callCount: number;
  /** Whether the retry round was triggered. */
  usedRetry: boolean;
  /** Hue drift (degrees) of the selected candidate vs. the front image. */
  hueDrift: number;
}

/** Result from enhanceFrontImage() — AI cleanup of a failing front image. */
export interface EnhanceFrontResult {
  /** Enhanced image as a PNG buffer. */
  buffer: Buffer;
  /** Quality score from scoreImageQuality() (0–100). */
  score: number;
  /** Verdict from quality scorer. */
  verdict: 'pass' | 'fail';
  /** API cost for the enhancement call. */
  cost: number;
}
