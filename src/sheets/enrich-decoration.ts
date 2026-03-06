/**
 * Decoration enrichment pipeline: reads product rows from the sheet,
 * resolves garment categories, looks up decoration rules, calculates
 * pricing, and writes results back using fill-gaps-only semantics.
 */
import { createSheetsClient } from './client.js';
import { readAllRows } from './reader.js';
import { writeUpdates } from './writer.js';
import { columnToLetter } from './column-map.js';
import {
  resolveCategory,
  getDecorationRulesForCategory,
  calculateSellPrice,
} from '../decoration/index.js';
import type { DecorationPlacement } from '../decoration/index.js';
import type { EnrichmentUpdate, EnrichmentReport, SheetRow } from './types.js';
import { logger } from '../lib/logger.js';

export interface DecorationEnrichOptions {
  dryRun?: boolean;
  discountPercent?: number;
}

/**
 * Format decoration placements as a semicolon-separated string.
 * Groups placements by method, listing placement names per method.
 * Example: "Print: Left Chest, Full Front; Embroidery: Left Chest"
 */
export function formatPlacements(placements: DecorationPlacement[]): string {
  const byMethod = new Map<string, string[]>();

  for (const p of placements) {
    const existing = byMethod.get(p.method) ?? [];
    existing.push(p.placementName);
    byMethod.set(p.method, existing);
  }

  const parts: string[] = [];
  for (const [method, names] of byMethod) {
    parts.push(`${method}: ${names.join(', ')}`);
  }

  return parts.join('; ');
}

/**
 * Build fill-gaps-only updates for decoration fields on a single row.
 * Only writes to cells that are currently empty.
 */
export function buildDecorationUpdates(
  row: SheetRow,
  data: Record<string, string>,
  headers: string[],
  rowIndex: number,
  sheetName: string,
): EnrichmentUpdate[] {
  const updates: EnrichmentUpdate[] = [];
  const sheetRowNumber = rowIndex + 2; // row 0 = sheet row 2 (row 1 = headers)

  for (const [field, value] of Object.entries(data)) {
    const currentValue = (row as Record<string, string>)[field] ?? '';

    // Skip if cell already has data (fill-gaps-only)
    if (currentValue.trim() !== '') continue;

    const colIndex = headers.indexOf(field);
    if (colIndex === -1) continue;

    const colLetter = columnToLetter(colIndex);
    updates.push({
      range: `${sheetName}!${colLetter}${sheetRowNumber}`,
      values: [[value]],
    });
  }

  return updates;
}

/**
 * Run the decoration enrichment pipeline:
 * 1. Read all rows from the master sheet
 * 2. For each row, resolve category and look up decoration rules
 * 3. Compute embroidery/DTF availability, placements string, and sell price
 * 4. Build fill-gaps-only updates
 * 5. Batch write all updates
 */
export async function enrichDecoration(
  options: DecorationEnrichOptions = {},
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
  const discountPercent = options.discountPercent ?? 0.45;

  // Step 1: Read current sheet state
  logger.info('Reading sheet for decoration enrichment...');
  const { headers, rows } = await readAllRows(sheets, spreadsheetId, sheetName);

  // Step 2: Process each row
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
      // Resolve garment category
      const category = resolveCategory(row.baseCategory);
      if (!category) {
        report.skippedNoMatch++;
        continue;
      }

      // Get decoration placements for this category
      const placements = getDecorationRulesForCategory(category);

      // Determine availability flags
      const embroideryAvailable = placements.some((p) => p.method === 'Embroidery')
        ? 'Yes'
        : 'No';
      const dtfAvailable = placements.some((p) => p.method === 'Print') ? 'Yes' : 'No';

      // Format decoration placements string
      const decorationPlacements = formatPlacements(placements);

      // Calculate sell price if costPrice is valid
      let sellPrice = '';
      const cost = parseFloat(row.costPrice);
      if (!isNaN(cost) && cost > 0) {
        const printAreas = placements.filter((p) => p.method === 'Print').length > 0 ? 1 : 0;
        const result = calculateSellPrice({
          garmentCost: cost,
          printAreas,
          embroideryAreas: 0,
          stitchCount: 0,
          discountPercent,
        });
        sellPrice = result.sellPrice.toFixed(2);
      }

      // Build data object for fill-gaps-only updates
      const data: Record<string, string> = {
        embroideryAvailable,
        dtfAvailable,
        decorationPlacements,
        sellPrice,
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

  // Step 3: Write updates
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
    `Decoration enrichment: ${report.rowsEnriched} rows enriched, ` +
      `${report.cellsWritten} cells written, ${report.skippedNoMatch} skipped (no category match)`,
  );

  return report;
}
