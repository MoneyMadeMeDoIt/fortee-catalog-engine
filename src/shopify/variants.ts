import type { SheetRow } from '../sheets/types.js';
import type { ProductVariantSetInput, FileSetInput, CategoryGroup } from './types.js';

/** Supported garment categories for the old store push pipeline. */
export const SUPPORTED_CATEGORIES = new Set(['T-Shirt', 'Long Sleeve', 'Crewneck', 'Hoodie']);

/** Print area position coordinates by category group (percentage-based, relative to image). */
export const PRINT_AREA_COORDINATES = {
  tops: {
    'Front Print': { x: '31.60', y: '15.87', width: '36.20', height: '50.80' },
    'Back Print': { x: '30.60', y: '16.07', width: '39.40', height: '48.40' },
  },
  hoodies: {
    'Front Print': { x: '33.60', y: '25.53', width: '31.20', height: '36.00' },
    'Back Print': { x: '32.48', y: '33.67', width: '33.80', height: '39.40' },
  },
} as const;

/**
 * Returns the category group for print area coordinates.
 * Returns 'tops' for T-Shirt, Long Sleeve, Crewneck.
 * Returns 'hoodies' for Hoodie.
 * Returns null for unsupported categories.
 */
export function getCategoryGroup(category: string): CategoryGroup | null {
  if (!SUPPORTED_CATEGORIES.has(category)) return null;
  if (category === 'Hoodie') return 'hoodies';
  return 'tops';
}

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
 * Builds Shopify variant inputs from sheet rows.
 * Each row produces TWO variants: one for 1 print area, one for 2 print areas.
 * Variant-level metafields include print_area_position with category-based coordinates.
 */
export function buildVariants(rows: SheetRow[], categoryGroup: CategoryGroup): ProductVariantSetInput[] {
  const variants: ProductVariantSetInput[] = [];
  const printAreaCoords = PRINT_AREA_COORDINATES[categoryGroup];
  const coordsJson = JSON.stringify(printAreaCoords);

  for (const row of rows) {
    const sku = `${row.productId}-${row.colorName}-${row.sizeName}`;
    const metafields = [{
      namespace: 'custom',
      key: 'print_area_position',
      type: 'json',
      value: coordsJson,
    }];

    // 1 print area variant
    variants.push({
      optionValues: [
        { optionName: 'Color', name: row.colorName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '1' },
      ],
      price: parseFloat(row.sellPrice1Area) || 0,
      sku,
      barcode: row.PartID,
      metafields,
    });

    // 2 print areas variant
    variants.push({
      optionValues: [
        { optionName: 'Color', name: row.colorName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '2' },
      ],
      price: parseFloat(row.sellPrice2Area) || 0,
      sku,
      barcode: row.PartID,
      metafields,
    });
  }

  return variants;
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
