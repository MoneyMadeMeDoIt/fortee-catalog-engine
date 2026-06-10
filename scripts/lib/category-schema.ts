/**
 * Pure, network-free core of the Phase 19 categorizer.
 *
 * Planning verification (D-05/D-06/D-07):
 *
 * SAFE (non-null getCategoryGroup) — controlled-vocab values:
 *   'T-Shirts'          → lower includes 't-shirt' → 'tops'
 *   'Long Sleeve Shirts'→ lower includes 'long sleeve' → 'tops'
 *   'Polo Shirts'       → lower includes 'polo' → 'polos'
 *   'Tank Tops'         → lower includes 'tank' → 'tops'
 *   'Hoodies'           → lower includes 'hood' → 'hoodies'
 *   'Jackets'           → lower includes 'jacket' → 'jackets'
 *   'Vests'             → lower includes 'vest' → 'jackets'
 *   'Youth T-Shirts'    → lower includes 't-shirt' → 'tops'
 *   'Youth Hoodies'     → lower includes 'hood' → 'hoodies'
 *   'Crewneck Sweatshirt' → lower includes 'crew' → 'crewnecks'  (safe replacement for 'Sweatshirts')
 *
 * SAFE — SUPPORTED_CATEGORIES strings (src/shopify/variants.ts):
 *   'T-Shirts - Premium'     → 't-shirt' → 'tops'
 *   'T-Shirts - Core'        → 't-shirt' → 'tops'
 *   'T-Shirts - Long Sleeve' → 't-shirt' → 'tops'
 *   'T-shirts/Shorts/Polos'  → 't-shirt' → 'tops'  (note lowercase t in source)
 *   'Fleece - Premium - Hood'→ 'hood'    → 'hoodies'
 *   'Fleece - Core - Hood'   → 'hood'    → 'hoodies'
 *   'Fleece - Premium - Crew'→ 'crew'+'fleece' both present → 'crewnecks'
 *   'Fleece - Core - Crew'   → 'crew'+'fleece' both present → 'crewnecks'
 *
 * EXCLUDED (getCategoryGroup returns null — MUST NOT be enum members):
 *   'Sweatshirts' — matches 'crew'? NO (no 'crew' in 'sweatshirts'), no other match → null
 *   'Caps'        → null
 *   'Beanies'     → null
 *   'Bags'        → null
 *   'Shorts'      → null
 *   'Sweatpants'  → null
 */

import { z } from 'zod';

// ─── SAFE_BASE_CATEGORIES ─────────────────────────────────────────────────────
//
// Closed enum of decoration-safe baseCategory values. Every member is proven
// non-null via getCategoryGroup() (asserted in category-schema.test.ts).
// This is the contract that protects product-push.ts:104 from throwing.

export const SAFE_BASE_CATEGORIES = [
  // Controlled-vocab values (9 safe + 1 replacement)
  'T-Shirts',
  'Long Sleeve Shirts',
  'Polo Shirts',
  'Tank Tops',
  'Hoodies',
  'Jackets',
  'Vests',
  'Youth T-Shirts',
  'Youth Hoodies',
  'Crewneck Sweatshirt',
  // SUPPORTED_CATEGORIES strings from src/shopify/variants.ts
  'T-Shirts - Premium',
  'T-Shirts - Core',
  'T-Shirts - Long Sleeve',
  'T-shirts/Shorts/Polos',
  'Fleece - Premium - Hood',
  'Fleece - Core - Hood',
  'Fleece - Premium - Crew',
  'Fleece - Core - Crew',
] as const;

export type SafeBaseCategory = (typeof SAFE_BASE_CATEGORIES)[number];

// ─── TAXONOMY_LEAF_PATHS ──────────────────────────────────────────────────────
//
// Closed set of Shopify Standard Taxonomy LEAF paths for the Fortee catalog.
// Source: .planning/research/FEATURES.md "Key paths for the Fortee catalog" table.
// Per D-08: always a leaf, never a free-form string.

