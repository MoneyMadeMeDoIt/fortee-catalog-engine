/**
 * Discovery (read-only) for the finalize-bestsellers-drive script.
 *
 * Dumps:
 *   1. Complete-Bestsellers header row + first 5 data rows + unique values
 *      seen in the column whose header matches /^has\s*side$/i.
 *   2. Drive folder contents for 3 sample pids (one CSW H08*, one SS S*,
 *      one other prefix if present), showing every filename so we can
 *      confirm the role+color parser regex.
 *
 * Run:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/discover-finalize-inputs.ts
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { createSheetsClient } from '../src/sheets/client.js';
import { createDriveClient } from '../src/sheets/drive.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

async function readCompleteBestsellers() {
  const sheets = createSheetsClient();
  const api = google.sheets({ version: 'v4', auth: (sheets as any).context._options.auth });
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Complete-Bestsellers',
  });
  const rows = resp.data.values ?? [];
  if (rows.length === 0) {
    console.log('Complete-Bestsellers is empty');
    return { pids: [] as string[], hasSideCol: -1, pidCol: -1, headers: [] as string[] };
  }
  const headers = rows[0].map((h: string) => (h ?? '').toString());
  console.log('=== Complete-Bestsellers headers ===');
  headers.forEach((h, i) => console.log(`  [${i}] ${JSON.stringify(h)}`));

  const hasSideCol = headers.findIndex((h) => /^has\s*side/i.test(h.trim()));
  const pidCol = headers.findIndex((h) => /product.?id|^pid$|^style.?id$/i.test(h.trim()));
  console.log(`\nhasSideCol = ${hasSideCol}  (header: ${JSON.stringify(headers[hasSideCol] ?? '')})`);
  console.log(`pidCol     = ${pidCol}  (header: ${JSON.stringify(headers[pidCol] ?? '')})`);

  console.log('\n=== First 5 data rows ===');
  for (const r of rows.slice(1, 6)) {
    console.log(' ', r.map((c) => JSON.stringify(c ?? '')).join(' | '));
  }

  const seen = new Map<string, number>();
  const pids: string[] = [];
  for (const r of rows.slice(1)) {
    const v = (r[hasSideCol] ?? '').toString().trim();
    seen.set(v, (seen.get(v) ?? 0) + 1);
    const pid = (r[pidCol] ?? '').toString().trim();
    if (pid) pids.push(pid);
  }
  console.log(`\n=== Unique "Has Side" values (n=${pids.length} rows) ===`);
  for (const [v, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${JSON.stringify(v).padEnd(15)} x${n}`);
  }
  return { pids, hasSideCol, pidCol, headers };
}

async function listDriveFolder(drive: ReturnType<typeof createDriveClient>, parentId: string, name: string) {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files ?? [];
}

async function listPidFolder(drive: ReturnType<typeof createDriveClient>, supplierCode: string, pid: string) {
  const supplierFolders = await listDriveFolder(drive, ROOT_FOLDER_ID, supplierCode);
  if (!supplierFolders[0]?.id) return { found: false as const };
  const pidFolders = await listDriveFolder(drive, supplierFolders[0].id, pid);
  if (!pidFolders[0]?.id) return { found: false as const };

  const filesResp = await drive.files.list({
    q: `'${pidFolders[0].id}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size)',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return { found: true as const, files: filesResp.data.files ?? [] };
}

function guessSupplier(pid: string): string {
  // CSW headwear lookup heuristic from memory + ts files.
  if (/^H08/i.test(pid)) return 'CANADASPORTSWEAR';
  if (/^L\d/i.test(pid)) return 'CANADASPORTSWEAR';
  return 'SSCANADA';
}

async function main() {
  console.log(`spreadsheet=${SPREADSHEET_ID}\nroot drive folder=${ROOT_FOLDER_ID}\n`);
  const { pids } = await readCompleteBestsellers();

  if (pids.length === 0) {
    console.log('\nNo pids found — aborting Drive discovery.');
    return;
  }

  // Hand-picked sample covering each Has Side category + supplier prefix.
  const samplePids = new Set<string>([
    '102',     // SS, left
    '110C',    // SS Flexfit cap, left
    '5000',    // SS Gildan classic, likely left or both
    'SP12FL',  // SS S&S Athletic, mixed prefix
    'H08000',  // CSW, no_need (already seen)
    '1005',    // SS, no_need
    'L7260',   // CSW L*, side category varies
  ]);
  console.log(`\n=== Drive sample pids: ${[...samplePids].join(', ')} ===`);

  const drive = createDriveClient();
  for (const pid of samplePids) {
    const supplier = guessSupplier(pid);
    console.log(`\n--- ${supplier}/${pid} ---`);
    try {
      const result = await listPidFolder(drive, supplier, pid);
      if (!result.found) {
        console.log('  (folder not found)');
        continue;
      }
      for (const f of result.files) {
        console.log(`  ${(f.name ?? '').padEnd(70)} ${f.mimeType ?? ''}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
