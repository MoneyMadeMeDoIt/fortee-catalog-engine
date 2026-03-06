/**
 * Merge logic: compares supplier data against existing sheet rows,
 * producing EnrichmentUpdate objects only for empty cells.
 * Never overwrites existing data.
 */
import type { SizeSpec, SupplierProduct } from '../suppliers/types.js';
import type { SheetRow, EnrichmentUpdate } from './types.js';
import { columnToLetter, FIELD_MAPPING, HEADER_ALIASES } from './column-map.js';
import { SHEET_COLUMNS } from './types.js';

/**
 * Convert SizeSpec[] to structured text.
 * Groups by sizeName, joins measurements with comma, joins sizes with " | ".
 * Example: "S: Chest 36, Length 28 | M: Chest 38, Length 29"
 */
export function formatSizeChart(specs: SizeSpec[]): string {
  if (specs.length === 0) return '';

  const grouped = new Map<string, string[]>();
  for (const spec of specs) {
    const existing = grouped.get(spec.sizeName) ?? [];
    existing.push(`${spec.specName} ${spec.value}`);
    grouped.set(spec.sizeName, existing);
  }

  const parts: string[] = [];
  for (const [sizeName, measurements] of grouped) {
    parts.push(`${sizeName}: ${measurements.join(', ')}`);
  }

  return parts.join(' | ');
}

/**
 * Map a SupplierProduct to a flat Record keyed by sheet column names.
 * Uses FIELD_MAPPING to determine which supplier fields map to which columns.
 */
export function mapSupplierToSheetFields(
  product: SupplierProduct,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [sheetCol, supplierPath] of Object.entries(FIELD_MAPPING)) {
    if (sheetCol === 'FrontImage') {
      if (product.images[0]?.url) result.FrontImage = product.images[0].url;
    } else if (sheetCol === 'BackImage') {
      if (product.images[1]?.url) result.BackImage = product.images[1].url;
    } else if (sheetCol === 'DirectSideImage') {
      if (product.images[2]?.url) result.DirectSideImage = product.images[2].url;
    } else if (sheetCol === 'sizeChart') {
      if (product.sizeChartData && product.sizeChartData.length > 0) {
        result.sizeChart = formatSizeChart(product.sizeChartData);
      }
    } else {
      // Direct string field mapping
      const value = (product as Record<string, unknown>)[supplierPath];
      if (typeof value === 'string' && value.length > 0) {
        result[sheetCol] = value;
      }
    }
  }

  return result;
}

/**
 * Build EnrichmentUpdate objects for a single row.
 * Only creates updates for cells that are currently empty in the sheet
 * and have matching supplier data available.
 *
 * @param row - Current sheet row data
 * @param supplierData - Flat supplier data keyed by sheet column name
 * @param headers - Sheet header names in order (for column index lookup)
 * @param rowIndex - 0-based data row index (row 0 = sheet row 2, since row 1 = headers)
 * @param sheetName - Sheet tab name for range references
 */
export function buildUpdates(
  row: SheetRow,
  supplierData: Record<string, string>,
  headers: string[],
  rowIndex: number,
  sheetName: string,
): EnrichmentUpdate[] {
  const updates: EnrichmentUpdate[] = [];
  const sheetRowNumber = rowIndex + 2; // row 0 = sheet row 2 (row 1 = headers)

  for (const [field, value] of Object.entries(supplierData)) {
    const currentValue = (row as Record<string, string>)[field] ?? '';

    // Skip if cell already has data (never overwrite)
    if (currentValue.trim() !== '') continue;

    // Find column index: try actual headers first (exact match or alias), then SHEET_COLUMNS position
    const alias = HEADER_ALIASES[field];
    let colIndex = headers.indexOf(field);
    if (colIndex === -1 && alias) colIndex = headers.indexOf(alias);
    if (colIndex === -1) colIndex = SHEET_COLUMNS.indexOf(field as typeof SHEET_COLUMNS[number]);
    if (colIndex === -1) continue;

    const colLetter = columnToLetter(colIndex);
    updates.push({
      range: `${sheetName}!${colLetter}${sheetRowNumber}`,
      values: [[value]],
    });
  }

  return updates;
}
