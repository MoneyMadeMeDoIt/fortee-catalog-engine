#!/usr/bin/env tsx
/**
 * Phase 15 fixture prep — update baseCategory ("category" column) for
 * S05610 + L00550 in Bestsellers-Ready so they derive to the correct
 * CategoryGroup (tops, hoodies) for verifier fixture testing.
 *
 * Run with --dry-run to preview without writing.
 */

import { parseArgs } from 'node:util';
import { createSheetsClient } from '../src/sheets/client.js';
import { writeUpdates } from '../src/sheets/writer.js';
import { logger } from '../src/lib/logger.js';
import { HEADER_ALIASES } from '../src/sheets/column-map.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bestsellers-Ready';

const FIXES: Record<string, { from: string; to: string }> = {
  S05610: { from: 'T-shirts/Shorts/Polos', to: 'T-Shirts - Core' },
  L00550: { from: 'Fleece', to: 'Fleece - Core - Hood' },
};

function columnIndexToA1(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

async function main() {
  const { values: args } = parseArgs({
    options: { 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  const dryRun = (args as any)['dry-run'] === true;

  const sheets = createSheetsClient();
  logger.info(`Reading ${SHEET_NAME}...`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
  });
  const values = response.data.values;
  if (!values || values.length < 2) {
    console.error(`No data in ${SHEET_NAME}`);
    process.exit(1);
  }

  const headers = values[0].map((h: string) => String(h).trim());
  const categoryHeader = 'baseCategory';
  const categoryCol = headers.indexOf(categoryHeader);
  const actualPidCol = headers.indexOf('productId');

  if (categoryCol < 0) {
    console.error(`"${categoryHeader}" column not found. Headers: ${headers.slice(0, 20).join(', ')}`);
    process.exit(1);
  }
  if (actualPidCol < 0) {
    console.error(`productId column not found. Headers: ${headers.slice(0, 20).join(', ')}`);
    process.exit(1);
  }

  logger.info(`category column: ${columnIndexToA1(categoryCol)} (index ${categoryCol})`);
  logger.info(`productId column: ${columnIndexToA1(actualPidCol)} (index ${actualPidCol})`);

  const dataRows = values.slice(1);
  const updates: { range: string; values: string[][] }[] = [];
  const skipped: { sheetRow: number; pid: string; current: string; expected: string }[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const pid = String(row[actualPidCol] || '').trim();
    if (!FIXES[pid]) continue;

    const sheetRowNumber = i + 2; // header is row 1
    const current = String(row[categoryCol] || '').trim();
    const { from, to } = FIXES[pid];

    if (current === to) continue; // already correct
    if (current !== from) {
      skipped.push({ sheetRow: sheetRowNumber, pid, current, expected: from });
      continue;
    }

    const cellA1 = `${columnIndexToA1(categoryCol)}${sheetRowNumber}`;
    updates.push({
      range: `${SHEET_NAME}!${cellA1}`,
      values: [[to]],
    });
  }

  logger.info(`Updates queued: ${updates.length}`);
  if (skipped.length > 0) {
    logger.warn(`Skipped (unexpected current value): ${skipped.length}`);
    for (const s of skipped.slice(0, 10)) {
      logger.warn(`  row ${s.sheetRow} ${s.pid}: current="${s.current}" (expected "${s.expected}")`);
    }
  }

  // Preview a sample
  console.log('\nSample updates (first 5):');
  for (const u of updates.slice(0, 5)) {
    console.log(`  ${u.range} → "${u.values[0][0]}"`);
  }
  if (updates.length > 5) console.log(`  ... and ${updates.length - 5} more`);

  if (dryRun) {
    console.log('\nDRY RUN — no writes performed.');
    return;
  }

  if (updates.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  console.log(`\nWriting ${updates.length} cells to ${SHEET_NAME}...`);
  const written = await writeUpdates(sheets, SPREADSHEET_ID, updates);
  console.log(`Wrote ${written} cells.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
