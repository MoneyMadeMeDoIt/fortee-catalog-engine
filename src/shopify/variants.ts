import type { SheetRow } from '../sheets/types.js';
import type { ProductVariantSetInput, FileSetInput } from './types.js';

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
 * Each row becomes one Color x Size variant.
 */
export function buildVariants(rows: SheetRow[]): ProductVariantSetInput[] {
  return rows.map((row) => ({
    optionValues: [
      { optionName: 'Color', name: row.colorName },
      { optionName: 'Size', name: row.sizeName },
    ],
    price: parseFloat(row.sellPrice1Area) || 0,
    sku: row.partNumber,
    barcode: row.PartID,
  }));
}

/**
 * Collects unique image URLs across ALL rows in a product group.
 * Deduplicates by URL since multiple size variants of the same color share images.
 */
export function buildFiles(rows: SheetRow[]): FileSetInput[] {
  const seen = new Set<string>();
  const files: FileSetInput[] = [];

  const imageFields = [
    { key: 'FrontImage' as const, label: 'Front' },
    { key: 'BackImage' as const, label: 'Back' },
    { key: 'DirectSideImage' as const, label: 'Side' },
  ];

  for (const row of rows) {
    for (const { key, label } of imageFields) {
      const url = row[key];
      if (url && !seen.has(url)) {
        seen.add(url);
        files.push({
          originalSource: url,
          alt: `${row.productName} - ${row.colorName} ${label}`,
          contentType: 'IMAGE',
        });
      }
    }
  }

  return files;
}
