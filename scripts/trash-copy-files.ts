/**
 * Trash every `copy_SS_*` review file inside the Drive folders that belong to
 * pids listed in Complete-Bestsellers.
 *
 * Background: scripts/refresh-all-ss-images.ts stages review copies named
 *   copy_SS_<pid>_<color>_<column>.png
 * alongside the canonical files. The operator has now finished review and
 * wants these review files removed.
 *
 * Strategy:
 *   1. Read Complete-Bestsellers → list of {supplier, pid}
 *   2. For each pid folder, list files matching /^copy_/i
 *   3. Trash them (soft-delete to Drive trash, reversible for 30 days)
 *
 * Run:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/trash-copy-files.ts            # dry-run
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/trash-copy-files.ts --apply
 */
import 'dotenv/config';
import { google, drive_v3 } from 'googleapis';
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient, trashDriveFile } from '../src/sheets/drive.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';
const TMP_DIR = 'tmp';

async function findFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id ?? null;
}

async function listFolderFiles(drive: drive_v3.Drive, folderId: string) {
  const all: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) {
      if (f.id && f.name) all.push({ id: f.id, name: f.name });
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return all;
}

async function main() {
  const { values: args } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
  const apply: boolean = !!args.apply;

  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = `${TMP_DIR}/trash-copy-files-${ts}.tsv`;
  writeFileSync(outPath, 'pid\tsupplier\tfile_id\tname\taction\n');

  const sheets = createSheetsClient();
  const api = google.sheets({ version: 'v4', auth: (sheets as any).context._options.auth });
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Complete-Bestsellers',
  });
  const rows = resp.data.values ?? [];
  const pids: { supplier: string; pid: string }[] = [];
  for (const r of rows.slice(1)) {
    const pid = (r[1] ?? '').toString().trim();
    if (!pid) continue;
    pids.push({
      supplier: (r[0] ?? '').toString().trim() || 'SSCANADA',
      pid,
    });
  }
  console.log(`[trash-copy] ${pids.length} pids in sheet`);

  const drive = createDriveClient();
  const supplierCache = new Map<string, string | null>();

  let touched = 0;
  let totalCopies = 0;
  let trashed = 0;
  let folderMissing = 0;

  for (let i = 0; i < pids.length; i++) {
    const { supplier, pid } = pids[i];
    let supplierId = supplierCache.get(supplier);
    if (supplierId === undefined) {
      supplierId = await findFolder(drive, ROOT_FOLDER_ID, supplier);
      supplierCache.set(supplier, supplierId);
    }
    if (!supplierId) {
      folderMissing++;
      continue;
    }
    const pidFolderId = await findFolder(drive, supplierId, pid);
    if (!pidFolderId) {
      folderMissing++;
      continue;
    }
    touched++;
    const files = await listFolderFiles(drive, pidFolderId);
    const copies = files.filter((f) => /^copy_/i.test(f.name));
    if (copies.length === 0) {
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${pids.length} (no copies)`);
      continue;
    }
    totalCopies += copies.length;
    for (const c of copies) {
      if (apply) {
        try {
          await trashDriveFile(drive, c.id);
          trashed++;
          appendFileSync(outPath, `${pid}\t${supplier}\t${c.id}\t${c.name}\ttrashed\n`);
        } catch (err) {
          appendFileSync(outPath, `${pid}\t${supplier}\t${c.id}\t${c.name}\terror:${(err as Error).message}\n`);
        }
      } else {
        appendFileSync(outPath, `${pid}\t${supplier}\t${c.id}\t${c.name}\tplan\n`);
      }
    }
    console.log(`  ${i + 1}/${pids.length} ${pid}: ${copies.length} copies${apply ? ' trashed' : ' planned'}`);
  }

  console.log('\n── summary ─────────────────────────────────────');
  console.log(`pids in sheet:        ${pids.length}`);
  console.log(`pids folder missing:  ${folderMissing}`);
  console.log(`pids touched:         ${touched}`);
  console.log(`copy files found:     ${totalCopies}`);
  console.log(`copies trashed:       ${trashed}`);
  console.log(`log TSV:              ${outPath}`);
  console.log(apply ? '\n[APPLY] writes were sent to Drive.' : '\n[DRY-RUN] no writes — re-run with --apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
