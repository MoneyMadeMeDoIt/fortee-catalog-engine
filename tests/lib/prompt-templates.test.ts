import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  buildRetryPrompt,
  PROMPT_TEMPLATES,
  RETRY_PROMPT_TEMPLATES,
  CLEANUP_PROMPT,
} from '../../src/lib/prompt-templates.js';
import type { CategoryGroup } from '../../src/shopify/types.js';
import type { AIView } from '../../src/lib/ai-image-types.js';

// ---------------------------------------------------------------------------
// buildPrompt — basic color substitution
// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('contains the color name for tops/back', () => {
    const result = buildPrompt('tops', 'back', 'navy blue');
    expect(result).toContain('navy blue');
  });

  it('contains "Back view" for tops/back', () => {
    const result = buildPrompt('tops', 'back', 'navy blue');
    expect(result).toContain('Back view');
  });

  it('contains color, "Side view", and "hoodie" for hoodies/side', () => {
    const result = buildPrompt('hoodies', 'side', 'red');
    expect(result).toContain('red');
    expect(result).toContain('Side view');
    expect(result).toContain('hoodie');
  });

  it('does not leave {color} placeholder in output', () => {
    const result = buildPrompt('tops', 'side', 'forest green');
    expect(result).not.toContain('{color}');
  });

  it('replaces color in tops/side prompt', () => {
    const result = buildPrompt('tops', 'side', 'white');
    expect(result).toContain('white');
    expect(result).toContain('Side view');
  });

  it('replaces color in hoodies/back prompt and includes "hood down"', () => {
    const result = buildPrompt('hoodies', 'back', 'charcoal');
    expect(result).toContain('charcoal');
    expect(result).toContain('Back view');
    expect(result).toContain('hood down');
  });
});

// ---------------------------------------------------------------------------
// buildRetryPrompt — stronger color emphasis
// ---------------------------------------------------------------------------

describe('buildRetryPrompt', () => {
  it('contains "MUST be navy blue" for tops/back', () => {
    const result = buildRetryPrompt('tops', 'back', 'navy blue');
    expect(result).toContain('MUST be navy blue');
  });

  it('contains "MUST be forest green" and "hoodie" for hoodies/back', () => {
    const result = buildRetryPrompt('hoodies', 'back', 'forest green');
    expect(result).toContain('MUST be forest green');
    expect(result).toContain('hoodie');
  });

  it('does not leave {color} placeholder in output', () => {
    const result = buildRetryPrompt('tops', 'back', 'navy blue');
    expect(result).not.toContain('{color}');
  });

  it('replaces ALL {color} occurrences (retry templates have 2)', () => {
    const color = 'coral';
    const result = buildRetryPrompt('tops', 'back', color);
    // Retry template has "this exact {color}" and "MUST be {color}" — both replaced
    const occurrences = (result.match(/coral/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(result).not.toContain('{color}');
  });

  it('contains "Hood is down" for hoodies/back retry', () => {
    const result = buildRetryPrompt('hoodies', 'back', 'navy');
    expect(result).toContain('Hood is down');
  });

  it('contains color for tops/side retry', () => {
    const result = buildRetryPrompt('tops', 'side', 'charcoal');
    expect(result).toContain('MUST be charcoal');
  });
});

// ---------------------------------------------------------------------------
// Template coverage — all CategoryGroup × AIView combinations produce non-empty strings
// ---------------------------------------------------------------------------

describe('PROMPT_TEMPLATES coverage', () => {
  const garmentTypes: CategoryGroup[] = ['tops', 'hoodies'];
  const views: AIView[] = ['back', 'side'];

  for (const garmentType of garmentTypes) {
    for (const view of views) {
      it(`has a non-empty template for ${garmentType}/${view}`, () => {
        const template = PROMPT_TEMPLATES[garmentType][view];
        expect(typeof template).toBe('string');
        expect(template.length).toBeGreaterThan(0);
      });
    }
  }
});

describe('RETRY_PROMPT_TEMPLATES coverage', () => {
  const garmentTypes: CategoryGroup[] = ['tops', 'hoodies'];
  const views: AIView[] = ['back', 'side'];

  for (const garmentType of garmentTypes) {
    for (const view of views) {
      it(`has a non-empty retry template for ${garmentType}/${view}`, () => {
        const template = RETRY_PROMPT_TEMPLATES[garmentType][view];
        expect(typeof template).toBe('string');
        expect(template.length).toBeGreaterThan(0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// CLEANUP_PROMPT
// ---------------------------------------------------------------------------

describe('CLEANUP_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof CLEANUP_PROMPT).toBe('string');
    expect(CLEANUP_PROMPT.length).toBeGreaterThan(0);
  });

  it('contains "white background"', () => {
    expect(CLEANUP_PROMPT).toContain('white background');
  });
});