export const TAXONOMY_LEAF_PATHS = [
  'Apparel & Accessories > Clothing > Clothing Tops > T-Shirts',
  'Apparel & Accessories > Clothing > Clothing Tops > Sweatshirts',
  'Apparel & Accessories > Clothing > Clothing Tops > Hoodies & Sweatshirts',
  'Apparel & Accessories > Clothing > Clothing Tops > Polo Shirts',
  'Apparel & Accessories > Clothing > Clothing Tops > Shirts',
  'Apparel & Accessories > Clothing > Clothing Tops > Tank Tops',
  'Apparel & Accessories > Clothing > Clothing Bottoms > Shorts',
  'Apparel & Accessories > Clothing > Clothing Bottoms > Sweatpants & Joggers',
  'Apparel & Accessories > Clothing > Outerwear > Jackets & Coats',
  'Apparel & Accessories > Clothing > Outerwear > Vests',
  'Apparel & Accessories > Clothing Accessories > Hats > Baseball Caps',
  'Apparel & Accessories > Clothing Accessories > Hats > Beanies',
  'Apparel & Accessories > Handbags, Wallets & Cases > Bags',
] as const;

export type TaxonomyLeafPath = (typeof TAXONOMY_LEAF_PATHS)[number];

// ─── Keyword blocklists (exported for reuse in 19-02) ─────────────────────────

/** Color names that must not appear as keywords (D-10). */
export const BLOCKED_COLORS = [
  'red', 'black', 'navy', 'white', 'grey', 'gray', 'green', 'blue', 'royal',
  'maroon', 'yellow', 'orange', 'purple', 'pink', 'brown', 'gold', 'silver',
  'charcoal', 'heather', 'natural', 'sand', 'stone', 'olive', 'burgundy',
  'teal', 'coral', 'cream', 'ivory', 'khaki', 'tan', 'rust',
] as const;

/** Size tokens that must not appear as keywords (D-10). */
export const BLOCKED_SIZES = [
  'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl', '4xl', '5xl',
  'small', 'medium', 'large', 'xsmall', 'xtra-large', 'extra-large',
  'size', 'onesize', 'one-size',
] as const;

/** Wholesale / B2B jargon that must not appear as keywords (D-10). */
export const BLOCKED_JARGON = [
  'bulk', 'wholesale', 'gsm', 'partid', 'blank', 'case', 'moq', 'style',
  'sku', 'upc', 'minimum', 'order', 'qty', 'quantity', 'dozen', 'gross',
  'blank-apparel', 'activewear-blank',
] as const;

// ─── isCleanKeyword ───────────────────────────────────────────────────────────

/**
 * Returns true if the keyword is safe for consumer use:
 *  - All lowercase
 *  - No spaces (must be hyphenated)
 *  - No digits (blocks GSM values, style numbers, sizes like "2xl")
 *  - No color names (standalone or as hyphen-parts)
 *  - No size tokens (standalone or as hyphen-parts)
 *  - No wholesale jargon
 */
export function isCleanKeyword(kw: string): boolean {
  // Must be lowercase (no uppercase characters)
  if (/[A-Z]/.test(kw)) return false;

  // No spaces (must use hyphens for multi-word)
  if (/\s/.test(kw)) return false;

  // No digits (blocks GSM values, style numbers like g18500, size tokens like 2xl)
  if (/\d/.test(kw)) return false;

  // Split by hyphen to check each part against blocklists
  const parts = kw.split('-');

  for (const part of parts) {
    if ((BLOCKED_COLORS as readonly string[]).includes(part)) return false;
    if ((BLOCKED_SIZES as readonly string[]).includes(part)) return false;
    if ((BLOCKED_JARGON as readonly string[]).includes(part)) return false;
  }

  // Also check the full keyword (unsplit) against blocklists for compound tokens
  if ((BLOCKED_COLORS as readonly string[]).includes(kw)) return false;
  if ((BLOCKED_SIZES as readonly string[]).includes(kw)) return false;
  if ((BLOCKED_JARGON as readonly string[]).includes(kw)) return false;

  return true;
}

// ─── categorySchema ───────────────────────────────────────────────────────────
//
// Zod object schema for the AI's structured output. Per D-02, this is passed
// to zodOutputFormat() in the 19-02 I/O script. Keep it a plain zod object
// with no SDK coupling here.

export const categorySchema = z.object({
  /** Decoration-safe garment category. Must resolve non-null via getCategoryGroup(). */
  baseCategory: z.enum(SAFE_BASE_CATEGORIES),

  /** Shopify Standard Taxonomy leaf path (D-08: always a leaf, never free-form). */
  categoriesPath: z.enum(TAXONOMY_LEAF_PATHS),

  /**
   * Consumer-style search keywords (D-09/D-10):
   * - 8–15 per product
   * - lowercase-hyphenated
   * - no color/size/style#/GSM/jargon
   * - must preserve audience signal (youth/kids/women/men) for isYouth() in title-builder
   */
  keywords: z
    .array(z.string())
    .min(8, 'At least 8 keywords required')
    .max(15, 'At most 15 keywords allowed')
    .refine(
      (kws) => kws.every(isCleanKeyword),
      {
        message:
          'All keywords must be lowercase-hyphenated, digit-free, and exclude color/size/style/GSM/jargon',
      },
    ),
});

