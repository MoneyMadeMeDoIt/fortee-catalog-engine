/**
 * Batch writer: sends enrichment updates to Google Sheets.
 * Chunks large batches to stay within API limits (~100K cells per request).
 */
import type { sheets_v4 } from 'googleapis';
import type { EnrichmentUpdate } from './types.js';
import { logger } from '../lib/logger.js';

const BATCH_SIZE = 50_000;

/**
 * Write enrichment updates to the spreadsheet.
 * Automatically chunks into multiple API calls if needed.
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

  let totalUpdated = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(updates.length / BATCH_SIZE);

    if (totalBatches > 1) {
      logger.info(`Writing batch ${batchNum}/${totalBatches} (${chunk.length} cells)...`);
    }

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk,
      },
    });

    totalUpdated += response.data.totalUpdatedCells ?? 0;
  }

  return totalUpdated;
}
