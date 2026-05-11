#!/usr/bin/env tsx
/**
 * Phase 15 fixture candidate picker.
 *
 * Reads the BR sheet, filters rows that have all three image URLs populated
 * (FrontImage, BackImage, DirectSideImage), DEDUPES by productId, buckets by
 * CategoryGroup, and prints up to 3 candidates per bucket so the operator can
 * confirm.
 *
 * Run: `npx tsx --use-system-ca -r dotenv/config scripts/pick-fixture-candidates.ts dotenv_config_path=.env`
 *
 * Read-only — no writes.
 */

import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { getCategoryGroup } from '../src/shopify/variants.js';
import type { SheetRow } from '../src/sheets/types.js';
import type { CategoryGroup } from '../src/shopify/types.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
if (!SPREADSHEET_ID) {
  console.error('GOOGLE_SPREADSHEET_ID env var required');
  process.exit(1);
}

const REQUIRED_GROUPS: CategoryGroup[] = ['tops', 'hoodies', 'polos', 'crewnecks', 'jackets'];
const CANDIDATES_PER_GROUP = 10;

function hasAllThreeImages(row: SheetRow): boolean {
  return (
    Boolean(row.FrontImage?.trim()) &&
    Boolean(row.BackImage?.trim()) &&
    Boolean(row.DirectSideImage?.trim())
  );
}

async function main() {
  const sheets = createSheetsClient();
  console.log(`Reading sheet ${SPREADSHEET_ID}...`);
  const { rows } = await readAllRows(sheets, SPREADSHEET_ID!);
  console.log(`Loaded ${rows.length} rows.`);

  const eligible = rows.filter(hasAllThreeImages);
  console.log(`${eligible.length} rows have all three images populated.\n`);

  // Bucket by CategoryGroup — DEDUPED by productId
  const buckets = new Map<CategoryGroup, Map<string, SheetRow>>();
  for (const g of REQUIRED_GROUPS) buckets.set(g, new Map());

  for (const row of eligible) {
    if (!row.baseCategory) continue;
    const group = getCategoryGroup(row.baseCategory);
    if (!group) continue;
    const bucket = buckets.get(group)!;
    if (!bucket.has(row.productId)) bucket.set(row.productId, row);
  }

  // Print top candidates per bucket with front-image preview URL
  for (const group of REQUIRED_GROUPS) {
    const candidates = [...buckets.get(group)!.values()].slice(0, CANDIDATES_PER_GROUP);
    const total = buckets.get(group)!.size;
    console.log(`=== ${group} (${total} unique pids eligible) ===`);
    if (candidates.length === 0) {
      console.log('  ⚠ no eligible pids — relax filter or pick manually');
    } else {
      for (const row of candidates) {
        console.log(`  ${row.productId.padEnd(12)} ${row.baseCategory.padEnd(30)} front: ${row.FrontImage}`);
      }
    }
    console.log('');
  }

  console.log('Next step: confirm which pid from each group should be FIXTURE-{group}-01.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
