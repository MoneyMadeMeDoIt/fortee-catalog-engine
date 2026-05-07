/**
 * Sweep every product's Drive folder and trash orphan files (names that don't
 * start with the pid prefix). Iterates all unique (supplierCode, productId)
 * pairs from Bestsellers-Ready.
 *
 * Same canonical rule as cleanup-product-drive-folder.ts:
 *   - keep:  files starting with `<pid>_` or `<pid>.`
 *   - trash: anything else (e.g. bare "front.png", "back.png", "side.png")
 *
 * Flags:
 *   --dry-run   list what would be trashed across all folders (default)
 *   --apply     actually trash
 *   --supplier <code>   restrict to one supplier
 *   --pids a,b,c        restrict to these productIds
 *
 * Recommended:
 *   npx tsx -r dotenv/config scripts/cleanup-all-drive-orphans.ts --dry-run
 */
import 'dotenv/config';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

interface Args { dryRun: boolean; supplier: string | null; pids: string[] | null }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: true, supplier: null, pids: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--apply') a.dryRun = false;
    else if (x === '--supplier') a.supplier = argv[++i];
    else if (x === '--pids') a.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return a;
}

function getDrive(): drive_v3.Drive {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

const folderCache = new Map<string, string | null>();
async function findFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string | null> {
  const k = `${parentId}|${name.toLowerCase()}`;
  if (folderCache.has(k)) return folderCache.get(k)!;
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  const id = r.data.files && r.data.files.length > 0 ? r.data.files[0].id! : null;
  folderCache.set(k, id);
  return id;
}

async function listFolderFiles(drive: drive_v3.Drive, folderId: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const out: { id: string; name: string; mimeType: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) out.push({ id: f.id!, name: f.name!, mimeType: f.mimeType! });
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Strays we are confident about removing. Every other filename is kept. */
const STRAY_PATTERNS: RegExp[] = [
  /^front\.(png|jpg|jpeg|webp)$/i,
  /^back\.(png|jpg|jpeg|webp)$/i,
  /^side\.(png|jpg|jpeg|webp)$/i,
  /^model\.(png|jpg|jpeg|webp)$/i,
  // Bare model-view files dropped without a pid prefix — common across 250+
  // product folders. Distinct from canonical "<pid>_<color>_model_*" files.
  /^model[-_](front|back|side)\.(png|jpg|jpeg|webp)$/i,
  /^copy of /i,
  /^chatgpt image /i,
];
function isStray(_pid: string, name: string): boolean {
  return STRAY_PATTERNS.some(re => re.test(name));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`cleanup-all-drive-orphans: ${JSON.stringify({ ...args, pids: args.pids?.length })}`);

  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });

  const pairs = new Map<string, { supplier: string; pid: string }>();
  for (let i = 1; i < rows.length; i++) {
    const supplier = String(rows[i][h['supplierCode']] ?? '').trim();
    const pid = String(rows[i][h['productId']] ?? '').trim();
    if (!supplier || !pid) continue;
    if (args.supplier && supplier !== args.supplier) continue;
    if (args.pids && !args.pids.includes(pid)) continue;
    const k = `${supplier}|${pid}`;
    if (!pairs.has(k)) pairs.set(k, { supplier, pid });
  }
  logger.info(`Total (supplier, pid) folders to scan: ${pairs.size}`);

  const drive = getDrive();
  let totalCanonical = 0, totalOrphan = 0, totalTrashed = 0, totalErrs = 0;
  const orphansByPid: Record<string, string[]> = {};
  let foldersScanned = 0, foldersMissing = 0, idx = 0;

  for (const { supplier, pid } of pairs.values()) {
    idx++;
    const supplierFolderId = await findFolder(drive, ROOT_FOLDER_ID, supplier);
    if (!supplierFolderId) { foldersMissing++; continue; }
    const productFolderId = await findFolder(drive, supplierFolderId, pid);
    if (!productFolderId) { foldersMissing++; continue; }
    foldersScanned++;

    const files = await listFolderFiles(drive, productFolderId);
    let kept = 0;
    const orphans: { id: string; name: string }[] = [];
    for (const f of files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue;
      if (isStray(pid, f.name)) orphans.push({ id: f.id, name: f.name });
      else kept++;
    }
    totalCanonical += kept;
    totalOrphan += orphans.length;
    if (orphans.length > 0) {
      orphansByPid[`${supplier}/${pid}`] = orphans.map(o => o.name);
    }

    if (idx % 20 === 0) logger.info(`Progress: ${idx}/${pairs.size}  scanned=${foldersScanned} missing=${foldersMissing} orphans=${totalOrphan}`);

    if (args.dryRun) continue;

    for (const o of orphans) {
      try {
        await drive.files.update({ fileId: o.id, requestBody: { trashed: true }, supportsAllDrives: true });
        totalTrashed++;
      } catch (e) {
        totalErrs++;
        logger.error(`  [${supplier}/${pid}] failed to trash ${o.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Folders scanned:  ${foldersScanned}`);
  logger.info(`Folders missing:  ${foldersMissing}`);
  logger.info(`Canonical files:  ${totalCanonical}`);
  logger.info(`Orphan files:     ${totalOrphan}`);
  logger.info(`Trashed:          ${args.dryRun ? '(dry)' : totalTrashed}`);
  logger.info(`Errors:           ${totalErrs}`);
  if (totalOrphan > 0) {
    logger.info(`\nOrphan breakdown by pid:`);
    for (const [k, names] of Object.entries(orphansByPid).sort()) {
      logger.info(`  ${k}: ${names.length}  [${names.slice(0, 5).join(', ')}${names.length > 5 ? `, +${names.length - 5} more` : ''}]`);
    }
  }
}

await main();
