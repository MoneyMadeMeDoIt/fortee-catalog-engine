/**
 * Replace the youth product's Drive folder file CONTENTS with the adult
 * product's image content (in place — same fileId/URL preserved). Then point
 * BR rows back to the youth Drive URLs (which now hold correct content).
 *
 * Use after `remap-youth-from-adult.ts` to fully realign Drive + Sheet:
 *   - remap-youth pushed adult URLs into BR + store (fast fix; store works)
 *   - this script makes the youth Drive folder content correct AND restores
 *     BR rows to the youth Drive URLs so future re-pushes still find them.
 *
 * For each youth color (Front/Back/Side):
 *   1. Find the youth file in root/<supplier>/<youthPid>/ matching the color+view
 *   2. Find adult file from BR.<adultPid> for the same color
 *   3. Download adult content
 *   4. drive.files.update on the youth fileId with adult content (URL stays)
 *   5. Update BR.<youthPid> to point to the youth Drive URL
 *
 * Flags:
 *   --youth <pid>   --adult <pid>   --supplier <code>
 *   --alias "Kelly:Kelly Green"
 *   --dry-run                       no Drive writes, no sheet writes
 *
 * Recommended:
 *   npx tsx -r dotenv/config scripts/sync-youth-drive-from-adult.ts \
 *     --youth S5615Y --adult S05615 --supplier CANADASPORTSWEAR --dry-run
 */
import 'dotenv/config';
import { Readable } from 'stream';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

interface Args {
  youth: string;
  adult: string;
  supplier: string;
  aliases: Map<string, string>;
  dryRun: boolean;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { youth: '', adult: '', supplier: '', aliases: new Map(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--youth') a.youth = argv[++i];
    else if (x === '--adult') a.adult = argv[++i];
    else if (x === '--supplier') a.supplier = argv[++i];
    else if (x === '--alias') {
      const [from, to] = argv[++i].split(':').map(s => s.trim());
      if (from && to) a.aliases.set(from.toLowerCase(), to);
    }
    else if (x === '--dry-run') a.dryRun = true;
  }
  if (!a.youth || !a.adult || !a.supplier) throw new Error('--youth, --adult, --supplier required');
  return a;
}

function colLetter(idx: number): string {
  let r = '', n = idx;
  while (n >= 0) { r = String.fromCharCode((n % 26) + 65) + r; n = Math.floor(n / 26) - 1; }
  return r;
}

function getDrive(): drive_v3.Drive {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function findFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return r.data.files && r.data.files.length > 0 ? r.data.files[0].id! : null;
}

async function listFolderFiles(drive: drive_v3.Drive, folderId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) out.push({ id: f.id!, name: f.name! });
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

function extractDriveId(url: string): string | null {
  const m = url.match(/[?&]id=([\w-]+)/) || url.match(/\/d\/([\w-]+)/);
  return m ? m[1] : null;
}

async function downloadDriveFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data as ArrayBuffer);
}

async function updateDriveFile(drive: drive_v3.Drive, fileId: string, buffer: Buffer): Promise<void> {
  await drive.files.update({
    fileId,
    media: { mimeType: 'image/png', body: Readable.from(buffer) },
    supportsAllDrives: true,
  });
}

/** Parse one of:
 *    CSW (Pascal_Snake): "S5615Y_Black_Front_std.png", "L0550Y_Light_Blue_Side_std.png"
 *    S&S (lowercase-hyphen): "18500b-light-pink-front.png", "5000-sport-grey-back.png"
 *  → { color, view }. Skips raw/model/auxiliary files we don't sync. */
