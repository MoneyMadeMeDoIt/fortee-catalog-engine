/**
 * Enrichment orchestrator: reads the master sheet, extracts supplier data,
 * merges into empty cells, and writes updates back.
 */
import { createSheetsClient } from './client.js';
import { readAllRows } from './reader.js';
import { mapSupplierToSheetFields, buildUpdates } from './merge.js';
import { writeUpdates } from './writer.js';
import { SUPPLIER_CODE_MAP } from './column-map.js';
import { readSpecSheet } from './spec-sheet.js';
import { extractProductsByIds } from '../suppliers/index.js';
import type { SupplierProduct } from '../suppliers/types.js';
import type { EnrichmentReport, EnrichmentUpdate } from './types.js';
import { logger } from '../lib/logger.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

type SupplierName = 'canada-sportswear' | 'ss-canada';

interface EnrichOptions {
  supplier?: SupplierName;
  dryRun?: boolean;
}

/**
 * Run the full enrichment pipeline:
 * 1. Read all rows from the master sheet
 * 2. Extract supplier product data
 * 3. Match sheet rows to supplier products by styleID
 * 4. Build updates for empty cells only
 * 5. Write all updates in a single batch
 */
export async function enrichSheet(
  options: EnrichOptions = {},
): Promise<EnrichmentReport> {
  const sheets = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error(
      'Missing GOOGLE_SPREADSHEET_ID in environment. ' +
      'Set it in .env to the spreadsheet ID from your Google Sheets URL.',
    );
  }

  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  // Step 1: Read current sheet state and spec sheet in parallel
  logger.info('Reading sheet...');
  const specSheetId = process.env.SPEC_SHEET_GOOGLE_SPREADSHEET_ID;

  const [{ headers, rows }, sizeChartByProduct] = await Promise.all([
    readAllRows(sheets, spreadsheetId, sheetName),
    specSheetId
      ? readSpecSheet(sheets, specSheetId)
      : Promise.resolve(new Map<string, string>()),
  ]);

  // Step 2: Collect unique productIds per supplier from the sheet
  // The OneSource API uses productId (e.g. "029HBM"), not styleID (e.g. "6128")
  const productIdsBySupplier = new Map<SupplierName, Set<string>>();

  for (const row of rows) {
    const adapterName = SUPPLIER_CODE_MAP[row.supplierCode as keyof typeof SUPPLIER_CODE_MAP];
    if (!adapterName) continue;
    if (options.supplier && adapterName !== options.supplier) continue;
    if (!row.productId) continue;

    if (!productIdsBySupplier.has(adapterName)) {
      productIdsBySupplier.set(adapterName, new Set());
    }
    productIdsBySupplier.get(adapterName)!.add(row.productId);
  }

  // Step 3: Fetch only the products that exist in the sheet
  const productsByProductId = new Map<string, SupplierProduct>();

  for (const [supplier, productIds] of productIdsBySupplier) {
    logger.info(`Fetching ${productIds.size} products from ${supplier}...`);
    const result = await extractProductsByIds(supplier, [...productIds], { skipValidation: true });
    for (const product of result.products) {
      productsByProductId.set(`${supplier}:${product.styleNumber}`, product);
    }
  }

  // Step 4: Process each row
  logger.info(`Processing ${rows.length} rows...`);
  const allUpdates: EnrichmentUpdate[] = [];
  const report: EnrichmentReport = {
    rowsScanned: rows.length,
    rowsEnriched: 0,
    cellsWritten: 0,
    skippedNoMatch: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      const adapterName = SUPPLIER_CODE_MAP[row.supplierCode as keyof typeof SUPPLIER_CODE_MAP];
      if (!adapterName) {
        report.skippedNoMatch++;
        continue;
      }

      // Filter by supplier option if specified
      if (options.supplier && adapterName !== options.supplier) {
        continue;
      }

      const product = productsByProductId.get(`${adapterName}:${row.productId}`);

      // Start with API data if available, otherwise empty
      const supplierData = product ? mapSupplierToSheetFields(product) : {};

      // Override sizeChart with spec sheet data regardless of API match
      const specChart = sizeChartByProduct.get(row.productId);
      if (specChart) {
        supplierData.sizeChart = specChart;
      }

      // Skip if no data to write at all
      if (Object.keys(supplierData).length === 0) {
        report.skippedNoMatch++;
        continue;
      }

      const updates = buildUpdates(row, supplierData, headers, i, sheetName);

      if (updates.length > 0) {
        allUpdates.push(...updates);
        report.rowsEnriched++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push({ partId: row.PartID || `row-${i}`, error: message });
    }
  }

  // Step 5: Write updates
  if (allUpdates.length > 0) {
    if (options.dryRun) {
      const affectedRows = [...new Set(allUpdates.map(u => u.range.replace(/.*?([A-Z]+)(\d+)/, '$2')))].sort((a, b) => Number(a) - Number(b));
      logger.info(`[DRY RUN] Would write ${allUpdates.length} cell updates across ${affectedRows.length} rows`);
      logger.info(`[DRY RUN] Affected rows: ${affectedRows.join(', ')}`);
      for (const update of allUpdates.slice(0, 10)) {
        logger.info(`  ${update.range} = ${update.values[0][0]}`);
      }
      if (allUpdates.length > 10) {
        logger.info(`  ... and ${allUpdates.length - 10} more`);
      }
      report.cellsWritten = 0;
    } else {
      report.cellsWritten = await writeUpdates(sheets, spreadsheetId, allUpdates);
    }
  }

  logger.info(
    `Enriched ${report.rowsEnriched} rows, wrote ${report.cellsWritten} cells, ` +
    `skipped ${report.skippedNoMatch} (no match)`,
  );

  return report;
}
