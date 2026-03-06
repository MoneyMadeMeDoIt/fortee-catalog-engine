/**
 * Add missing column headers to the sheet.
 * First expands the grid if needed, then writes headers.
 * Usage: npx tsx scripts/add-missing-headers.ts
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';

const HEADERS_TO_ADD = ['sellPrice1Area', 'sellPrice2Area', 'decorationPlacements'];

function columnToLetter(col: number): string {
  let letter = '';
  let idx = col;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

async function main() {
  const sheets = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  // Read current headers
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
  });
  const existing = (res.data.values?.[0] ?? []) as string[];
  console.log(`Current headers: ${existing.length} columns (last: "${existing[existing.length - 1]}")`);

  const toAdd = HEADERS_TO_ADD.filter(h => !existing.includes(h));
  if (toAdd.length === 0) {
    console.log('All headers already exist. Nothing to do.');
    return;
  }

  // Get sheet ID (needed for appendDimension)
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetMeta = meta.data.sheets?.find(s => s.properties?.title === sheetName);
  const sheetId = sheetMeta?.properties?.sheetId ?? 0;

  // Expand the grid to accommodate new columns
  console.log(`Expanding grid by ${toAdd.length} columns...`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        appendDimension: {
          sheetId,
          dimension: 'COLUMNS',
          length: toAdd.length,
        },
      }],
    },
  });

  // Write new headers
  const startCol = existing.length;
  const startLetter = columnToLetter(startCol);
  const endLetter = columnToLetter(startCol + toAdd.length - 1);
  const range = `${sheetName}!${startLetter}1:${endLetter}1`;

  console.log(`Writing headers at ${range}: ${toAdd.join(', ')}`);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [toAdd] },
  });

  console.log('Done. New headers added.');
}

main().catch(e => { console.error(e); process.exit(1); });