function parseYouthFilename(pid: string, name: string): { color: string; view: 'Front' | 'Back' | 'Side' } | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const lower = base.toLowerCase();
  const pidLower = pid.toLowerCase();
  // Skip model/raw/right-flipped/size-chart aux files — never targets of front/back/side sync
  if (/(_raw$|_raw_|_flipped$|_model$|_model_|_size_chart|_left_side_flipped|_right_side_flipped)/i.test(base)) return null;
  // Strip pid prefix (either "<pid>_" or "<pid>-")
  let stripped: string;
  if (lower.startsWith(`${pidLower}_`)) stripped = base.slice(pid.length + 1);
  else if (lower.startsWith(`${pidLower}-`)) stripped = base.slice(pid.length + 1);
  else stripped = base;
  // Look for view word at the END separated by `_`, `-`, or boundary
  const VIEW_RE = /[-_](front|back|side|directside|modelfront)([-_].*)?$/i;
  const m = stripped.match(VIEW_RE);
  if (!m) return null;
  const viewWord = m[1].toLowerCase();
  const view = viewWord === 'directside' ? 'Side' : viewWord === 'modelfront' ? 'Front' : (viewWord.charAt(0).toUpperCase() + viewWord.slice(1)) as 'Front' | 'Back' | 'Side';
  // Color is everything before the view delimiter
  const colorRaw = stripped.slice(0, m.index!);
  if (!colorRaw) return null;
  // Normalize: underscores AND hyphens → spaces; trim; capitalize words
  const color = colorRaw.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
  return { color, view };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`sync-youth-drive: ${JSON.stringify({ youth: args.youth, adult: args.adult, supplier: args.supplier, aliases: [...args.aliases], dryRun: args.dryRun })}`);

  const drive = getDrive();
  const sheets = createSheetsClient();

  // 1. Locate youth Drive folder
  const supplierFolderId = await findFolder(drive, ROOT_FOLDER_ID, args.supplier);
  if (!supplierFolderId) { logger.error(`Supplier folder ${args.supplier} not found under root`); return; }
  const youthFolderId = await findFolder(drive, supplierFolderId, args.youth);
  if (!youthFolderId) { logger.error(`Youth folder ${args.youth} not found under supplier`); return; }
  logger.info(`Youth folder: ${youthFolderId}`);

  // 2. List youth folder files and parse filenames
  const youthFiles = await listFolderFiles(drive, youthFolderId);
  logger.info(`Youth folder has ${youthFiles.length} files`);
  // Map: `${color.toLowerCase()}|${view}` → { id, name }
  const youthByKey = new Map<string, { id: string; name: string }>();
  for (const f of youthFiles) {
    const parsed = parseYouthFilename(args.youth, f.name);
    if (!parsed) continue;
    const k = `${parsed.color.toLowerCase()}|${parsed.view}`;
    if (!youthByKey.has(k)) youthByKey.set(k, f);
  }
  logger.info(`Parsed ${youthByKey.size} youth (color, view) pairs`);

  // 3. Read BR for adult URLs and youth row indices
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });

  const adultByColor = new Map<string, { Front?: string; Back?: string; Side?: string }>();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][h['productId']] ?? '').trim() !== args.adult) continue;
    const color = String(rows[i][h['colorName']] ?? '').trim();
    if (!color) continue;
    const k = color.toLowerCase();
    const cur = adultByColor.get(k) ?? {};
    const f = String(rows[i][h['FrontImage']] ?? '').trim();
    const b = String(rows[i][h['BackImage']] ?? '').trim();
    const s = String(rows[i][h['DirectSideImage']] ?? '').trim();
    if (f && !cur.Front) cur.Front = f;
    if (b && !cur.Back) cur.Back = b;
    if (s && !cur.Side) cur.Side = s;
    adultByColor.set(k, cur);
  }
  logger.info(`Adult ${args.adult}: ${adultByColor.size} colors with images`);

  // 4. Plan: for each youth color in BR, find adult URLs and youth fileIds
  interface Plan { rowIdx: number; youthColor: string; adultColor: string; updates: { view: 'Front' | 'Back' | 'Side'; col: string; youthFileId: string; youthFilename: string; adultUrl: string }[] }
  const VIEW_TO_COL = { Front: 'FrontImage', Back: 'BackImage', Side: 'DirectSideImage' } as const;
  const plans: Plan[] = [];
  let missingYouthFile = 0, missingAdultUrl = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][h['productId']] ?? '').trim() !== args.youth) continue;
    const youthColor = String(rows[i][h['colorName']] ?? '').trim();
    if (!youthColor) continue;
    const aliased = args.aliases.get(youthColor.toLowerCase()) ?? youthColor;
    const adult = adultByColor.get(aliased.toLowerCase());
    if (!adult) { missingAdultUrl++; continue; }
    const updates: Plan['updates'] = [];
    for (const view of ['Front', 'Back', 'Side'] as const) {
      const adultUrl = adult[view];
      if (!adultUrl) continue;
      const yf = youthByKey.get(`${youthColor.toLowerCase()}|${view}`);
      if (!yf) { missingYouthFile++; continue; }
      updates.push({ view, col: VIEW_TO_COL[view], youthFileId: yf.id, youthFilename: yf.name, adultUrl });
    }
    if (updates.length > 0) plans.push({ rowIdx: i, youthColor, adultColor: aliased, updates });
  }
  logger.info(`Plans: ${plans.length} youth rows. Missing youth files: ${missingYouthFile}. Missing adult URLs: ${missingAdultUrl}.`);

  // 5. Apply: download adult content + update youth file in place + queue BR sheet update
  const sheetUpdates: { range: string; values: string[][] }[] = [];
  let driveUpdates = 0, driveErrors = 0;
  // Cache adult downloads by url to avoid re-fetching the same content for multiple rows (sizes)
  const adultBufCache = new Map<string, Buffer>();

  // Distinct (file, adultUrl) work items — same youth file may appear once per row but we only update once
  const seenFile = new Set<string>();
  for (const p of plans) {
    for (const u of p.updates) {
      const youthUrl = `https://drive.google.com/uc?id=${u.youthFileId}`;
      // Always queue the sheet write so all variant rows for this color/view point to youth URL
      sheetUpdates.push({ range: `'${READY_TAB}'!${colLetter(h[u.col])}${p.rowIdx + 1}`, values: [[youthUrl]] });
      // De-duplicate Drive content updates per fileId
      if (seenFile.has(u.youthFileId)) continue;
      seenFile.add(u.youthFileId);

      if (args.dryRun) {
        logger.info(`  DRY ${args.youth}/${p.youthColor}/${u.view} → replace ${u.youthFilename} (id=${u.youthFileId}) with content of ${u.adultUrl}`);
        continue;
      }

      try {
        let buf = adultBufCache.get(u.adultUrl);
        if (!buf) {
          const adultId = extractDriveId(u.adultUrl);
          if (!adultId) throw new Error(`Could not extract Drive id from ${u.adultUrl}`);
          buf = await downloadDriveFile(drive, adultId);
          adultBufCache.set(u.adultUrl, buf);
        }
        await updateDriveFile(drive, u.youthFileId, buf);
        driveUpdates++;
        logger.info(`  [${args.youth}/${p.youthColor}/${u.view}] updated ${u.youthFilename}`);
      } catch (e) {
        driveErrors++;
        logger.error(`  [${args.youth}/${p.youthColor}/${u.view}] update failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  logger.info(`Drive content updates: ${args.dryRun ? '(dry)' : driveUpdates}, errors: ${driveErrors}`);
  logger.info(`Sheet updates queued: ${sheetUpdates.length}`);

  if (!args.dryRun && sheetUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: MAIN_ID,
      requestBody: { valueInputOption: 'RAW', data: sheetUpdates },
    });
    logger.info('Sheet updates applied.');
  }
}

await main();
