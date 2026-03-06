/**
 * Column mapping utilities for the master product sheet.
 * Converts between column indices and sheet letter addresses,
 * and maps supplier SupplierProduct fields to sheet column names.
 */

/**
 * Convert a 0-based column index to a sheet column letter.
 * 0 = A, 25 = Z, 26 = AA, 51 = AZ, 52 = BA, etc.
 */
export function columnToLetter(colIndex: number): string {
  let letter = '';
  let idx = colIndex;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

/**
 * Maps sheet column names to SupplierProduct field paths.
 * Used during enrichment to know which supplier field fills which sheet column.
 */
export const FIELD_MAPPING: Record<string, string> = {
  FrontImage: 'images[0].url',
  BackImage: 'images[1].url',
  DirectSideImage: 'images[2].url',
  description: 'description',
  sizeChart: 'sizeChartData',
  productName: 'title',
  baseCategory: 'category',
} as const;

/**
 * Maps sheet supplierCode values to Phase 1 adapter names.
 * The sheet uses PromoStandards supplier codes; the adapters use kebab-case names.
 */
export const SUPPLIER_CODE_MAP = {
  CANADASPORTSWEAR: 'canada-sportswear',
  SSCANADA: 'ss-canada',
} as const;
