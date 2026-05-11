#!/usr/bin/env tsx
/**
 * Inspect S05610 + L00550 — pull supplier data + product name + current
 * baseCategory so we can pick the correct replacement category string.
 *
 * Also shows distribution of baseCategory values currently used by other
 * "tops" (t-shirts) and "hoodies" products in BR so we match conventions.
 */

import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { getCategoryGroup } from '../src/shopify/variants.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bestsellers-Ready';

async function main() {
  const sheets = createSheetsClient();
  const { rows } = await readAllRows(sheets, SPREADSHEET_ID, SHEET_NAME);
  console.log(`Loaded ${rows.length} rows from ${SHEET_NAME}\n`);

  for (const pid of ['S05610', 'L00550', 'S05772', 'L00540', 'L01115']) {
    const matches = rows.filter((r) => r.productId === pid);
    if (matches.length === 0) {
      console.log(`${pid}: not found`);
      continue;
    }
    const first = matches[0] as any;
    console.log(`=== ${pid} (${matches.length} rows) ===`);
    console.log(`  productTitle:  ${first.productTitle || first.title || '(no title col)'}`);
    console.log(`  supplierCode:  ${first.supplierCode}`);
    console.log(`  baseCategory:  "${first.baseCategory}"`);
    console.log(`  derived:       ${getCategoryGroup(first.baseCategory) ?? '(unmapped)'}`);
    // Show any other interesting fields
    const printable = ['size', 'color', 'name', 'description'];
    for (const k of printable) {
      const v = (first as any)[k];
      if (v) console.log(`  ${k}:  ${String(v).slice(0, 80)}`);
    }
    console.log('');
  }

  // Distribution of current baseCategory strings by derived group
  console.log('=== Distribution of baseCategory strings (top per group) ===\n');
  const byGroup = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.baseCategory) continue;
    const group = getCategoryGroup(r.baseCategory) ?? '(unmapped)';
    if (!byGroup.has(group)) byGroup.set(group, new Map());
    const counts = byGroup.get(group)!;
    counts.set(r.baseCategory, (counts.get(r.baseCategory) || 0) + 1);
  }

  for (const group of ['tops', 'hoodies', 'polos', 'crewnecks', 'jackets']) {
    const counts = byGroup.get(group);
    if (!counts) continue;
    const top5 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`${group}:`);
    for (const [cat, n] of top5) {
      console.log(`  ${String(n).padStart(5)}  ${cat}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
