import type { SheetRow } from '../sheets/types.js';
import type { FileSetInput, CategoryGroup } from './types.js';

/**
 * Returns the category group for print area coordinates.
 * Maps real sheet baseCategory values to coordinate groups.
 * Returns null for unsupported categories (caps, pants, bags, etc.).
 */
export function getCategoryGroup(category: string): CategoryGroup | null {
  const lower = category.toLowerCase();

  // Hoodies: fleece with hood
  if (lower.includes('hood')) return 'hoodies';

  // Tops: t-shirts, long sleeves, crewneck fleece
  if (lower.includes('t-shirt')) return 'tops';
  if (lower.includes('long sleeve')) return 'tops';
  if (lower.includes('crew')) return 'tops';

  return null;
}

/**
 * Maps baseCategory values to Shopify product taxonomy GIDs.
 * These categorize products so shopify.color-pattern metafields work.
 */
export function getTaxonomyCategoryId(baseCategory: string): string {
  const lower = baseCategory.toLowerCase();

  if (lower.includes('hood')) return 'gid://shopify/TaxonomyCategory/aa-1-13-13'; // Hoodies
  if (lower.includes('crew')) return 'gid://shopify/TaxonomyCategory/aa-1-13-14'; // Sweatshirts
  // T-shirts (includes long sleeve, premium, core)
  return 'gid://shopify/TaxonomyCategory/aa-1-13-8'; // T-Shirts
}

/** Set of baseCategory values we support (for display/filtering). */
export const SUPPORTED_CATEGORIES = new Set([
  'T-Shirts - Premium',
  'T-Shirts - Core',
  'T-Shirts - Long Sleeve',
  'T-shirts/Shorts/Polos',
  'Fleece - Premium - Hood',
  'Fleece - Core - Hood',
  'Fleece - Premium - Crew',
  'Fleece - Core - Crew',
]);

/**
 * Generates a deterministic, URL-safe Shopify product handle.
 * Combines productName and styleID to ensure uniqueness per style.
 */
export function buildHandle(productName: string, styleID: string): string {
  return `${productName} ${styleID}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Collects unique image URLs across ALL rows in a product group.
 * Deduplicates by URL since multiple size variants of the same color share images.
 * Front images get alt text "Front Print", back images get "Back Print" (matches print area keys).
 */
export function buildFiles(rows: SheetRow[]): FileSetInput[] {
  const seen = new Set<string>();
  const files: FileSetInput[] = [];

  const imageFields = [
    { key: 'FrontImage' as const, altFn: () => 'Front Print' },
    { key: 'BackImage' as const, altFn: () => 'Back Print' },
    { key: 'DirectSideImage' as const, altFn: (row: SheetRow) => `${row.productName} - ${row.colorName} Side` },
  ];

  for (const row of rows) {
    for (const { key, altFn } of imageFields) {
      const url = row[key];
      if (url && !seen.has(url)) {
        seen.add(url);
        files.push({
          originalSource: url,
          alt: altFn(row),
          contentType: 'IMAGE',
        });
      }
    }
  }

  return files;
}
