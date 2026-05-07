/**
 * List or trash orphan files in a product's Drive folder — files whose names
 * don't match the canonical "<pid>_<Color>_<View>_..." pattern.
 *
 * Examples of orphans this targets: "front.png", "back.png", "side.png",
 * stray downloads or upload accidents that don't belong to any (color, view).
 *
 * Files matching the canonical pattern are KEPT.
 * The script trashes (not permanently deletes) so the action is reversible
 * via Drive's "Restore from trash".
 *
 * Flags:
 *   --pid <id>           required, e.g. S5615Y
 *   --supplier <code>    required, e.g. CANADASPORTSWEAR
 *   --dry-run            list what would be trashed, take no action (default)
 *   --apply              actually trash the orphan files
 *
 * Recommended:
 *   npx tsx -r dotenv/config scripts/cleanup-product-drive-folder.ts \
 *     --pid S5615Y --supplier CANADASPORTSWEAR --dry-run
 */
import 'dotenv/config';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { logger } from '../src/lib/logger.js';

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

interface Args { pid: string; supplier: string; dryRun: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { pid: '', supplier: '', dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--pid') a.pid = argv[++i];
    else if (x === '--supplier') a.supplier = argv[++i];
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--apply') a.dryRun = false;
  }
  if (!a.pid || !a.supplier) throw new Error('--pid and --supplier required');
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

async function findFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return r.data.files && r.data.files.length > 0 ? r.data.files[0].id! : null;
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

/** A file is canonical if its name starts with `<pid>_` (or `<pid>.`) — any
 *  pid-prefixed image, model shot, side-pair flipped variant, or size chart
 *  belongs to the product. Files lacking the pid prefix are stray and unsafe
 *  to keep (e.g. bare "front.png", "back.png", "side.png"). */
function isCanonical(pid: string, name: string): boolean {
  const lower = name.toLowerCase();
  const prefix = pid.toLowerCase();
  return lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`cleanup-product-drive-folder: ${JSON.stringify(args)}`);

  const drive = getDrive();
  const supplierFolderId = await findFolder(drive, ROOT_FOLDER_ID, args.supplier);
  if (!supplierFolderId) { logger.error(`Supplier folder ${args.supplier} not found`); return; }
  const productFolderId = await findFolder(drive, supplierFolderId, args.pid);
  if (!productFolderId) { logger.error(`Product folder ${args.pid} not found`); return; }
  logger.info(`Folder: ${productFolderId}`);

  const files = await listFolderFiles(drive, productFolderId);
  logger.info(`Total files in folder: ${files.length}`);

  const canonical: { id: string; name: string }[] = [];
  const orphans: { id: string; name: string }[] = [];
  for (const f of files) {
    // Only look at image files (skip subfolders if any)
    if (f.mimeType === 'application/vnd.google-apps.folder') continue;
    if (isCanonical(args.pid, f.name)) canonical.push(f);
    else orphans.push(f);
  }

  logger.info(`Canonical (kept): ${canonical.length}`);
  logger.info(`Orphans (would trash): ${orphans.length}`);
  for (const o of orphans) logger.info(`  ORPHAN  ${o.name}  (id=${o.id})`);

  if (args.dryRun) {
    logger.info(`DRY-RUN — no files trashed. Add --apply to actually trash.`);
    return;
  }

  let trashed = 0, errs = 0;
  for (const o of orphans) {
    try {
      await drive.files.update({ fileId: o.id, requestBody: { trashed: true }, supportsAllDrives: true });
      trashed++;
      logger.info(`  trashed ${o.name}`);
    } catch (e) {
      errs++;
      logger.error(`  failed to trash ${o.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  logger.info(`Trashed: ${trashed}, errors: ${errs}`);
}

await main();
