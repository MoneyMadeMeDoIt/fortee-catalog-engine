/**
 * Apply MOVE-TO and TRASH-ORPHAN actions from the cross-pollution
 * resolution TSV onto Google Drive.
 *
 * Reads `tmp/cross-pollution-resolution.tsv` (produced by 14-02 Task 4).
 * KEEP-WHITELIST rows are skipped — those are folder-correct and need
 * an audit allowlist entry instead (handled separately).
 *
 * For each MOVE-TO-{pid}: move the Drive file from the current parent's
 * folder (supplierCode/parentPid) to the destination pid's folder
 * (destSupplier/destPid). Uses BR (Bestsellers-Ready) for pid → supplier
 * lookup.
 *
 * For each TRASH-ORPHAN: trash the file in place.
 *
 * Default mode is dry-run. Pass --apply to mutate.
 *
 * Output log: tmp/cross-pollution-applied.log
 */
import 'dotenv/config';
import { writeFileSync, readFileSync } from 'fs';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';
const TSV_PATH = 'tmp/cross-pollution-resolution.tsv';
const LOG_PATH = 'tmp/cross-pollution-applied.log';

interface Args { apply: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false };
  for (const x of argv) if (x === '--apply') a.apply = true;
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

interface FileLite { id: string; name: string }

async function listFolderFiles(drive: drive_v3.Drive, folderId: string): Promise<FileLite[]> {
  const out: FileLite[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, parents)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) out.push({ id: f.id!, name: f.name! });
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

interface BrIndex { pidToSupplier: Map<string, string> }
async function loadBrIndex(): Promise<BrIndex> {
  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  const pidIdx = h['productId'];
  const supIdx = h['supplierCode'];
  if (pidIdx === undefined || supIdx === undefined) throw new Error('productId/supplierCode columns not found');
  const pidToSupplier = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][pidIdx] ?? '').trim();
    const sup = String(rows[i][supIdx] ?? '').trim();
    if (pid && sup && !pidToSupplier.has(pid)) pidToSupplier.set(pid, sup);
  }
  return { pidToSupplier };
}

interface TsvRow { pid: string; filename: string; action: string; reason: string }

