/**
 * Reads the S&S Canada spec sheet (size chart data) from a separate Google Sheet.
 * Groups specs by styleName (productId) into SizeSpec arrays for enrichment.
 */
import type { sheets_v4 } from 'googleapis';
import type { SizeSpec } from '../suppliers/types.js';
import { logger } from '../lib/logger.js';
import { formatSizeChart } from './merge.js';

export interface SpecSheetRow {
  styleName: string;
  sizeName: string;
  specName: string;
  value: string;
}

/**
 * Read all spec rows from the spec sheet and group by styleName (productId).
 * Returns a Map from productId to formatted size chart string.
 */
export async function readSpecSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName = 'Sheet1',
): Promise<Map<string, string>> {
  logger.info('Reading spec sheet...');

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
  });

  const values = response.data.values;
  if (!values || values.length < 2) {
    logger.warn('Spec sheet has no data rows');
    return new Map();
  }

  const headers = values[0].map((h: string) => String(h).trim());
  const styleNameIdx = headers.indexOf('styleName');
  const sizeNameIdx = headers.indexOf('sizeName');
  const specNameIdx = headers.indexOf('specName');
  const valueIdx = headers.indexOf('value');

  if (styleNameIdx === -1 || sizeNameIdx === -1 || specNameIdx === -1 || valueIdx === -1) {
    throw new Error(
      `Spec sheet missing required columns. Found: ${headers.join(', ')}. ` +
      `Need: styleName, sizeName, specName, value`,
    );
  }

  // Group specs by styleName (productId)
  const specsByProduct = new Map<string, SizeSpec[]>();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const styleName = String(row[styleNameIdx] ?? '').trim();
    const sizeName = String(row[sizeNameIdx] ?? '').trim();
    const specName = String(row[specNameIdx] ?? '').trim();
    const value = String(row[valueIdx] ?? '').trim();

    if (!styleName || !sizeName || !specName || !value) continue;

    if (!specsByProduct.has(styleName)) {
      specsByProduct.set(styleName, []);
    }
    specsByProduct.get(styleName)!.push({ sizeName, specName, value });
  }

  // Format each product's specs into a size chart string
  const sizeChartByProduct = new Map<string, string>();
  for (const [productId, specs] of specsByProduct) {
    const formatted = formatSizeChart(specs);
    if (formatted) {
      sizeChartByProduct.set(productId, formatted);
    }
  }

  logger.info(
    `Spec sheet: ${values.length - 1} rows, ${specsByProduct.size} products with size data`,
  );

  return sizeChartByProduct;
}

const STANDARD_SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];

/**
 * Read all spec rows from the spec sheet and group by styleName (productId).
 * Returns a Map from productId to SizeSpec[] (raw, not formatted).
 * Specs within each product are sorted by sizeOrder column (if present),
 * falling back to standard size ordering.
 * Does NOT modify the existing readSpecSheet() function.
 */
export async function readSpecSheetStructured(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName = 'Sheet1',
): Promise<Map<string, SizeSpec[]>> {
  logger.info('Reading spec sheet (structured)...');

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
  });

  const values = response.data.values;
  if (!values || values.length < 2) {
    logger.warn('Spec sheet has no data rows');
    return new Map();
  }

  const headers = values[0].map((h: string) => String(h).trim());
  const styleNameIdx = headers.indexOf('styleName');
  const sizeNameIdx = headers.indexOf('sizeName');
  const specNameIdx = headers.indexOf('specName');
  const valueIdx = headers.indexOf('value');
  const sizeOrderIdx = headers.indexOf('sizeOrder');

  if (styleNameIdx === -1 || sizeNameIdx === -1 || specNameIdx === -1 || valueIdx === -1) {
    throw new Error(
      `Spec sheet missing required columns. Found: ${headers.join(', ')}. ` +
      `Need: styleName, sizeName, specName, value`,
    );
  }

  // Collect raw specs grouped by styleName, with optional sizeOrder
  const specsByProduct = new Map<string, Array<SizeSpec & { _sizeOrder?: number }>> ();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const styleName = String(row[styleNameIdx] ?? '').trim();
    const sizeName = String(row[sizeNameIdx] ?? '').trim();
    const specName = String(row[specNameIdx] ?? '').trim();
    const value = String(row[valueIdx] ?? '').trim();

    if (!styleName || !sizeName || !specName || !value) continue;

    const sizeOrderRaw = sizeOrderIdx !== -1 ? row[sizeOrderIdx] : undefined;
    const sizeOrder = sizeOrderRaw !== undefined ? Number(sizeOrderRaw) : undefined;

    if (!specsByProduct.has(styleName)) {
      specsByProduct.set(styleName, []);
    }
    specsByProduct.get(styleName)!.push({ sizeName, specName, value, _sizeOrder: sizeOrder });
  }

  // Sort specs within each product
  const result = new Map<string, SizeSpec[]>();
  for (const [productId, specs] of specsByProduct) {
    const hasSizeOrder = specs.some((s) => s._sizeOrder !== undefined && !isNaN(s._sizeOrder));

    if (hasSizeOrder) {
      specs.sort((a, b) => {
        const oa = a._sizeOrder ?? Infinity;
        const ob = b._sizeOrder ?? Infinity;
        return oa - ob;
      });
    } else {
      // Fallback: sort by standard size order
      specs.sort((a, b) => {
        const ia = STANDARD_SIZE_ORDER.indexOf(a.sizeName);
        const ib = STANDARD_SIZE_ORDER.indexOf(b.sizeName);
        const sortA = ia === -1 ? Infinity : ia;
        const sortB = ib === -1 ? Infinity : ib;
        return sortA - sortB;
      });
    }

    // Strip internal _sizeOrder property before returning
    result.set(productId, specs.map(({ sizeName, specName, value }) => ({ sizeName, specName, value })));
  }

  logger.info(
    `Spec sheet structured: ${values.length - 1} rows, ${result.size} products`,
  );

  return result;
}
