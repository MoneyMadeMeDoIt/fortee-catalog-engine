/**
 * Batch writer: sends all enrichment updates to Google Sheets in a single API call.
 */
import type { sheets_v4 } from 'googleapis';
import type { EnrichmentUpdate } from './types.js';

/**
 * Write enrichment updates to the spreadsheet in a single batchUpdate call.
 * Uses RAW valueInputOption to prevent Sheets from interpreting formulas.
 *
 * @returns Number of cells actually updated, or 0 if no updates to write.
 */
export async function writeUpdates(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  updates: EnrichmentUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;

  const response = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });

  return response.data.totalUpdatedCells ?? 0;
}
