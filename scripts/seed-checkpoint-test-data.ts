/**
 * One-shot seeder for Phase 16 Plan 04 Task 2 operator checkpoint.
 *
 * Creates throwaway test data so the operator can run
 * scripts/fix-image-pollution-manual.ts without touching real catalog data:
 *
 *   - 4 simple PNG buffers (colored squares with text labels)
 *   - Uploaded to Drive under supplier folder "CHECKPOINT-TEST"
 *   - 2 throwaway rows appended to Bestsellers-Ready (productId CHECKPOINT-TEST-001 / -002)
 *   - Queue TSV written at tmp/image-pollution-manual-queue-<date>-test.tsv
 *
 * After the checkpoint passes, run scripts/cleanup-checkpoint-test-data.ts
 * to remove the BR rows + trash any remaining Drive files.
 *
 * Run: NODE_OPTIONS=--use-system-ca npx tsx scripts/seed-checkpoint-test-data.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import sharp from 'sharp';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient, uploadToDrive, extractFileId } from '../src/sheets/drive.js';
import { appendRows } from '../src/sheets/writer.js';

const SHEET_NAME = 'Bestsellers-Ready';
const SUPPLIER_PREFIX = 'CHECKPOINT-TEST';
const PID_1 = 'CHECKPOINT-TEST-001';
const PID_2 = 'CHECKPOINT-TEST-002';
const TSV_PATH = `tmp/image-pollution-manual-queue-${new Date().toISOString().slice(0, 10)}-test.tsv`;

interface SeedResult {
  pid: string;
  styleId: string;
  frontUrl: string;
  pollutedUrl: string;
  pollutedColumn: 'BackImage' | 'DirectSideImage';
  pollutionClass: 'content_mismatch' | 'shape_drift';
}

async function makeTestPng(label: string, r: number, g: number, b: number): Promise<Buffer> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <rect width="400" height="400" fill="rgb(${r},${g},${b})"/>
      <text x="200" y="190" font-family="sans-serif" font-size="32" font-weight="bold"
            fill="white" text-anchor="middle">CHECKPOINT-TEST</text>
      <text x="200" y="240" font-family="sans-serif" font-size="22"
            fill="white" text-anchor="middle">${label}</text>
      <text x="200" y="290" font-family="sans-serif" font-size="14"
            fill="white" text-anchor="middle">disposable — safe to trash</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function readBrHeaders(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
): Promise<{ headers: string[]; columnIndex: Record<string, number> }> {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!1:1`,
  });
  const headers = (resp.data.values?.[0] ?? []) as string[];
  if (headers.length === 0) {
    throw new Error(`Could not read header row from '${SHEET_NAME}'`);
  }
  const columnIndex: Record<string, number> = {};
  headers.forEach((h, i) => {
    columnIndex[h] = i;
  });
  return { headers, columnIndex };
}

function requireColumns(columnIndex: Record<string, number>, required: string[]): void {
  const missing = required.filter((c) => columnIndex[c] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Bestsellers-Ready is missing required columns for the checkpoint: ${missing.join(', ')}.\n` +
        `Available columns: ${Object.keys(columnIndex).join(', ')}`,
    );
  }
}

function buildBrRow(
  width: number,
  columnIndex: Record<string, number>,
  values: Record<string, string>,
): string[] {
  const row = new Array<string>(width).fill('');
  for (const [col, val] of Object.entries(values)) {
    const idx = columnIndex[col];
    if (idx !== undefined) row[idx] = val;
  }
  return row;
}

function writeTsv(seeded: SeedResult[]): void {
  const dir = dirname(TSV_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    'pid\tpollution_class\taffected_columns\tcurrent_drive_urls\tfront_image_screenshot_link\tsuggested_action',
  ];
  for (const s of seeded) {
    lines.push(
      [
        s.pid,
        s.pollutionClass,
        s.pollutedColumn,
        s.pollutedUrl,
        s.frontUrl,
        s.pollutionClass === 'content_mismatch'
          ? 'replace BackImage with operator-picked URL'
          : 'delete DirectSideImage and leave blank for next push regen',
      ].join('\t'),
    );
  }
  writeFileSync(TSV_PATH, lines.join('\n') + '\n', 'utf8');
}

async function main(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('Missing GOOGLE_SPREADSHEET_ID');
    process.exit(1);
  }

  console.log('[seed] reading BR headers…');
  const sheets = createSheetsClient();
  const drive = createDriveClient();
  const { headers, columnIndex } = await readBrHeaders(sheets, spreadsheetId);
  requireColumns(columnIndex, ['productId', 'FrontImage', 'BackImage', 'DirectSideImage']);
  console.log(`[seed] BR has ${headers.length} columns. Required columns present.`);

  console.log('[seed] generating 4 throwaway PNGs (in-memory)…');
  const [frontA, frontB, pollutedBack, pollutedSide] = await Promise.all([
    makeTestPng('FRONT — TEST-001', 30, 120, 200),
    makeTestPng('FRONT — TEST-002', 30, 180, 100),
    makeTestPng('WRONG BackImage', 200, 50, 50),
    makeTestPng('WRONG DirectSideImage', 150, 80, 200),
  ]);

  console.log(`[seed] uploading 4 files to Drive under supplier="${SUPPLIER_PREFIX}"…`);
  const [frontUrl1, frontUrl2, backUrl, sideUrl] = await Promise.all([
    uploadToDrive(drive, frontA, `${PID_1}_FrontImage.png`, SUPPLIER_PREFIX, PID_1),
    uploadToDrive(drive, frontB, `${PID_2}_FrontImage.png`, SUPPLIER_PREFIX, PID_2),
    uploadToDrive(drive, pollutedBack, `${PID_1}_BackImage.png`, SUPPLIER_PREFIX, PID_1),
    uploadToDrive(drive, pollutedSide, `${PID_2}_DirectSideImage.png`, SUPPLIER_PREFIX, PID_2),
  ]);

  console.log('[seed] appending 2 throwaway rows to Bestsellers-Ready…');
  const row1 = buildBrRow(headers.length, columnIndex, {
    productId: PID_1,
    FrontImage: frontUrl1,
    BackImage: backUrl,
  });
  const row2 = buildBrRow(headers.length, columnIndex, {
    productId: PID_2,
    FrontImage: frontUrl2,
    DirectSideImage: sideUrl,
  });
  await appendRows(sheets, spreadsheetId, SHEET_NAME, [row1, row2]);

  const seeded: SeedResult[] = [
    {
      pid: PID_1,
      styleId: PID_1,
      frontUrl: frontUrl1,
      pollutedUrl: backUrl,
      pollutedColumn: 'BackImage',
      pollutionClass: 'content_mismatch',
    },
    {
      pid: PID_2,
      styleId: PID_2,
      frontUrl: frontUrl2,
      pollutedUrl: sideUrl,
      pollutedColumn: 'DirectSideImage',
      pollutionClass: 'shape_drift',
    },
  ];

  writeTsv(seeded);

  console.log('');
  console.log('===== SEED COMPLETE =====');
  console.log('');
  console.log(`Queue TSV: ${TSV_PATH}`);
  console.log('');
  console.log('Drive files created (all under CHECKPOINT-TEST/):');
  for (const s of seeded) {
    console.log(`  ${s.pid}`);
    console.log(`    FrontImage  fileId=${extractFileId(s.frontUrl)} url=${s.frontUrl}`);
    console.log(`    ${s.pollutedColumn.padEnd(11)} fileId=${extractFileId(s.pollutedUrl)} url=${s.pollutedUrl}`);
  }
  console.log('');
  console.log('Next step — run the manual CLI:');
  console.log('');
  console.log(`  NODE_OPTIONS=--use-system-ca npx tsx scripts/fix-image-pollution-manual.ts --queue-file ${TSV_PATH}`);
  console.log('');
  console.log('After the 8-step checkpoint, run:');
  console.log('  NODE_OPTIONS=--use-system-ca npx tsx scripts/cleanup-checkpoint-test-data.ts');
  console.log('');
}

main().catch((err) => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
