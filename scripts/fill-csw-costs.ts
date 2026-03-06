/**
 * Fill costPrice for Canada Sportswear rows from the 2026 spring CSV.xlsx pricing file.
 * Matches by SKU (XLSX) to productId (sheet).
 * Then recalculates sellPrice1Area and sellPrice2Area.
 * Usage: npx tsx scripts/fill-csw-costs.ts [--dry-run]
 */
import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { writeUpdates } from '../src/sheets/writer.js';
import { columnToLetter, HEADER_ALIASES } from '../src/sheets/column-map.js';
import { SHEET_COLUMNS } from '../src/sheets/types.js';
import type { EnrichmentUpdate } from '../src/sheets/types.js';

function findColIndex(field: string, headers: string[]): number {
  const alias = HEADER_ALIASES[field];
  let idx = headers.indexOf(field);
  if (idx === -1 && alias) idx = headers.indexOf(alias);
  if (idx === -1) idx = SHEET_COLUMNS.indexOf(field as typeof SHEET_COLUMNS[number]);
  return idx;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Read the XLSX pricing file
  const wb = XLSX.readFile('2026 spring CSV.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const xlsxRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws);

  // Build cost map: SKU -> Cost
  const costByProductId = new Map<string, number>();
  for (const row of xlsxRows) {
    const sku = String(row['SKU'] ?? '').trim();
    const cost = Number(row['Cost']);
    if (sku && !isNaN(cost) && cost > 0) {
      costByProductId.set(sku, cost);
    }
  }
  console.log(`XLSX: ${xlsxRows.length} rows, ${costByProductId.size} unique SKUs with cost`);

  // Read the sheet
  const sheets = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';
  const { headers, rows } = await readAllRows(sheets, spreadsheetId, sheetName);

  // Find column indices
  const costCol = findColIndex('costPrice', headers);
  const sell1Col = findColIndex('sellPrice1Area', headers);
  const sell2Col = findColIndex('sellPrice2Area', headers);

  console.log(`Sheet columns: costPrice=${columnToLetter(costCol)}, sellPrice1Area=${columnToLetter(sell1Col)}, sellPrice2Area=${columnToLetter(sell2Col)}`);

  const updates: EnrichmentUpdate[] = [];
  let matched = 0;
  let alreadyFilled = 0;
  let noMatch = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.supplierCode.trim() !== 'CANADASPORTSWEAR') continue;

    const cost = costByProductId.get(row.productId);
    if (!cost) {
      noMatch++;
      continue;
    }

    const sheetRow = i + 2;

    // Fill costPrice if empty
    if (!row.costPrice.trim()) {
      updates.push({
        range: `${sheetName}!${columnToLetter(costCol)}${sheetRow}`,
        values: [[cost.toFixed(2)]],
      });
    } else {
      alreadyFilled++;
    }

    // Fill sell prices if empty
    if (!row.sellPrice1Area.trim()) {
      updates.push({
        range: `${sheetName}!${columnToLetter(sell1Col)}${sheetRow}`,
        values: [[(cost * 2 + 10).toFixed(2)]],
      });
    }
    if (!row.sellPrice2Area.trim()) {
      updates.push({
        range: `${sheetName}!${columnToLetter(sell2Col)}${sheetRow}`,
        values: [[(cost * 2 + 16).toFixed(2)]],
      });
    }

    matched++;
  }

  console.log(`Matched: ${matched}, Already filled: ${alreadyFilled}, No match: ${noMatch}`);
  console.log(`Updates: ${updates.length} cells`);

  if (updates.length > 0) {
    if (dryRun) {
      console.log('[DRY RUN] Sample updates:');
      for (const u of updates.slice(0, 10)) {
        console.log(`  ${u.range} = ${u.values[0][0]}`);
      }
      if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more`);
    } else {
      const written = await writeUpdates(sheets, spreadsheetId, updates);
      console.log(`Written: ${written} cells`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