export type CategoryOutput = z.infer<typeof categorySchema>;

// ─── sanitizeForPrompt ────────────────────────────────────────────────────────

/**
 * Strips prompt-injection characters from a supplier-scraped string (T-19-01):
 *  - Backticks (template literal / shell injection)
 *  - Dollar signs (template literal variable expansion)
 *  - Curly braces (template/mustache injection)
 * Truncates to 500 characters. Returns '' for null/undefined.
 */
export function sanitizeForPrompt(s: string | null | undefined): string {
  if (s == null) return '';
  // Strip injection characters: backtick, $, {, }
  const cleaned = s.replace(/[`${}]/g, '');
  return cleaned.slice(0, 500);
}

// ─── buildPrompt ──────────────────────────────────────────────────────────────

export interface BuildPromptInput {
  productName: string;
  description: string;
  brandName: string;
  gender: string;
  fit: string;
  weightGSM: string;
  currentBaseCategory: string;
}

/**
 * Builds the structured prompt for Claude Haiku to generate baseCategory,
 * categoriesPath, and keywords for a product.
 *
 * Security (T-19-01): all supplier-scraped fields are sanitized before
 * interpolation so injection attempts cannot escape XML delimiters.
 *
 * Audience preservation (D-09): instructs the model to include the audience
 * term (youth/kids/women/men) so isYouth() in title-builder continues to work.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const {
    productName,
    description,
    brandName,
    gender,
    fit,
    weightGSM,
    currentBaseCategory,
  } = input;

  const safeProductName = sanitizeForPrompt(productName);
  const safeDescription = sanitizeForPrompt(description);
  const safeBrandName = sanitizeForPrompt(brandName);
  const safeGender = sanitizeForPrompt(gender);
  const safeFit = sanitizeForPrompt(fit);
  const safeWeightGSM = sanitizeForPrompt(weightGSM);
  const safeCurrentBaseCategory = sanitizeForPrompt(currentBaseCategory);

  const allowedBaseCategories = SAFE_BASE_CATEGORIES.join(', ');
  const allowedTaxonomyPaths = TAXONOMY_LEAF_PATHS.join('\n  ');

  return `You are a product categorization assistant for a Canadian apparel company.

Analyze the product information below and return EXACTLY the following JSON fields:
1. baseCategory — must be one of the allowed values
2. categoriesPath — must be one of the allowed taxonomy paths
3. keywords — 8 to 15 consumer-facing search tags

<product_name>${safeProductName}</product_name>
<product_description>${safeDescription}</product_description>
<brand_name>${safeBrandName}</brand_name>
<gender>${safeGender}</gender>
<fit>${safeFit}</fit>
<weight_gsm>${safeWeightGSM}</weight_gsm>
<current_base_category>${safeCurrentBaseCategory}</current_base_category>

## Allowed baseCategory values (pick exactly one):
${allowedBaseCategories}

If the product does not clearly fit any of the above values, return the currentBaseCategory unchanged.
Do NOT invent values outside this list — an out-of-enum value will break product push.

## Allowed categoriesPath values (pick exactly one Apparel & Accessories leaf):
  ${allowedTaxonomyPaths}

## Keyword rules (ALL must be satisfied):
- Format: lowercase only, hyphens for multi-word tokens (e.g. fleece-hoodie, not "Fleece Hoodie")
- Count: minimum 8, maximum 15
- Include audience signal: if the product is for youth, kids, or toddlers include "youth" or "kids"; for women include "womens"; for men include "mens"; for unisex include "unisex"
- Include garment type, material/fabric, fit style, weight tier (lightweight / midweight / heavyweight), and use-case terms
- EXCLUDE: color names (black, navy, red, white, grey, etc.), size names (xs, s, m, l, xl, xxl, etc.), style/part numbers, GSM numeric values, wholesale/B2B jargon (bulk, wholesale, gsm, moq, blank, partid)
- Consumer terms only — these are tags shown on a Shopify storefront

## Audience-preservation rule (CRITICAL for title generation):
If gender is "Youth", "Kids", "Toddler", or similar, you MUST include the word "youth" or "kids" in the keywords array.
If gender is "Women" or "Womens", include "womens". If "Men" or "Mens", include "mens".
This signal is read by downstream title generation and MUST NOT be omitted.

Return valid JSON matching the schema exactly.`;
}
