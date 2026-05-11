#!/usr/bin/env tsx
/**
 * Phase 15 fixture binary fetcher.
 *
 * Reads each fixture pid's FrontImage/BackImage/DirectSideImage URLs from
 * Bestsellers-Ready, resolves the Drive fileId, downloads to
 * tests/fixtures/garment-type/{pid}-{view}.png.
 *
 * Reuses the existing Drive client (env-authed). Read-only on Drive.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient } from '../src/sheets/drive.js';
import { readAllRows } from '../src/sheets/reader.js';
import { logger } from '../src/lib/logger.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Bestsellers-Ready';
const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'garment-type');

const FIXTURES = [
  // Bad fixtures — user-flagged polluted catalog entries (mixed/wrong/duplicate images)
  { pid: '1010', group: 'tops', kind: 'bad', note: 'duplicate images' },
  { pid: '6110', group: 'tops', kind: 'bad', note: 'random images mixed (polos, aprons)' },
  { pid: '8882', group: 'tops', kind: 'bad', note: 'wrong product as model image' },
  { pid: '5200', group: 'tops', kind: 'bad', note: 'mixing Gildan 5200 with C2 5200 + wrong model images' },
  { pid: '3900', group: 'tops', kind: 'bad', note: 'mixing adidas polo with 3/4-sleeve raglan tee' },
  { pid: '102', group: 'tops', kind: 'bad', note: 'random products mixed in' },
  { pid: '1301', group: 'tops', kind: 'bad', note: 'wrong model image' },
  // Good fixtures — user-curated clean reference products (baseCategory now matches CategoryGroup)
  { pid: 'S05610', group: 'tops', kind: 'good', note: 't-shirt template' },
  { pid: 'L00550', group: 'hoodies', kind: 'good', note: 'hoodie template' },
  { pid: 'S05772', group: 'polos', kind: 'good', note: 'polo template' },
  { pid: 'L00540', group: 'crewnecks', kind: 'good', note: 'crewneck template' },
  { pid: 'L01115', group: 'jackets', kind: 'good', note: 'jacket template' },
  { pid: 'L00693', group: 'jackets', kind: 'good', note: 'jacket (retro-audit false positive — discontinued color mixing)' },
];

/** Extract Drive fileId from a uc?id=... URL. */
function extractFileId(url: string): string | null {
  if (!url) return null;
  const ucMatch = url.match(/[?&]id=([\w-]{20,})/);
  if (ucMatch) return ucMatch[1];
  const fileMatch = url.match(/\/file\/d\/([\w-]{20,})/);
  if (fileMatch) return fileMatch[1];
  return null;
}

async function downloadFile(drive: ReturnType<typeof createDriveClient>, fileId: string, outPath: string): Promise<void> {
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(response.data as ArrayBuffer);
  writeFileSync(outPath, buffer);
}

async function main() {
  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  const sheets = createSheetsClient();
  const drive = createDriveClient();
  logger.info(`Reading ${SHEET_NAME}...`);
  const { rows } = await readAllRows(sheets, SPREADSHEET_ID, SHEET_NAME);
  logger.info(`Loaded ${rows.length} rows.`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const f of FIXTURES) {
    const matches = rows.filter((r) => r.productId === f.pid);
    if (matches.length === 0) {
      console.error(`  ✗ ${f.pid}: not found in ${SHEET_NAME}`);
      errorCount++;
      continue;
    }
    // Pick first color row with all 3 images
    const row = matches.find(
      (r) => r.FrontImage?.trim() && r.BackImage?.trim() && r.DirectSideImage?.trim(),
    );
    if (!row) {
      console.error(`  ✗ ${f.pid}: no color row has all 3 images`);
      errorCount++;
      continue;
    }

    const urls = {
      front: row.FrontImage,
      back: row.BackImage,
      side: row.DirectSideImage,
    };

    console.log(`\n${f.pid} (${f.kind}, ${f.group}) — ${f.note}`);
    for (const [view, url] of Object.entries(urls)) {
      const fileId = extractFileId(url);
      if (!fileId) {
        console.error(`  ✗ ${view}: could not extract fileId from ${url}`);
        errorCount++;
        continue;
      }
      const outPath = join(FIXTURE_DIR, `${f.pid}-${view}.png`);
      if (existsSync(outPath)) {
        console.log(`  ✓ ${view}: already exists (skipping)`);
        skipCount++;
        continue;
      }
      try {
        await downloadFile(drive, fileId, outPath);
        console.log(`  ✓ ${view}: downloaded ${fileId.slice(0, 12)}…`);
        successCount++;
      } catch (err: any) {
        console.error(`  ✗ ${view}: download failed — ${err.message}`);
        errorCount++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Downloaded: ${successCount}`);
  console.log(`Skipped (already present): ${skipCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Fixture dir: ${FIXTURE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