function parseTsv(): TsvRow[] {
  const text = readFileSync(TSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  const out: TsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cols = ln.split('\t');
    if (cols.length < 4) continue;
    out.push({ pid: cols[0], filename: cols[1], action: cols[2], reason: cols[3] });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lines: string[] = [];
  const log = (msg: string): void => { logger.info(msg); lines.push(msg); };

  log(`apply-cross-pollution-resolution: mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);

  const allRows = parseTsv();
  const moveRows = allRows.filter(r => r.action.startsWith('MOVE-TO-'));
  // SIZE_CHART files are shared multi-pid assets (e.g. "L00692-L00693_SIZE_CHART_...").
  // Classifier marks them TRASH-ORPHAN because the multi-pid prefix doesn't match
  // the parent folder's pid, but trashing would lose the chart entirely. Skip.
  const isSharedAsset = (name: string): boolean => /SIZE_CHART/i.test(name);
  const trashRows = allRows.filter(r => r.action === 'TRASH-ORPHAN' && !isSharedAsset(r.filename));
  const skippedSharedRows = allRows.filter(r => r.action === 'TRASH-ORPHAN' && isSharedAsset(r.filename));
  const keepRows = allRows.filter(r => r.action.startsWith('KEEP-WHITELIST-'));
  const otherRows = allRows.filter(r => !moveRows.includes(r) && !trashRows.includes(r) && !keepRows.includes(r) && !skippedSharedRows.includes(r));

  log(`TSV totals: MOVE=${moveRows.length} TRASH=${trashRows.length} KEEP-WHITELIST=${keepRows.length} SHARED-SKIP=${skippedSharedRows.length} OTHER=${otherRows.length}`);
  if (skippedSharedRows.length > 0) {
    log(`Protecting ${skippedSharedRows.length} shared-asset rows (SIZE_CHART, multi-pid):`);
    for (const r of skippedSharedRows) log(`  ${r.pid} ${r.filename}`);
  }
  if (otherRows.length > 0) {
    log(`Skipping ${otherRows.length} non-actionable rows (e.g., MOVE-AMBIGUOUS, INVESTIGATE-BRAND):`);
    for (const r of otherRows.slice(0, 10)) log(`  ${r.pid} ${r.filename} → ${r.action}`);
  }

  const br = await loadBrIndex();
  log(`BR pids: ${br.pidToSupplier.size}`);

  const drive = getDrive();

  // Group MOVE+TRASH rows by parent pid to scan each folder once.
  const byParent = new Map<string, TsvRow[]>();
  for (const r of [...moveRows, ...trashRows]) {
    const list = byParent.get(r.pid) ?? [];
    list.push(r);
    byParent.set(r.pid, list);
  }
  log(`Parent pids with actions: ${byParent.size}`);

  let moved = 0, trashed = 0, missingFile = 0, missingFolder = 0, errs = 0;

  for (const [parentPid, rows] of [...byParent.entries()].sort()) {
    const parentSup = br.pidToSupplier.get(parentPid);
    if (!parentSup) {
      log(`  SKIP parent ${parentPid}: no supplier in BR`);
      missingFolder += rows.length;
      continue;
    }
    const parentSupFolder = await findFolder(drive, ROOT_FOLDER_ID, parentSup);
    if (!parentSupFolder) {
      log(`  SKIP parent ${parentPid}: supplier folder ${parentSup} not found`);
      missingFolder += rows.length;
      continue;
    }
    const parentFolder = await findFolder(drive, parentSupFolder, parentPid);
    if (!parentFolder) {
      log(`  SKIP parent ${parentPid}: pid folder not found under ${parentSup}/`);
      missingFolder += rows.length;
      continue;
    }

    const files = await listFolderFiles(drive, parentFolder);
    const byName = new Map<string, string>();
    for (const f of files) byName.set(f.name, f.id);

    log(`\n[${parentSup}/${parentPid}] folder=${parentFolder.slice(0, 12)}…  files=${files.length}  actions=${rows.length}`);

    for (const r of rows) {
      const fileId = byName.get(r.filename);
      if (!fileId) {
        log(`  MISS  "${r.filename}"  (already moved/trashed?)`);
        missingFile++;
        continue;
      }

      if (r.action.startsWith('MOVE-TO-')) {
        const destPid = r.action.slice('MOVE-TO-'.length);
        const destSup = br.pidToSupplier.get(destPid);
        if (!destSup) {
          log(`  ERR  "${r.filename}"  dest pid ${destPid} has no supplier in BR`);
          errs++; continue;
        }
        const destSupFolder = await findFolder(drive, ROOT_FOLDER_ID, destSup);
        if (!destSupFolder) {
          log(`  ERR  "${r.filename}"  dest supplier folder ${destSup} not found`);
          errs++; continue;
        }
        const destFolder = await findFolder(drive, destSupFolder, destPid);
        if (!destFolder) {
          log(`  ERR  "${r.filename}"  dest pid folder ${destSup}/${destPid} not found`);
          errs++; continue;
        }
        if (!args.apply) {
          log(`  MOVE  "${r.filename}"  ${parentSup}/${parentPid} → ${destSup}/${destPid}`);
          moved++;
          continue;
        }
        try {
          await drive.files.update({
            fileId,
            addParents: destFolder,
            removeParents: parentFolder,
            fields: 'id, parents',
            supportsAllDrives: true,
          });
          log(`  MOVE  ✓  "${r.filename}"  ${parentSup}/${parentPid} → ${destSup}/${destPid}  (${fileId})`);
          moved++;
        } catch (e) {
          log(`  ERR  move failed "${r.filename}": ${e instanceof Error ? e.message : e}`);
          errs++;
        }
      } else if (r.action === 'TRASH-ORPHAN') {
        if (!args.apply) {
          log(`  TRASH "${r.filename}"  (would trash in ${parentSup}/${parentPid})`);
          trashed++;
          continue;
        }
        try {
          await drive.files.update({
            fileId,
            requestBody: { trashed: true },
            supportsAllDrives: true,
          });
          log(`  TRASH ✓  "${r.filename}"  (${fileId})`);
          trashed++;
        } catch (e) {
          log(`  ERR  trash failed "${r.filename}": ${e instanceof Error ? e.message : e}`);
          errs++;
        }
      }
    }
  }

  log(`\n=== Summary ===`);
  log(`Mode:               ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  log(`Moved:              ${moved}/${moveRows.length}`);
  log(`Trashed:            ${trashed}/${trashRows.length}`);
  log(`Missing file:       ${missingFile}`);
  log(`Missing folder:     ${missingFolder}`);
  log(`Errors:             ${errs}`);
  log(`Skipped KEEP-WL:    ${keepRows.length} (allowlist-eligible — not mutated by this script)`);

  writeFileSync(LOG_PATH, lines.join('\n') + '\n');
}

await main();
