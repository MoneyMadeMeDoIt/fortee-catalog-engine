import 'dotenv/config';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { readSpecSheet } from '../src/sheets/spec-sheet.js';

async function run() {
  const sheets = createSheetsClient();
  const id = process.env.GOOGLE_SPREADSHEET_ID!;
  const specId = process.env.SPEC_SHEET_GOOGLE_SPREADSHEET_ID;

  const [{ rows }, sizeMap] = await Promise.all([
    readAllRows(sheets, id, 'Sheet1'),
    specId ? readSpecSheet(sheets, specId) : Promise.resolve(new Map<string, string>()),
  ]);

  const uniqueIds = new Set(rows.map(r => r.productId).filter(Boolean));
  let matched = 0;
  for (const pid of uniqueIds) {
    if (sizeMap.has(pid)) matched++;
  }
  console.log(`Spec sheet products: ${sizeMap.size}`);
  console.log(`Sheet unique productIds: ${uniqueIds.size}`);
  console.log(`Matched: ${matched}  Unmatched: ${uniqueIds.size - matched}`);

  const hits = [...uniqueIds].filter(id => sizeMap.has(id)).slice(0, 5);
  const miss = [...uniqueIds].filter(id => !sizeMap.has(id)).slice(0, 5);
  console.log(`Sample matches: ${hits.join(', ')}`);
  console.log(`Sample misses: ${miss.join(', ')}`);
}

run().catch(e => { console.error(e); process.exit(1); });
