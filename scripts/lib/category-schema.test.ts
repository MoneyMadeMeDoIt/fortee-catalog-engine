/**
 * Unit tests for scripts/lib/category-schema.ts
 *
 * Pure vitest — no network, no Anthropic API key needed.
 * These tests are the contract that protects product-push from a null
 * getCategoryGroup() result (D-05/D-06/D-07).
 */

import { describe, it, expect } from 'vitest';
import { getCategoryGroup } from '../../src/shopify/variants.js';
import {
  SAFE_BASE_CATEGORIES,
  TAXONOMY_LEAF_PATHS,
  categorySchema,
  isCleanKeyword,
  sanitizeForPrompt,
  buildPrompt,
} from './category-schema.js';

// ─── Task 1: Decoration-safe baseCategory enum ────────────────────────────

describe('SAFE_BASE_CATEGORIES — decoration contract (D-05/D-06)', () => {
  it('every member resolves non-null via getCategoryGroup()', () => {
    for (const member of SAFE_BASE_CATEGORIES) {
      expect(
        getCategoryGroup(member),
        `Expected getCategoryGroup("${member}") to be non-null — this value is unsafe for product-push`,
      ).not.toBeNull();
    }
  });

  it('reports the count so a silent skip is impossible', () => {
    // Forces vitest to print the actual count on failure
    expect(SAFE_BASE_CATEGORIES.length).toBeGreaterThanOrEqual(10);
  });

  // Regression guard: documents WHY unsafe values are excluded
  it('getCategoryGroup("Sweatshirts") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Sweatshirts')).toBeNull();
  });

  it('getCategoryGroup("Caps") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Caps')).toBeNull();
  });

  it('getCategoryGroup("Beanies") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Beanies')).toBeNull();
  });

  it('getCategoryGroup("Bags") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Bags')).toBeNull();
  });

  it('getCategoryGroup("Shorts") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Shorts')).toBeNull();
  });

  it('getCategoryGroup("Sweatpants") returns null — excluded from enum', () => {
    expect(getCategoryGroup('Sweatpants')).toBeNull();
  });

  it('SAFE_BASE_CATEGORIES does not contain bare "Sweatshirts"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Sweatshirts');
  });

  it('SAFE_BASE_CATEGORIES does not contain "Caps"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Caps');
  });

  it('SAFE_BASE_CATEGORIES does not contain "Beanies"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Beanies');
  });

  it('SAFE_BASE_CATEGORIES does not contain "Bags"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Bags');
  });

  it('SAFE_BASE_CATEGORIES does not contain "Shorts"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Shorts');
  });

  it('SAFE_BASE_CATEGORIES does not contain "Sweatpants"', () => {
    expect(SAFE_BASE_CATEGORIES).not.toContain('Sweatpants');
  });

  it('contains "Crewneck Sweatshirt" (the safe replacement for bare "Sweatshirts")', () => {
    expect(SAFE_BASE_CATEGORIES).toContain('Crewneck Sweatshirt');
  });

  it('categorySchema rejects "Caps" as baseCategory (enum rejects null-resolving values)', () => {
    const result = categorySchema.safeParse({
      baseCategory: 'Caps',
      categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > T-Shirts',
      keywords: ['mens', 't-shirt', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday', 'classic-fit'],
    });
    expect(result.success).toBe(false);
  });

  it('categorySchema rejects "Sweatshirts" as baseCategory', () => {
    const result = categorySchema.safeParse({
      baseCategory: 'Sweatshirts',
      categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > Sweatshirts',
      keywords: ['mens', 'fleece', 'cotton', 'casual', 'unisex', 'midweight', 'everyday', 'crewneck'],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Task 2: Zod combined schema ─────────────────────────────────────────

describe('categorySchema — combined zod validation', () => {
  const goodPayload = {
    baseCategory: 'T-Shirts',
    categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > T-Shirts',
    keywords: ['mens', 't-shirt', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday', 'classic-fit'],
  };

  it('accepts a valid payload', () => {
    const result = categorySchema.safeParse(goodPayload);
    expect(result.success).toBe(true);
  });

  it('rejects categoriesPath not in the leaf-path enum', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      categoriesPath: 'Apparel & Accessories > Clothing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects keywords array of length 7 (below min 8)', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      keywords: ['mens', 't-shirt', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects keywords array of length 16 (above max 15)', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      keywords: [
        'mens', 't-shirt', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday',
        'classic-fit', 'screen-print-ready', 'corporate-gift', 'team-uniform',
        'gym-wear', 'outdoor', 'fleece-hoodie', 'heavyweight', 'comfortable',
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects keywords containing a color name ("color-black")', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      keywords: ['mens', 'color-black', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday', 'classic-fit'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects keywords containing "gsm-250" (GSM value jargon)', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      keywords: ['mens', 'gsm-250', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday', 'classic-fit'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects keywords containing "Mens" (uppercase — must be lowercase)', () => {
    const result = categorySchema.safeParse({
      ...goodPayload,
      keywords: ['Mens', 't-shirt', 'cotton', 'casual', 'unisex', 'lightweight', 'everyday', 'classic-fit'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid payload with SUPPORTED_CATEGORIES member as baseCategory', () => {
    const result = categorySchema.safeParse({
      baseCategory: 'Fleece - Premium - Hood',
      categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > Hoodies & Sweatshirts',
      keywords: ['mens', 'fleece-hoodie', 'heavyweight', 'casual', 'unisex', 'outdoor', 'corporate-gift', 'screen-print-ready'],
    });
    expect(result.success).toBe(true);
  });
});

// ─── isCleanKeyword ──────────────────────────────────────────────────────

describe('isCleanKeyword', () => {
  // Good tokens
  it('accepts "mens"', () => expect(isCleanKeyword('mens')).toBe(true));
  it('accepts "fleece-hoodie"', () => expect(isCleanKeyword('fleece-hoodie')).toBe(true));
  it('accepts "heavyweight"', () => expect(isCleanKeyword('heavyweight')).toBe(true));
  it('accepts "corporate-gift"', () => expect(isCleanKeyword('corporate-gift')).toBe(true));
  it('accepts "screen-print-ready"', () => expect(isCleanKeyword('screen-print-ready')).toBe(true));
  it('accepts "youth"', () => expect(isCleanKeyword('youth')).toBe(true));
  it('accepts "team-uniform"', () => expect(isCleanKeyword('team-uniform')).toBe(true));
  it('accepts "casual-everyday"', () => expect(isCleanKeyword('casual-everyday')).toBe(true));

  // Uppercase rejection
  it('rejects "Mens" (uppercase character)', () => expect(isCleanKeyword('Mens')).toBe(false));
  it('rejects "T-Shirt" (uppercase character)', () => expect(isCleanKeyword('T-Shirt')).toBe(false));

  // Space rejection
  it('rejects "fleece hoodie" (contains space — must be hyphenated)', () => expect(isCleanKeyword('fleece hoodie')).toBe(false));

  // Digit rejection
  it('rejects "gsm-250" (contains digit)', () => expect(isCleanKeyword('gsm-250')).toBe(false));
  it('rejects "g18500" (style number with digit)', () => expect(isCleanKeyword('g18500')).toBe(false));
  it('rejects "size-xl" — digit-free test: "size-xl" contains no digit but...',
    // size-xl has no digit, so it should fail via the jargon/size blocklist
    () => expect(isCleanKeyword('size-xl')).toBe(false));

  // Color name rejection
  it('rejects "red"', () => expect(isCleanKeyword('red')).toBe(false));
  it('rejects "black"', () => expect(isCleanKeyword('black')).toBe(false));
  it('rejects "navy"', () => expect(isCleanKeyword('navy')).toBe(false));
  it('rejects "white"', () => expect(isCleanKeyword('white')).toBe(false));
  it('rejects "grey"', () => expect(isCleanKeyword('grey')).toBe(false));
  it('rejects "gray"', () => expect(isCleanKeyword('gray')).toBe(false));
  it('rejects "green"', () => expect(isCleanKeyword('green')).toBe(false));
  it('rejects "blue"', () => expect(isCleanKeyword('blue')).toBe(false));
  it('rejects "royal"', () => expect(isCleanKeyword('royal')).toBe(false));
  it('rejects "maroon"', () => expect(isCleanKeyword('maroon')).toBe(false));

  // Size name rejection
  it('rejects "xs"', () => expect(isCleanKeyword('xs')).toBe(false));
  it('rejects "xl"', () => expect(isCleanKeyword('xl')).toBe(false));
  it('rejects "xxl"', () => expect(isCleanKeyword('xxl')).toBe(false));
  it('rejects "2xl"', () => expect(isCleanKeyword('2xl')).toBe(false)); // also has digit
  it('rejects "small"', () => expect(isCleanKeyword('small')).toBe(false));
  it('rejects "medium"', () => expect(isCleanKeyword('medium')).toBe(false));
  it('rejects "large"', () => expect(isCleanKeyword('large')).toBe(false));

  // Wholesale jargon rejection
  it('rejects "bulk"', () => expect(isCleanKeyword('bulk')).toBe(false));
  it('rejects "wholesale"', () => expect(isCleanKeyword('wholesale')).toBe(false));
  it('rejects "gsm"', () => expect(isCleanKeyword('gsm')).toBe(false));
  it('rejects "moq"', () => expect(isCleanKeyword('moq')).toBe(false));
  it('rejects "blank"', () => expect(isCleanKeyword('blank')).toBe(false));
});

// ─── sanitizeForPrompt ───────────────────────────────────────────────────

describe('sanitizeForPrompt', () => {
  it('strips backticks', () => {
    expect(sanitizeForPrompt('hello `world`')).not.toContain('`');
  });

  it('strips dollar signs', () => {
    expect(sanitizeForPrompt('price $10')).not.toContain('$');
  });

  it('strips curly braces', () => {
    expect(sanitizeForPrompt('{{brand}}')).not.toContain('{');
    expect(sanitizeForPrompt('{{brand}}')).not.toContain('}');
  });

  it('strips all injection chars from `${x}` pattern', () => {
    const result = sanitizeForPrompt('`${x}`');
    expect(result).not.toContain('`');
    expect(result).not.toContain('$');
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
  });

  it('strips {{brand}} pattern', () => {
    const result = sanitizeForPrompt('See {{brand}} for more');
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('See');
    expect(result).toContain('for more');
  });

  it('truncates to 500 chars', () => {
    const longStr = 'a'.repeat(600);
    expect(sanitizeForPrompt(longStr).length).toBeLessThanOrEqual(500);
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeForPrompt(null as unknown as string)).toBe('');
    expect(sanitizeForPrompt(undefined as unknown as string)).toBe('');
  });

  it('preserves normal description text', () => {
    const normal = 'Soft cotton t-shirt for everyday wear';
    expect(sanitizeForPrompt(normal)).toBe(normal);
  });
});

// ─── buildPrompt ────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const baseInput = {
    productName: "Men's Heavyweight T-Shirt",
    description: 'A 100% cotton pre-shrunk shirt for everyday wear.',
    brandName: 'Gildan',
    gender: 'Mens',
    fit: 'Classic',
    weightGSM: '270',
    currentBaseCategory: 'Tops',
  };

  it('contains the gender value in the prompt', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('Mens');
  });

  it('contains XML delimiters wrapping product description', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('<product_description>');
    expect(prompt).toContain('</product_description>');
  });

  it('names the SAFE_BASE_CATEGORIES allowed set', () => {
    const prompt = buildPrompt(baseInput);
    // The prompt must mention the allowed enum so the model knows valid values
    expect(prompt).toContain('T-Shirts');
  });

  it('names the TAXONOMY_LEAF_PATHS allowed set', () => {
    const prompt = buildPrompt(baseInput);
    // Must reference a known taxonomy path
    expect(prompt).toContain('Apparel & Accessories');
  });

  it('states keyword rules (lowercase-hyphen format)', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt.toLowerCase()).toContain('lowercase');
  });

  it('instructs audience-term preservation for youth products (D-09)', () => {
    const youthInput = { ...baseInput, gender: 'Youth', productName: "Youth Fleece Hoodie" };
    const prompt = buildPrompt(youthInput);
    expect(prompt.toLowerCase()).toContain('youth');
  });

  it('does NOT contain raw backticks from an injected description', () => {
    const injectedInput = {
      ...baseInput,
      description: 'Great product. `rm -rf /` Note: ${TEMPLATE} run this.',
    };
    const prompt = buildPrompt(injectedInput);
    expect(prompt).not.toContain('`');
    expect(prompt).not.toContain('${TEMPLATE}');
  });

  it('sanitizes injected curly braces from description', () => {
    const injectedInput = {
      ...baseInput,
      description: 'See {{brand}} for {details} and `code`.',
    };
    const prompt = buildPrompt(injectedInput);
    expect(prompt).not.toContain('{{brand}}');
    expect(prompt).not.toContain('{details}');
  });
});
