import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';

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
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    range: `${process.env.GOOGLE_SHEET_NAME ?? 'Sheet1'}!1:1`,
  });
  const headers = res.data.values![0] as string[];
  console.log(`Total headers: ${headers.length}\n`);
  headers.forEach((h: string, i: number) => {
    console.log(`  ${columnToLetter(i).padStart(3)} (${String(i).padStart(2)}): "${h}"`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
