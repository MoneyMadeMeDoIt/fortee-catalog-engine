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
