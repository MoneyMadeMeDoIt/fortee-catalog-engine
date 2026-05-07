/**
 * Drive deduplication: when a product folder has TWO files for the same
 * (color, view) — one canonical "_std.png" and one legacy hyphenated name —
 * trash the hyphenated one. The canonical is what the rest of the pipeline
 * standardizes to.
 *
 * Reads tmp/imagery-audit.tsv (must be fresh) and acts on every DUPE-DRIVE
 * row. For each pair of duplicate files, picks the file matching
 * /_std\.[a-z]+$/i as the keeper and trashes everything else.
 *
 * Flags:
 *   --dry-run     list what would be trashed (default)
 *   --apply       actually trash
 *   --pids a,b    restrict to these productIds
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';
const AUDIT_TSV = 'tmp/imagery-audit.tsv';

interface Args { dryRun: boolean; pids: string[] | null }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: true, pids: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--apply') a.dryRun = false;
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
async function findFolder(drive: drive_v3.Drive, parent: string, name: string): Promise<string | null> {
  const q = `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  return r.data.files?.[0]?.id ?? null;
}
async function listFolder(drive: drive_v3.Drive, folderId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) {
      if (f.mimeType !== 'application/vnd.google-apps.folder') out.push({ id: f.id!, name: f.name! });
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

function parseFilename(pid: string, name: string): { color: string; view: string } | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  if (/(_raw$|_size_chart|_left_side_flipped|_right_side_flipped|_model$|_model_)/i.test(base)) return null;
  const lower = base.toLowerCase();
  const pidLower = pid.toLowerCase();
  let stripped: string;
  if (lower.startsWith(`${pidLower}_`) || lower.startsWith(`${pidLower}-`)) stripped = base.slice(pid.length + 1);
  else return null;
  const m = stripped.match(/[-_](front|back|side|directside|left|right)([-_].*)?$/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const view = (word === 'directside' || word === 'left' || word === 'right') ? 'Side'
             : (word.charAt(0).toUpperCase() + word.slice(1));
  const colorRaw = stripped.slice(0, m.index!);
  const color = colorRaw.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return { color, view };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`dedupe-drive-duplicates: ${JSON.stringify(args)}`);

  // 1. Get list of (supplier, pid) pairs flagged with DUPE-DRIVE in audit
  const auditLines = readFileSync(AUDIT_TSV, 'utf-8').trim().split('\n').slice(1);
  const targetPids = new Set<string>();
  for (const l of auditLines) {
    const c = l.split('\t');
    if (c[2] === 'DUPE-DRIVE') targetPids.add(c[0]);
  }
  if (args.pids) {
    for (const p of [...targetPids]) if (!args.pids.includes(p)) targetPids.delete(p);
  }
  logger.info(`Target pids with DUPE-DRIVE: ${targetPids.size}`);

  // 2. Get supplier for each pid from BR
  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  const supplierByPid = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][h['productId']] ?? '').trim();
    if (!pid || supplierByPid.has(pid)) continue;
    const sup = String(rows[i][h['supplierCode']] ?? '').trim();
    if (sup) supplierByPid.set(pid, sup);
  }

  const drive = getDrive();
  let totalKept = 0, totalTrashed = 0, totalErrs = 0, foldersProcessed = 0;
  const STD_RE = /_std\.[a-z]+$/i;

  for (const pid of targetPids) {
    const supplier = supplierByPid.get(pid);
    if (!supplier) continue;
    const sup = await findFolder(drive, ROOT_FOLDER_ID, supplier);
    if (!sup) continue;
    const prod = await findFolder(drive, sup, pid);
    if (!prod) continue;

    const files = await listFolder(drive, prod);
    // Group by (color, view)
    const grouped = new Map<string, { id: string; name: string }[]>();
    for (const f of files) {
      const p = parseFilename(pid, f.name);
      if (!p) continue;
      const k = `${p.color}|${p.view}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(f);
    }
    for (const [k, items] of grouped) {
      if (items.length < 2) continue;
      const stdItems = items.filter(it => STD_RE.test(it.name));
      const nonStdItems = items.filter(it => !STD_RE.test(it.name));
      let keeper: { id: string; name: string };
      let toTrash: { id: string; name: string }[];
      if (stdItems.length >= 1) {
        keeper = stdItems[0];
        toTrash = [...stdItems.slice(1), ...nonStdItems];
      } else {
        // No _std file — keep the first, trash the rest. (This case is rare.)
        keeper = items[0];
        toTrash = items.slice(1);
      }
      totalKept++;
      for (const f of toTrash) {
        if (args.dryRun) {
          logger.info(`  DRY ${supplier}/${pid} ${k}: keep ${keeper.name}, trash ${f.name}`);
          totalTrashed++;
          continue;
        }
        try {
          await drive.files.update({ fileId: f.id, requestBody: { trashed: true }, supportsAllDrives: true });
          totalTrashed++;
        } catch (e) {
          totalErrs++;
          logger.error(`  ${supplier}/${pid} ${k}: trash ${f.name} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    foldersProcessed++;
    if (foldersProcessed % 10 === 0) logger.info(`Progress: ${foldersProcessed}/${targetPids.size} folders, kept=${totalKept} trashed=${totalTrashed}`);
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Folders processed: ${foldersProcessed}`);
  logger.info(`Files kept:        ${totalKept}`);
  logger.info(`Files trashed:     ${args.dryRun ? '(dry) ' + totalTrashed : totalTrashed}`);
  logger.info(`Errors:            ${totalErrs}`);
}

await main();
