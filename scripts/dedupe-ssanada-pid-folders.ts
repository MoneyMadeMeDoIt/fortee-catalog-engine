/**
 * One-shot cleanup for duplicate `SSCANADA/<pid>/` folders created by
 * refresh-all-ss-images.ts.
 *
 * Cause: that script's Promise.all over 6 image columns called uploadToDrive
 * concurrently for the same pid. Each call did findOrCreateFolder for
 * SSCANADA/<pid>/ in parallel — none saw the others' in-flight create, so
 * each created its own copy of the folder. Result: N folders per pid in the
 * pollutee set.
 *
 * What this script does:
 *   1. Lists every direct child of the SSCANADA folder (folders only)
 *   2. Groups by name (= pid)
 *   3. For groups with >1 folder, picks the OLDEST folder as canonical
 *      (createdTime ascending) and merges everything else into it
 *   4. Moves every file under a non-canonical folder into the canonical
 *      folder via files.update with addParents/removeParents
 *   5. Trashes each now-empty duplicate folder
 *
 * Non-destructive on file CONTENT: file IDs are preserved (the BR sheet's
 * existing direct-view URLs that reference those files stay valid). Only
 * the parent linkage changes + the empty duplicate folder is trashed.
 *
 * Run: NODE_OPTIONS=--use-system-ca npx tsx scripts/dedupe-ssanada-pid-folders.ts
 *      NODE_OPTIONS=--use-system-ca npx tsx scripts/dedupe-ssanada-pid-folders.ts --dry-run
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { createDriveClient, trashDriveFile } from '../src/sheets/drive.js';
import { logger } from '../src/lib/logger.js';

const ROOT_FOLDER_ID =
  process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';
const SUPPLIER = 'SSCANADA';

interface DriveFolder {
  id: string;
  name: string;
  createdTime: string;
}

interface DriveFile {
  id: string;
  name: string;
}

async function findSupplierFolderId(
  drive: ReturnType<typeof createDriveClient>,
): Promise<string | null> {
  const q = `'${ROOT_FOLDER_ID}' in parents and name = '${SUPPLIER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id ?? null;
}

async function listAllChildFolders(
  drive: ReturnType<typeof createDriveClient>,
  parentId: string,
): Promise<DriveFolder[]> {
  const out: DriveFolder[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id,name,createdTime)',
      pageSize: 1000,
      pageToken,
      orderBy: 'createdTime asc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) {
      if (f.id && f.name) {
        out.push({ id: f.id, name: f.name, createdTime: f.createdTime ?? '' });
      }
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function listFilesInFolder(
  drive: ReturnType<typeof createDriveClient>,
  parentId: string,
): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name });
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

interface PerPidResult {
  pid: string;
  folderCount: number;
  canonicalId: string;
  duplicateIds: string[];
  filesMoved: number;
  duplicatesTrashed: number;
  errors: string[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Dedupe duplicate SSCANADA/<pid>/ folders. See file header.

Flags:
  --dry-run    Report what would happen without changing Drive
  -h, --help   Show this help
`);
    return;
  }

  const dryRun = values['dry-run'] === true;
  const drive = createDriveClient();

  console.log('[dedupe] locating SSCANADA folder...');
  const supplierId = await findSupplierFolderId(drive);
  if (!supplierId) {
    console.error(`SSCANADA folder not found under root ${ROOT_FOLDER_ID}`);
    process.exit(1);
  }
  console.log(`[dedupe] SSCANADA folder id = ${supplierId}`);

  console.log('[dedupe] listing pid subfolders under SSCANADA...');
  const folders = await listAllChildFolders(drive, supplierId);
  console.log(`[dedupe] found ${folders.length} pid subfolders total`);

  // Group by pid (name).
  const byPid = new Map<string, DriveFolder[]>();
  for (const f of folders) {
    if (!byPid.has(f.name)) byPid.set(f.name, []);
    byPid.get(f.name)!.push(f);
  }
  // Stable sort each group by createdTime (asc) — oldest is canonical.
  for (const arr of byPid.values()) {
    arr.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  }

  const dupPids = [...byPid.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`[dedupe] pids with duplicates: ${dupPids.length}`);
  console.log(`[dedupe] pids with single folder (ignored): ${byPid.size - dupPids.length}`);
  console.log(`[dedupe] dry-run: ${dryRun}`);
  console.log('');

  const results: PerPidResult[] = [];
  let totalFilesMoved = 0;
  let totalDuplicatesTrashed = 0;

  for (const [pid, folderList] of dupPids) {
    const canonical = folderList[0];
    const duplicates = folderList.slice(1);
    const result: PerPidResult = {
      pid,
      folderCount: folderList.length,
      canonicalId: canonical.id,
      duplicateIds: duplicates.map((d) => d.id),
      filesMoved: 0,
      duplicatesTrashed: 0,
      errors: [],
    };

    for (const dup of duplicates) {
      let dupFiles: DriveFile[];
      try {
        dupFiles = await listFilesInFolder(drive, dup.id);
      } catch (err) {
        result.errors.push(`list ${dup.id}: ${err}`);
        continue;
      }

      for (const f of dupFiles) {
        if (dryRun) {
          result.filesMoved++;
          continue;
        }
        try {
          await drive.files.update({
            fileId: f.id,
            addParents: canonical.id,
            removeParents: dup.id,
            fields: 'id, parents',
            supportsAllDrives: true,
          });
          result.filesMoved++;
        } catch (err) {
          result.errors.push(`move ${f.name} (${f.id}): ${err}`);
        }
      }

      if (!dryRun) {
        try {
          await trashDriveFile(drive, dup.id);
          result.duplicatesTrashed++;
        } catch (err) {
          result.errors.push(`trash dup folder ${dup.id}: ${err}`);
        }
      } else {
        result.duplicatesTrashed++;
      }
    }

    totalFilesMoved += result.filesMoved;
    totalDuplicatesTrashed += result.duplicatesTrashed;
    results.push(result);
    console.log(
      `  ${pid}: ${folderList.length} folders → canonical=${canonical.id.slice(0, 8)}… moved=${result.filesMoved} trashed=${result.duplicatesTrashed}${result.errors.length ? ` errors=${result.errors.length}` : ''}`,
    );
  }

  // Trail TSV
  if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const trailPath = `tmp/dedupe-ssanada-pid-folders-${date}.tsv`;
  const lines = [
    'pid\tfolderCount\tcanonicalId\tduplicateIds\tfilesMoved\tduplicatesTrashed\terrors',
  ];
  for (const r of results) {
    lines.push(
      [
        r.pid,
        r.folderCount,
        r.canonicalId,
        r.duplicateIds.join(','),
        r.filesMoved,
        r.duplicatesTrashed,
        r.errors.join(' | '),
      ].join('\t'),
    );
  }
  writeFileSync(trailPath, lines.join('\n') + '\n', 'utf8');

  console.log('');
  console.log('===== DEDUPE SUMMARY =====');
  console.log(`  Pids with duplicates:     ${dupPids.length}`);
  console.log(`  Files reparented:         ${totalFilesMoved}`);
  console.log(`  Duplicate folders trashed: ${totalDuplicatesTrashed}`);
  console.log(`  Trail TSV:                ${trailPath}`);
  console.log(`  Dry-run:                  ${dryRun}`);
  if (results.some((r) => r.errors.length > 0)) {
    console.log(`  Errors:                   see trail TSV`);
  }
}

main().catch((err) => {
  logger.error(`[dedupe] FAILED: ${err}`);
  process.exit(1);
});
