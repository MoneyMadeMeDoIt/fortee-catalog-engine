/**
 * Pull every available image for every S&S-routable product in
 * Bestsellers-Ready, standardize it to 2000x2000 / 85% garment height, and
 * upload it to Drive as a `copy_…` file ALONGSIDE the existing image.
 *
 * NON-DESTRUCTIVE:
 *   - Never trashes existing Drive files
 *   - Never overwrites BR cells
 *   - Just produces new `copy_SS_<pid>_<color>_<column>.png` files in Drive
 *     for human review. User promotes copies by editing BR by hand.
 *
 * Per pid:
 *   1. Resolve numeric S&S styleID via /styles/?search=<pid>
 *   2. Fetch /products/?style=<id> — returns every color with every image URL
 *      (front, back, side, model-front, model-side, model-back)
 *   3. For each BR row of that pid (one per colorName), download each
 *      available S&S image, standardize via Phase 11's image-standardizer,
 *      upload to Drive under SSCANADA/<pid>/ with filename `copy_…`.
 *
 * Reuses Phase 17 infrastructure:
 *   - src/sheets/drive.ts (17-01 retry+timeout, uploadToDrive)
 *   - src/lib/image-pollution-trail.ts (per-row trail logging)
 *   - src/lib/supplier-canonical.ts routesViaSS (17-04 prefix dispatcher)
 *   - src/shopify/image-standardizer.ts (Phase 11 standardizer)
 *
 * Safety:
 *   - --dry-run skips Drive uploads (still simulates the work for preview).
 *   - Per-pid Drive uploads are concurrent (Promise.all over the 6×N_colors
 *     image cells); inter-pid is serial to keep S&S API rate-friendly.
 *   - Skips H08* headwear (supplier-canonical short-circuit).
 *   - Skips pids that don't route through S&S (L* CSW handled separately;
 *     other prefixes need their own scraper).
 *
 * Run:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/refresh-all-ss-images.ts
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/refresh-all-ss-images.ts --pid SP12FL
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/refresh-all-ss-images.ts --limit 5
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/refresh-all-ss-images.ts --dry-run
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';
import {
  createDriveClient,
  uploadToDrive,
  extractFileId,
} from '../src/sheets/drive.js';
import { standardizeImage, downloadImage } from '../src/shopify/image-standardizer.js';
import { routesViaSS } from '../src/lib/supplier-canonical.js';
import {
  appendTrailRow,
  getOrCreateTrailRunId,
} from '../src/lib/image-pollution-trail.js';
import { logger } from '../src/lib/logger.js';
import type { CategoryGroup } from '../src/shopify/types.js';

const SHEET_NAME = 'Bestsellers-Ready';
const SS_BASE = 'https://api-ca.ssactivewear.com/v2';
const SS_IMG_BASE = 'https://www.ssactivewear.com/';
const INTER_PID_DELAY_MS = 200;

const IMAGE_COLUMNS = [
  'FrontImage',
  'BackImage',
  'DirectSideImage',
  'ModelFrontImage',
  'ModelSideImage',
  'ModelBackImage',
] as const;
type ImageColumn = (typeof IMAGE_COLUMNS)[number];

// Mapping from BR header column to the S&S API field.
const SS_FIELD: Record<ImageColumn, string> = {
  FrontImage: 'colorFrontImage',
  BackImage: 'colorBackImage',
  DirectSideImage: 'colorDirectSideImage',
  ModelFrontImage: 'colorOnModelFrontImage',
  ModelSideImage: 'colorOnModelSideImage',
  ModelBackImage: 'colorOnModelBackImage',
};

interface SSColor {
  colorName: string;
  colorFrontImage: string;
  colorBackImage: string;
  colorSideImage: string;
  colorDirectSideImage: string;
  colorOnModelFrontImage: string;
  colorOnModelSideImage: string;
  colorOnModelBackImage: string;
}

interface RowRef {
  rowIndex0: number;
  colorName: string;
  current: Record<ImageColumn, string>;
}

interface CliArgs {
  pid?: string;
  limit?: number;
  dryRun: boolean;
}

function ssAuth(): string {
  const acc = process.env.SS_ACCOUNT_NUMBER;
  const key = process.env.SS_API_KEY;
  if (!acc || !key) throw new Error('Missing SS_ACCOUNT_NUMBER / SS_API_KEY');
  return `Basic ${Buffer.from(`${acc}:${key}`).toString('base64')}`;
}

function makeLargeUrl(path: string): string {
  if (!path) return '';
  return SS_IMG_BASE + path.replace('_fm', '_fl');
}

async function ssGet<T>(path: string, auth: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(SS_BASE + path, {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
    } catch (err) {
      logger.warn(`[refresh-all-ss-images] S&S fetch failed (attempt ${attempt + 1}): ${err}`);
      await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
      continue;
    }
    if (r.status === 503 || r.status === 429) {
      await new Promise((x) => setTimeout(x, 5000 * (attempt + 1)));
      continue;
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S&S API ${r.status} on ${path}`);
    return (await r.json()) as T;
  }
  return null;
}

async function resolveStyleId(pid: string, auth: string): Promise<number | null> {
  const styles = await ssGet<Array<{ styleID: number; styleName: string }>>(
    `/styles/?search=${encodeURIComponent(pid)}&fields=styleID,styleName`,
    auth,
  );
  if (!styles || styles.length === 0) return null;
  const exact = styles.find((s) => String(s.styleName ?? '').toUpperCase() === pid.toUpperCase());
  if (exact) return exact.styleID;
  if (styles.length === 1) return styles[0].styleID;
  return null;
}

async function fetchSSColors(ssId: number, auth: string): Promise<SSColor[]> {
  const fields = [
    'colorName',
    'colorFrontImage',
    'colorBackImage',
    'colorSideImage',
    'colorDirectSideImage',
    'colorOnModelFrontImage',
    'colorOnModelSideImage',
    'colorOnModelBackImage',
  ].join(',');
  const items = await ssGet<SSColor[]>(
    `/products/?style=${ssId}&fields=${fields}`,
    auth,
  );
  return items ?? [];
}

function inferCategoryGroup(baseCategory: string): CategoryGroup {
  const lc = baseCategory.toLowerCase();
  if (lc.includes('hoodie') || lc.includes('sweatshirt')) return 'hoodies';
  if (lc.includes('polo')) return 'polos';
  if (lc.includes('crewneck')) return 'crewnecks';
  if (lc.includes('jacket') || lc.includes('softshell')) return 'jackets';
  return 'tops';
}

interface ProcessResult {
  pid: string;
  colorName: string;
  column: ImageColumn;
  status: 'updated' | 'skipped_no_change' | 'skipped_no_supplier' | 'failed';
  oldUrl: string;
  newUrl: string;
  notes: string;
}

async function processCell(
  pid: string,
  colorName: string,
  column: ImageColumn,
  supplierUrl: string,
  currentBrUrl: string,
  categoryGroup: CategoryGroup,
  drive: ReturnType<typeof createDriveClient>,
  dryRun: boolean,
  runId: string,
): Promise<ProcessResult> {
  if (!supplierUrl) {
    return {
      pid,
      colorName,
      column,
      status: 'skipped_no_supplier',
      oldUrl: currentBrUrl,
      newUrl: '',
      notes: 'no supplier URL',
    };
  }

  // 1. Download from S&S
  let raw: Buffer;
  try {
    raw = await downloadImage(supplierUrl);
  } catch (err) {
    return {
      pid,
      colorName,
      column,
      status: 'failed',
      oldUrl: currentBrUrl,
      newUrl: '',
      notes: `download failed: ${err}`,
    };
  }

  // 2. Standardize
  let standardized: Buffer;
  try {
    const { buffer } = await standardizeImage(raw, categoryGroup);
    standardized = buffer;
  } catch (err) {
    return {
      pid,
      colorName,
      column,
      status: 'failed',
      oldUrl: currentBrUrl,
      newUrl: '',
      notes: `standardize failed: ${err}`,
    };
  }

  if (dryRun) {
    return {
      pid,
      colorName,
      column,
      status: 'updated',
      oldUrl: currentBrUrl,
      newUrl: '(dry-run — would upload)',
      notes: `would standardize ${supplierUrl}`,
    };
  }

  // 3. Upload to Drive — with `copy_` prefix so the new file lives ALONGSIDE
  //    the existing BR image, never overwriting or trashing it. Human reviews
  //    Drive afterwards and promotes the copy by hand.
  const filename = `copy_SS_${pid}_${colorName}_${column}.png`;
  let newUrl: string;
  try {
    newUrl = await uploadToDrive(drive, standardized, filename, 'SSCANADA', pid);
  } catch (err) {
    return {
      pid,
      colorName,
      column,
      status: 'failed',
      oldUrl: currentBrUrl,
      newUrl: '',
      notes: `Drive upload failed: ${err}`,
    };
  }
  const newFileId = extractFileId(newUrl);
  const origFileId = extractFileId(currentBrUrl);

  await appendTrailRow({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: 'DRIVE_UPLOAD',
    column_or_path: newFileId ?? newUrl,
    old_value: origFileId ?? '',
    new_value: newFileId ?? '',
    tier: 0,
    run_id: runId,
    notes: `refresh-all-ss-images COPY ${column} ${colorName}`,
  });

  // NOTE: NO Drive trash. NO BR cell update. The new `copy_…` file lives
  // alongside the original; nothing destructive happens.

  return {
    pid,
    colorName,
    column,
    status: 'updated',
    oldUrl: currentBrUrl,
    newUrl,
    notes: '',
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Refresh every S&S-routable product in Bestsellers-Ready with fresh,
standardized images from the S&S Canada API. See file header for details.

Flags:
  --pid <id>      Process only one pid
  --limit N       Process at most N pids
  --dry-run       Skip Drive uploads + Sheets writes (safe preview)
  -h, --help      Show this help
`);
    return;
  }

  const required = [
    'GOOGLE_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'SS_ACCOUNT_NUMBER',
    'SS_API_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const args: CliArgs = {
    pid: values.pid as string | undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    dryRun: values['dry-run'] === true,
  };

  const sheets = createSheetsClient();
  const drive = createDriveClient();
  const auth = ssAuth();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!;
  const runId = await getOrCreateTrailRunId();

  // 1. Read BR.
  console.log(`[refresh-all-ss-images] reading ${SHEET_NAME}...`);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'`,
  });
  const rows = (resp.data.values ?? []) as string[][];
  const headers = rows[0];
  const h: Record<string, number> = {};
  headers.forEach((x, i) => (h[x] = i));

  const pidIdx = h['productId'];
  const colorIdx = h['colorName'];
  const baseCatIdx = h['baseCategory'];
  if (pidIdx === undefined || colorIdx === undefined) {
    throw new Error('BR missing productId or colorName column');
  }
  const colIdxFor: Record<ImageColumn, number> = Object.fromEntries(
    IMAGE_COLUMNS.map((c) => [c, h[c]]),
  ) as Record<ImageColumn, number>;
  const missingCols = IMAGE_COLUMNS.filter((c) => colIdxFor[c] === undefined);
  if (missingCols.length > 0) throw new Error(`BR missing columns: ${missingCols.join(', ')}`);

  // 2. Group rows by pid.
  const pidRows = new Map<string, RowRef[]>();
  const pidBaseCategory = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const pid = (row[pidIdx] ?? '').trim();
    if (!pid) continue;
    const colorName = (row[colorIdx] ?? '').trim();
    if (!colorName) continue;
    if (!routesViaSS(pid)) continue; // skip CSW, headwear, unrouted
    const current: Record<ImageColumn, string> = {} as never;
    for (const c of IMAGE_COLUMNS) current[c] = (row[colIdxFor[c]] ?? '').trim();
    if (!pidRows.has(pid)) pidRows.set(pid, []);
    pidRows.get(pid)!.push({ rowIndex0: i, colorName, current });
    if (!pidBaseCategory.has(pid)) {
      pidBaseCategory.set(pid, baseCatIdx !== undefined ? (row[baseCatIdx] ?? '') : '');
    }
  }

  let pids = [...pidRows.keys()].sort();
  if (args.pid) pids = pids.filter((p) => p === args.pid);
  if (args.limit) pids = pids.slice(0, args.limit);

  console.log(`[refresh-all-ss-images] ${pids.length} S&S-routable pids to process`);
  console.log(`[refresh-all-ss-images] dry-run=${args.dryRun}`);

  // 3. Process each pid.
  const allResults: ProcessResult[] = [];
  let pidsProcessed = 0;
  let pidsNoMatch = 0;
  let cellsUpdated = 0;
  let cellsSkippedNoSupplier = 0;
  let cellsFailed = 0;

  for (const pid of pids) {
    pidsProcessed++;
    const refs = pidRows.get(pid)!;
    const categoryGroup = inferCategoryGroup(pidBaseCategory.get(pid) ?? '');

    // 3a. Resolve S&S style ID.
    let ssId: number | null = null;
    try {
      ssId = await resolveStyleId(pid, auth);
    } catch (err) {
      logger.warn(`[refresh-all-ss-images] resolveStyleId failed for ${pid}: ${err}`);
    }
    if (!ssId) {
      pidsNoMatch++;
      console.log(`  ${pidsProcessed}/${pids.length} ${pid}: no S&S match`);
      await new Promise((r) => setTimeout(r, INTER_PID_DELAY_MS));
      continue;
    }

    // 3b. Fetch all colors + image URLs.
    const colors = await fetchSSColors(ssId, auth);
    if (colors.length === 0) {
      console.log(`  ${pidsProcessed}/${pids.length} ${pid}: 0 colors from S&S`);
      await new Promise((r) => setTimeout(r, INTER_PID_DELAY_MS));
      continue;
    }
    const colorByName = new Map<string, SSColor>();
    for (const c of colors) {
      const key = (c.colorName ?? '').trim();
      if (key && !colorByName.has(key)) colorByName.set(key, c);
    }

    // 3c. Process each BR row for this pid.
    let pidUpdated = 0;
    let pidNoSupplier = 0;
    for (const ref of refs) {
      const ssColor = colorByName.get(ref.colorName);
      if (!ssColor) {
        for (const col of IMAGE_COLUMNS) {
          allResults.push({
            pid,
            colorName: ref.colorName,
            column: col,
            status: 'skipped_no_supplier',
            oldUrl: ref.current[col],
            newUrl: '',
            notes: 'color not in S&S response',
          });
          pidNoSupplier++;
        }
        continue;
      }
      const results = await Promise.all(
        IMAGE_COLUMNS.map(async (col) => {
          const supplierField = SS_FIELD[col] as keyof SSColor;
          const supplierUrl = makeLargeUrl((ssColor[supplierField] as string) || '');
          return processCell(
            pid,
            ref.colorName,
            col,
            supplierUrl,
            ref.current[col],
            categoryGroup,
            drive,
            args.dryRun,
            runId,
          );
        }),
      );
      for (const r of results) {
        allResults.push(r);
        if (r.status === 'updated' && r.newUrl) {
          cellsUpdated++;
          pidUpdated++;
        } else if (r.status === 'skipped_no_supplier') {
          cellsSkippedNoSupplier++;
          pidNoSupplier++;
        } else if (r.status === 'failed') {
          cellsFailed++;
        }
      }
    }
    console.log(
      `  ${pidsProcessed}/${pids.length} ${pid}: ${pidUpdated} copies uploaded, ${pidNoSupplier} no-supplier`,
    );
    await new Promise((r) => setTimeout(r, INTER_PID_DELAY_MS));
  }

  // No BR-cell updates — the new files are uploaded as `copy_…` alongside the
  // originals, so the existing BR cells still point at the unchanged originals.
  // User reviews Drive and promotes the copies by hand if desired.

  // Write summary TSV.
  if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const trailPath = `tmp/refresh-all-ss-images-${date}.tsv`;
  const lines = ['pid\tcolorName\tcolumn\tstatus\toldUrl\tnewUrl\tnotes'];
  for (const r of allResults) {
    lines.push(
      [r.pid, r.colorName, r.column, r.status, r.oldUrl, r.newUrl, r.notes]
        .map((s) => String(s).replace(/\t/g, ' ').replace(/\n/g, ' '))
        .join('\t'),
    );
  }
  writeFileSync(trailPath, lines.join('\n') + '\n', 'utf8');
  console.log(`[refresh-all-ss-images] summary TSV: ${trailPath}`);

  // 6. Console summary.
  console.log('');
  console.log('===== REFRESH-ALL-SS-IMAGES SUMMARY =====');
  console.log(`  Pids processed:           ${pidsProcessed}`);
  console.log(`  Pids with no S&S match:   ${pidsNoMatch}`);
  console.log(`  Copies uploaded (Drive):  ${cellsUpdated}`);
  console.log(`  Skipped (no supplier URL): ${cellsSkippedNoSupplier}`);
  console.log(`  Failed:                   ${cellsFailed}`);
  console.log(`  Dry-run:                  ${args.dryRun}`);
  console.log('');
  console.log('NOTE: No Drive files were trashed. No BR cells were updated.');
  console.log(`Review the new copy_* files in Drive (under SSCANADA/<pid>/),`);
  console.log(`then promote any you want by editing the BR sheet cell to point at the new fileId.`);
}

main().catch((err) => {
  console.error('[refresh-all-ss-images] FAILED:', err);
  process.exit(1);
});
