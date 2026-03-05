/**
 * Enrichment orchestrator: reads the master sheet, extracts supplier data,
 * merges into empty cells, and writes updates back.
 */
import { createSheetsClient } from './client.js';
import { readAllRows } from './reader.js';
import { mapSupplierToSheetFields, buildUpdates } from './merge.js';
import { writeUpdates } from './writer.js';
import { SUPPLIER_CODE_MAP } from './column-map.js';
import { extractFromSupplier } from '../suppliers/index.js';
import type { SupplierProduct } from '../suppliers/types.js';
import type { EnrichmentReport, EnrichmentUpdate } from './types.js';
import { logger } from '../lib/logger.js';

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

  // Step 1: Read current sheet state
  logger.info('Reading sheet...');
  const { headers, rows } = await readAllRows(sheets, spreadsheetId, sheetName);

  // Step 2: Determine which suppliers to extract
  const suppliersToExtract = new Set<SupplierName>();

  if (options.supplier) {
    suppliersToExtract.add(options.supplier);
  } else {
    // Find unique suppliers from sheet rows
    for (const row of rows) {
      const adapterName = SUPPLIER_CODE_MAP[row.supplierCode as keyof typeof SUPPLIER_CODE_MAP];
      if (adapterName) {
        suppliersToExtract.add(adapterName);
      }
    }
  }

  // Step 3: Extract supplier data and build lookup map
  const productsByStyle = new Map<string, SupplierProduct>();

  for (const supplier of suppliersToExtract) {
    logger.info(`Extracting from ${supplier}...`);
    const result = await extractFromSupplier(supplier);
    for (const product of result.products) {
      productsByStyle.set(`${supplier}:${product.styleNumber}`, product);
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

      const product = productsByStyle.get(`${adapterName}:${row.styleID}`);
      if (!product) {
        report.skippedNoMatch++;
        continue;
      }

      const supplierData = mapSupplierToSheetFields(product);
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
      logger.info(`[DRY RUN] Would write ${allUpdates.length} cell updates`);
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
