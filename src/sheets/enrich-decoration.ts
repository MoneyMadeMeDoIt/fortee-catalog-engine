/**
 * Decoration enrichment pipeline: fills decoration-related columns
 * for the old Shopify store (DTF only, Front + Back print areas).
 *
 * Fills: embroideryAvailable, dtfAvailable, sellPrice1Area, sellPrice2Area, decorationPlacements
 * Pricing: 1 area = cost*2+10, 2 areas = cost*2+16
 */
import { createSheetsClient } from './client.js';
import { readAllRows } from './reader.js';
import { writeUpdates } from './writer.js';
import { columnToLetter, HEADER_ALIASES } from './column-map.js';
import { SHEET_COLUMNS } from './types.js';
import type { EnrichmentUpdate, EnrichmentReport, SheetRow } from './types.js';
import { logger } from '../lib/logger.js';

export interface DecorationEnrichOptions {
  dryRun?: boolean;
}

/**
 * Build fill-gaps-only updates for decoration fields on a single row.
 */
function buildDecorationUpdates(
  row: SheetRow,
  data: Record<string, string>,
  headers: string[],
  rowIndex: number,
  sheetName: string,
): EnrichmentUpdate[] {
  const updates: EnrichmentUpdate[] = [];
  const sheetRowNumber = rowIndex + 2;

  for (const [field, value] of Object.entries(data)) {
    if (!value) continue;

    const currentValue = (row as Record<string, string>)[field] ?? '';
    if (currentValue.trim() !== '') continue;

    // Find column index: try actual headers first, then alias, then SHEET_COLUMNS position
    const alias = HEADER_ALIASES[field];
    let colIndex = headers.indexOf(field);
    if (colIndex === -1 && alias) colIndex = headers.indexOf(alias);
    if (colIndex === -1) colIndex = SHEET_COLUMNS.indexOf(field as typeof SHEET_COLUMNS[number]);
    if (colIndex === -1) continue;

    updates.push({
      range: `${sheetName}!${columnToLetter(colIndex)}${sheetRowNumber}`,
      values: [[value]],
    });
  }

  return updates;
}

/**
 * Run the decoration enrichment pipeline:
 * 1. Read all rows
 * 2. For each row with a valid costPrice, compute prices and set decoration fields
 * 3. Batch write all updates (fill-gaps-only)
 */
export async function enrichDecoration(
  options: DecorationEnrichOptions = {},
): Promise<EnrichmentReport> {
  const sheets = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error('Missing GOOGLE_SPREADSHEET_ID in environment.');
  }

  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  logger.info('Reading sheet for decoration enrichment...');
  const { headers, rows } = await readAllRows(sheets, spreadsheetId, sheetName);

  logger.info(`Processing ${rows.length} rows for decoration data...`);
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
      const cost = parseFloat(row.costPrice);

      // Compute sell prices if cost is valid
      let sellPrice1Area = '';
      let sellPrice2Area = '';
      if (!isNaN(cost) && cost > 0) {
        sellPrice1Area = (cost * 2 + 10).toFixed(2);
        sellPrice2Area = (cost * 2 + 16).toFixed(2);
      }

      const data: Record<string, string> = {
        embroideryAvailable: 'No',
        dtfAvailable: 'Yes',
        sellPrice1Area,
        sellPrice2Area,
        decorationPlacements: 'Front, Back',
      };

      const updates = buildDecorationUpdates(row, data, headers, i, sheetName);

      if (updates.length > 0) {
        allUpdates.push(...updates);
        report.rowsEnriched++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push({ partId: row.PartID || `row-${i}`, error: message });
    }
  }

  if (allUpdates.length > 0) {
    if (options.dryRun) {
      logger.info(`[DRY RUN] Would write ${allUpdates.length} cell updates across ${report.rowsEnriched} rows`);
      for (const update of allUpdates.slice(0, 15)) {
        logger.info(`  ${update.range} = ${update.values[0][0]}`);
      }
      if (allUpdates.length > 15) {
        logger.info(`  ... and ${allUpdates.length - 15} more`);
      }
      report.cellsWritten = 0;
    } else {
      report.cellsWritten = await writeUpdates(sheets, spreadsheetId, allUpdates);
    }
  }

  logger.info(
    `Decoration enrichment: ${report.rowsEnriched} rows enriched, ` +
      `${report.cellsWritten} cells written, ${report.skippedNoMatch} skipped`,
  );

  return report;
}
