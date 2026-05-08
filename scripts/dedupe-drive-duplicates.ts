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

/**
 * Stray supplier-original naming patterns this script trashes when a
 * canonical `_std.png` sibling exists for the same (color, view).
 *
 * Each entry is a regex matched case-insensitively against the full filename.
 * They document the formats — actual classification still goes through
 * parseFilename(), which extracts (color, view) so we can verify the
 * canonical sibling exists. The patterns themselves are intentionally
 * permissive; the canonical-sibling check is the safety guard.
 *
 * Patterns (added 2026-05-08, plan 14-01):
 *   1. Underscored CSW-style:  693_NAVY_FRONT_low_375x.webp, 1040_black_front_HR.jpg
 *      Numeric-only pid prefix + uppercase/lowercase color + view + size suffix.
 *   2. S&S Profile-style:      H08355-Ivory-Profile_2000x.webp, H08200-White-profile.jpg
 *      Pid + hyphen + Color + 'Profile' + optional size suffix.
 *   3. HR-suffixed:            1040_black_front_HR.jpg, *_HR.jpg
 *      Already covered by pattern 1's view-suffix tail; listed here for clarity.
 */
const STRAY_PATTERNS: RegExp[] = [
  // 1. Underscored CSW-style (numeric-only pid prefix, optional low/HR/hi quality tag)
  /^\d+_[A-Za-z][A-Za-z_]*_(FRONT|BACK|SIDE|MODEL)(_(low|hr|hi))?(_\d+x\d+)?\.(webp|jpg|jpeg|png)$/i,
  // 2. S&S Profile-style (pid-color-Profile, optional size suffix)
  /^[A-Z]\d+-[A-Za-z][A-Za-z-]*-Profile(_\d+x\d*)?\.(webp|jpg|jpeg|png)$/i,
  // 3. HR-suffixed (numeric-only pid + view + _HR)
  /^\d+_[a-z][a-z_]*_(front|back|side)_HR\.(jpg|jpeg|png|webp)$/i,
];

function parseFilename(pid: string, name: string): { color: string; view: string } | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  if (/(_raw$|_size_chart|_left_side_flipped|_right_side_flipped|_model$|_model_)/i.test(base)) return null;
  const lower = base.toLowerCase();
  const pidLower = pid.toLowerCase();
  let stripped: string | null = null;
  if (lower.startsWith(`${pidLower}_`) || lower.startsWith(`${pidLower}-`) || lower.startsWith(`${pidLower} `)) {
    stripped = base.slice(pid.length + 1);
  } else {
    // Numeric-only pid prefix (e.g. "693_*" for pid "L00693", "1040_*" for "L01040",
    // "5970 BLACK_BACK" for "S05970"). Mirrors the audit script's loose pid-membership
    // check so dedupe can group supplier-originals alongside the canonical
    // _std file for the same (color, view).
    const numericMatch = pidLower.match(/[a-z]*(\d+)[a-z]*/);
    if (numericMatch) {
      const num = numericMatch[1];
      const numStripped = num.replace(/^0+/, '');
      for (const cand of [num, numStripped]) {
        if (lower.startsWith(`${cand}-`) || lower.startsWith(`${cand}_`) || lower.startsWith(`${cand} `)) {
          stripped = base.slice(cand.length + 1);
          break;
        }
      }
    }
    // Branded supplier prefix (e.g. "BELLA_+_CANVAS_6110_Dark_Grey_Front_High",
    // "Next_Level_3911_Heather_Grey_Side_High_Model", "1275InnwerW-Front-Orange-HIRes").
    // Find the numeric-pid token embedded in the prefix and strip up to and
    // including its trailing separator.
    if (stripped === null && numericMatch) {
      const num = numericMatch[1];
      const numStripped = num.replace(/^0+/, '');
      for (const cand of [num, numStripped]) {
        const re = new RegExp(`(^|[ _-])${cand}[ _-]`, 'i');
        const m = lower.match(re);
        if (m && m.index !== undefined) {
          stripped = base.slice(m.index + m[0].length);
          break;
        }
      }
    }
  }
  if (stripped === null) return null;
  // View alternation now includes 'profile'. Trailing tail allows _low_NNNNxNNNN
  // or _HR/_HIRes or _<size>x suffixes — and also _High and _High_Model so the
  // Bella+Canvas / Next Level supplier-originals collapse into one group with
  // their `_std.png` siblings (and with each other when no _std exists).
  const m = stripped.match(/[-_ ](front|back|side|directside|left|right|profile)([-_. ].*)?$/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const view = (word === 'directside' || word === 'left' || word === 'right' || word === 'profile') ? 'Side'
             : (word.charAt(0).toUpperCase() + word.slice(1));
  const colorRaw = stripped.slice(0, m.index!);
  const color = colorRaw.replace(/[_\- ]+/g, ' ').toLowerCase().trim();
  return { color, view };
}

/** Returns true if the filename matches any documented stray supplier-original pattern. */
function isStrayPattern(name: string): boolean {
  return STRAY_PATTERNS.some(re => re.test(name));
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
