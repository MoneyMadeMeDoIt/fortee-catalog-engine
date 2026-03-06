import type { GarmentCategory } from './types.js';

/**
 * Maps known supplier baseCategory strings (normalized to lowercase) to
 * canonical GarmentCategory values used by the decoration rules engine.
 */
export const CATEGORY_ALIASES: Record<string, GarmentCategory> = {
  // T-Shirt variants
  't-shirt': 'T-Shirt',
  't-shirts': 'T-Shirt',
  'tees': 'T-Shirt',
  'tee': 'T-Shirt',
  'tank tops': 'T-Shirt',
  'tank top': 'T-Shirt',

  // Hoodie variants
  'hoodie': 'Hoodie',
  'hoodies': 'Hoodie',
  'fleece': 'Hoodie',
  'sweatshirts': 'Hoodie',
  'sweatshirt': 'Hoodie',

  // Long Sleeve variants
  'long sleeve': 'Long Sleeve',
  'long sleeves': 'Long Sleeve',
  'henleys': 'Long Sleeve',
  'henley': 'Long Sleeve',

  // Cap variants
  'cap': 'Cap',
  'caps': 'Cap',
  'caps & hats': 'Cap',
  'hats': 'Cap',
  'headwear': 'Cap',

  // Beanie variants
  'beanie': 'Beanie',
  'beanies': 'Beanie',

  // Pants variants
  'pants': 'Pants',
  'joggers': 'Pants',
  'shorts': 'Pants',

  // Jacket variants
  'jacket': 'Jacket',
  'jackets': 'Jacket',
};

/**
 * Resolves a supplier baseCategory string to a canonical GarmentCategory.
 * Normalizes input (lowercase, trim) before lookup.
 * Returns null if no matching category is found.
 */
export function resolveCategory(baseCategory: string): GarmentCategory | null {
  const normalized = baseCategory.toLowerCase().trim();
  return CATEGORY_ALIASES[normalized] ?? null;
}
