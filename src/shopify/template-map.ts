import type { GarmentCategory } from '../decoration/types.js';

/**
 * Maps garment categories to Dawn theme template suffixes.
 * Template suffixes determine which product template Shopify uses.
 */
const TEMPLATE_SUFFIX_MAP: Record<GarmentCategory, string> = {
  'T-Shirt': 't-shirt',
  'Hoodie': 'hoodie',
  'Cap': 'cap',
  'Beanie': 'beanie',
  'Pants': 'pants',
  'Long Sleeve': 'long-sleeve',
  'Jacket': 'jacket',
};

/**
 * Returns the template suffix for a garment category.
 * Returns undefined if the category is not recognized.
 */
export function getTemplateSuffix(baseCategory: string): string | undefined {
  return TEMPLATE_SUFFIX_MAP[baseCategory as GarmentCategory];
}
