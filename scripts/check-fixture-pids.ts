#!/usr/bin/env tsx
/**
 * Verify user-confirmed fixture pids exist in Bestsellers-Ready with
 * all three image URLs populated. Also surface S05772 color rows so
 * we can see which images are duplicated.
 */

import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { getCategoryGroup } from '../src/shopify/variants.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bestsellers-Ready';

const PICKS = {
  tops: 'S05610',
  hoodies: 'L00550',
  polos: 'S05772',
  crewnecks: 'L00540',
  jackets: 'L01115',
};

async function main() {
  const sheets = createSheetsClient();
  console.log(`Reading ${SHEET_NAME}...`);
  const { rows } = await readAllRows(sheets, SPREADSHEET_ID, SHEET_NAME);
  console.log(`Loaded ${rows.length} rows.\n`);

  for (const [group, pid] of Object.entries(PICKS)) {
    const matches = rows.filter((r) => r.productId === pid);
    console.log(`=== ${group}: ${pid} (${matches.length} color rows) ===`);
    if (matches.length === 0) {
      console.log(`  ⚠ not found in ${SHEET_NAME}`);
      continue;
    }
    const first = matches[0];
    console.log(`  baseCategory:    ${first.baseCategory}`);
    console.log(`  derived group:   ${getCategoryGroup(first.baseCategory) ?? '(unmapped)'}`);
    console.log(`  expected group:  ${group}`);

    // Pick the first row with all 3 images for fixture
    const withAll3 = matches.find(
      (r) => r.FrontImage?.trim() && r.BackImage?.trim() && r.DirectSideImage?.trim(),
    );
    if (!withAll3) {
      console.log('  ⚠ no color row has all 3 images populated');
      continue;
    }
    const colorLabel = (withAll3 as any).color || (withAll3 as any).colorName || '(unknown color)';
    console.log(`  fixture color:   ${colorLabel}`);
    console.log(`  Front:           ${withAll3.FrontImage}`);
    console.log(`  Back:            ${withAll3.BackImage}`);
    console.log(`  Side:            ${withAll3.DirectSideImage}`);
    console.log('');
  }

  // Surface S05772 duplicate situation in detail
  console.log('=== S05772 deep-dive (duplicate check) ===');
  const s05772 = rows.filter((r) => r.productId === 'S05772');
  console.log(`  ${s05772.length} color rows total`);

  const fronts = new Map<string, string[]>();
  const backs = new Map<string, string[]>();
  const sides = new Map<string, string[]>();
  for (const r of s05772) {
    const color = (r as any).color || (r as any).colorName || '?';
    if (r.FrontImage?.trim()) {
      const arr = fronts.get(r.FrontImage) || [];
      arr.push(color);
      fronts.set(r.FrontImage, arr);
    }
    if (r.BackImage?.trim()) {
      const arr = backs.get(r.BackImage) || [];
      arr.push(color);
      backs.set(r.BackImage, arr);
    }
    if (r.DirectSideImage?.trim()) {
      const arr = sides.get(r.DirectSideImage) || [];
      arr.push(color);
      sides.set(r.DirectSideImage, arr);
    }
  }

  for (const [label, m] of [
    ['Fronts', fronts],
    ['Backs', backs],
    ['Sides', sides],
  ] as const) {
    const dupes = [...m.entries()].filter(([, colors]) => colors.length > 1);
    console.log(`\n  ${label}: ${m.size} unique URLs, ${dupes.length} URL(s) shared across colors`);
    for (const [url, colors] of dupes.slice(0, 5)) {
      console.log(`    shared by [${colors.join(', ')}]:  ${url}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
