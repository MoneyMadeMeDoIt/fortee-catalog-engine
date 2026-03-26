/**
 * AI image generation prompt templates for garment view synthesis (Phase 10).
 *
 * Implements D-01 (garment-type-aware prompts) and D-02 (color name in prompt).
 * Templates cover all CategoryGroup × AIView combinations.
 */

import type { CategoryGroup } from '../shopify/types.js';
import type { AIView } from './ai-image-types.js';

// ---------------------------------------------------------------------------
// Primary prompt templates
// ---------------------------------------------------------------------------

/**
 * Initial prompt templates per garment type and view.
 * The `{color}` placeholder is replaced by buildPrompt() with the garment's color name.
 */
export const PROMPT_TEMPLATES: Record<CategoryGroup, Record<AIView, string>> = {
  tops: {
    back: 'Back view of this {color} t-shirt on a plain white background, blank garment, no print, no text, no model, same color as input image.',
    side: 'Side view of this {color} t-shirt on a plain white background, blank garment, no print, no text, no model, same color as input image.',
  },
  hoodies: {
    back: 'Back view of this {color} hoodie on a plain white background, blank garment, no print, no text, no model, hood down, same color as input image.',
    side: 'Side view of this {color} hoodie on a plain white background, blank garment, no print, no text, no model, same color as input image.',
  },
};

// ---------------------------------------------------------------------------
// Retry prompt templates (stronger color instruction — per D-04)
// ---------------------------------------------------------------------------

/**
 * Retry prompts used when all initial candidates fail hue drift or quality checks.
 * Uses stronger, repeated color emphasis to improve color fidelity on second attempt.
 *
 * Note: `{color}` appears twice in each retry template — both occurrences are replaced.
 */
export const RETRY_PROMPT_TEMPLATES: Record<CategoryGroup, Record<AIView, string>> = {
  tops: {
    back: 'Back view of this exact {color} t-shirt. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
    side: 'Side view of this exact {color} t-shirt. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
  },
  hoodies: {
    back: 'Back view of this exact {color} hoodie. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person. Hood is down.',
    side: 'Side view of this exact {color} hoodie. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
  },
};

// ---------------------------------------------------------------------------
// Front image cleanup prompt (per D-05)
// ---------------------------------------------------------------------------

/**
 * Prompt for AI enhancement of failing front images via images.edit().
 * Uses the real garment as input — does not generate from scratch.
 */
export const CLEANUP_PROMPT =
  'Clean up this garment photo: remove blur, improve lighting, plain white background. Keep the exact same garment, same color, same angle. No print, no text, no model.';

// ---------------------------------------------------------------------------
// Builder functions
// ---------------------------------------------------------------------------

/**
 * Builds a generation prompt for a specific garment type, view, and color.
 *
 * Replaces all `{color}` occurrences in the template with the provided colorName.
 */
export function buildPrompt(
  garmentType: CategoryGroup,
  view: AIView,
  colorName: string,
): string {
  return PROMPT_TEMPLATES[garmentType][view].replace(/\{color\}/g, colorName);
}

/**
 * Builds a retry prompt for a specific garment type, view, and color.
 *
 * Uses the stronger retry templates with doubled color instruction.
 * Replaces all `{color}` occurrences with the provided colorName.
 */
export function buildRetryPrompt(
  garmentType: CategoryGroup,
  view: AIView,
  colorName: string,
): string {
  return RETRY_PROMPT_TEMPLATES[garmentType][view].replace(/\{color\}/g, colorName);
}
