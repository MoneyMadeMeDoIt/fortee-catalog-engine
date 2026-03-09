/**
 * Supported garment categories for the old store format.
 * All use the same product.quick-order template.
 */
const SUPPORTED_CATEGORIES = new Set([
  'T-Shirt',
  'Long Sleeve',
  'Crewneck',
  'Hoodie',
]);

/**
 * Returns the template suffix for a garment category.
 * All supported categories use 'quick-order' in the old store.
 * Returns undefined for unsupported categories.
 */
export function getTemplateSuffix(category: string): string | undefined {
  return SUPPORTED_CATEGORIES.has(category) ? 'quick-order' : undefined;
}
