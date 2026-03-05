/**
 * Sheet reader: fetches all rows from the master product sheet
 * and parses them into typed SheetRow objects.
 */
import type { sheets_v4 } from 'googleapis';
import type { SheetRow } from './types.js';
import { SHEET_COLUMNS } from './types.js';

/**
 * Read all rows from the specified Google Sheet tab.
 *
 * - Row 1 is treated as the header row.
 * - Remaining rows are parsed into SheetRow objects using header-to-index mapping.
 * - Ragged rows (trailing empty cells) are padded to full header width with empty strings.
 *
 * @param sheets - Authenticated Google Sheets API client
 * @param spreadsheetId - The spreadsheet ID from the Google Sheets URL
 * @param sheetName - Tab name (defaults to GOOGLE_SHEET_NAME env var or "Sheet1")
 * @returns Object with headers array and rows as typed SheetRow objects
 * @throws If the sheet is empty or contains only a header row
 */
export async function readAllRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName?: string,
): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const tabName = sheetName ?? process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName,
  });

  const values = response.data.values;

  if (!values || values.length === 0) {
    throw new Error('Sheet has no data');
  }

  if (values.length < 2) {
    throw new Error('Sheet has no data rows');
  }

  const headers = values[0].map((h: string) => String(h).trim());
  const dataRows = values.slice(1);

  // Build header-to-index map for column lookup
  const headerIndex = new Map<string, number>();
  headers.forEach((header: string, idx: number) => {
    headerIndex.set(header, idx);
  });

  const rows: SheetRow[] = dataRows.map((row: string[]) => {
    // Pad ragged rows to full header width
    const padded = new Array(headers.length).fill('');
    row.forEach((cell: string, i: number) => {
      padded[i] = String(cell ?? '');
    });

    // Map padded array to SheetRow using header positions
    const sheetRow: Record<string, string> = {};
    for (const col of SHEET_COLUMNS) {
      const idx = headerIndex.get(col);
      sheetRow[col] = idx !== undefined ? padded[idx] : '';
    }

    return sheetRow as unknown as SheetRow;
  });

  return { headers, rows };
}
