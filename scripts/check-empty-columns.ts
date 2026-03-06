/**
 * Check which columns are empty across the sheet.
 * Shows fill rate per column so we know what still needs enrichment.
 * Usage: npx tsx scripts/check-empty-columns.ts
 */
import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { SHEET_COLUMNS } from '../src/sheets/types.js';

async function main() {
  const sheets = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  console.log('Reading sheet...');
  const { headers, rows } = await readAllRows(sheets, spreadsheetId, sheetName);

  console.log(`\nTotal rows: ${rows.length}`);
  console.log(`Headers: ${headers.length}`);
  console.log('\n--- Column Fill Rates ---\n');

  const stats: Array<{ col: string; filled: number; empty: number; pct: string }> = [];

  for (const col of SHEET_COLUMNS) {
    let filled = 0;
    let empty = 0;
    for (const row of rows) {
      const val = (row as Record<string, string>)[col] ?? '';
      if (val.trim() !== '') filled++;
      else empty++;
    }
    const pct = ((filled / rows.length) * 100).toFixed(1);
    stats.push({ col, filled, empty, pct });
  }

  // Print table
  const maxName = Math.max(...stats.map(s => s.col.length));
  console.log(`${'Column'.padEnd(maxName)}  Filled     Empty      Fill%`);
  console.log('-'.repeat(maxName + 40));
  for (const s of stats) {
    const flag = parseFloat(s.pct) === 0 ? ' << EMPTY' : parseFloat(s.pct) < 50 ? ' < LOW' : '';
    console.log(
      `${s.col.padEnd(maxName)}  ${String(s.filled).padStart(8)}  ${String(s.empty).padStart(8)}  ${s.pct.padStart(6)}%${flag}`,
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
