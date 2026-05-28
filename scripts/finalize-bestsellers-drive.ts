/**
 * Finalize Drive imagery for every pid in Complete-Bestsellers:
 *   1. Read sheet → {pid, supplierCode, brand, productName, hasSide}
 *   2. List the pid's Drive folder
 *   3. Parse each filename → {color, role, isModel} (five legacy patterns supported)
 *   4. Standardize (Phase 11), PNG-encode, mirror sides where needed, rename
 *      to the canonical template:  Brand-pid-Color-Role.png
 *   5. Upload new name, then trash the original file (compare-IDs guard).
 *
 * Side-flip rules (per Has Side value, after normalization):
 *   left | left' | Left           → existing Side/DirectSide → LeftSide;
 *                                    mirror once → RightSide
 *   right | Right                  → existing Side/DirectSide → RightSide;
 *                                    mirror once → LeftSide
 *   both | Both                    → 0 sides: nothing
 *                                   1 side : assume LeftSide + mirror → RightSide
 *                                   2+ sides: log as ambiguous (manual)
 *   no need | No need | no nned    → side files (if any) are left alone + logged
 *   Y | y | N | DISCO | "" | other → pid logged to skip list, untouched
 *
 * Filename template:    {Brand}-{pid}-{Color}-{Role}.png
 *   - Brand and Color : Title_Case_With_Underscores (e.g. American_Apparel, Blue_Dusk)
 *   - pid             : exact case from Complete-Bestsellers
 *   - Role            : Front | Back | LeftSide | RightSide
 *                       ModelFront | ModelBack | ModelSide
 *                       Side (only on NO_NEED pids that nonetheless have a side file)
 *
 * Junk left untouched (logged):
 *   - generic model-front.png / model-back.png / model-side.png (no color)
 *   - PDFs, *-interior.png, anything without a recognizable role token
 *
 * Outputs (tmp/):
 *   finalize-drive-plan-<ts>.tsv
 *   finalize-drive-skipped-pids-<ts>.tsv
 *   finalize-drive-collisions-<ts>.tsv
 *   finalize-drive-leave-alone-<ts>.tsv
 *   finalize-drive-errors-<ts>.tsv
 *
 * Run:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/finalize-bestsellers-drive.ts            # dry-run
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/finalize-bestsellers-drive.ts --apply
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/finalize-bestsellers-drive.ts --pid 110C
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/finalize-bestsellers-drive.ts --limit 5
 */
import 'dotenv/config';
import { google, drive_v3 } from 'googleapis';
import sharp from 'sharp';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { createSheetsClient } from '../src/sheets/client.js';
import {
  createDriveClient,
  uploadToDrive,
  downloadFromDrive,
  trashDriveFile,
} from '../src/sheets/drive.js';
import { standardizeImage } from '../src/shopify/image-standardizer.js';
import { logger } from '../src/lib/logger.js';
import type { CategoryGroup } from '../src/shopify/types.js';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!;
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';
const TMP_DIR = 'tmp';

// ────────────────────────────────────────────────────────────────────────────
// Has Side normalization
// ────────────────────────────────────────────────────────────────────────────
type SideTag = 'LEFT' | 'RIGHT' | 'BOTH' | 'NO_NEED' | 'SKIP';

function normalizeHasSide(raw: string): SideTag {
  const v = raw.trim().toLowerCase().replace(/['"]/g, '');
  if (v === 'left' || v === 'lef' /* defensive */) return 'LEFT';
  if (v === 'right') return 'RIGHT';
  if (v === 'both') return 'BOTH';
  if (v === 'no need' || v === 'no nned' || v === 'noneed') return 'NO_NEED';
  return 'SKIP';
}

// ────────────────────────────────────────────────────────────────────────────
// Filename parser — handles all 5 patterns observed in the wild + pre-existing
// {pid}_{color}_left_side_flipped.png / right_side_flipped.png from a prior
// flip pass. Those files are PROMOTED as the canonical source for that side
// (no re-flip needed).
// ────────────────────────────────────────────────────────────────────────────
type RoleRaw =
  | 'Front'
  | 'Back'
  | 'Side'
  | 'DirectSide'
  | 'LeftSideExplicit'   // pre-existing _left_side_flipped.png
  | 'RightSideExplicit'; // pre-existing _right_side_flipped.png

type RoleCanonical =
  | 'Front'
  | 'Back'
  | 'LeftSide'
  | 'RightSide'
  | 'Side'
  | 'ModelFront'
  | 'ModelBack'
  | 'ModelSide';

interface ParsedFile {
  rawName: string;
  fileId: string;
  mimeType: string;
  color: string;        // Title_Case_With_Underscores
  roleRaw: RoleRaw;
  isModel: boolean;
}

function titleCaseToken(t: string): string {
  if (!t) return t;
  if (/^\d+$/.test(t)) return t; // numeric stays numeric
  return t[0].toUpperCase() + t.slice(1).toLowerCase();
}

function tokenize(base: string): string[] {
  return base.split(/[-_]/).map((t) => t.trim()).filter(Boolean);
}

// Quality / size / format markers that should be stripped from the trailing
// end before role identification.
const QUALITY_TOKENS = new Set([
  'high', 'std', 'raw',
  'hr', 'hires', 'hirez', 'hi-res',
  'lowres', 'low-res', 'lr',
  '2000x', 'new',
]);

// Positional qualifiers that aren't roles or colors — strip when encountered
// adjacent to a role token. E.g. "inner-back" / "outer-front".
const POSITIONAL_QUALIFIERS = new Set(['inner', 'outer']);

// Compound role tokens (single token, no underscore) that surface in
// ai_*_DirectSideImage.png style filenames. Maps trailing token → role + model.
const COMPOUND_ROLE: Record<string, { role: RoleRaw; isModel: boolean }> = {
  'frontimage': { role: 'Front', isModel: false },
  'directfrontimage': { role: 'Front', isModel: false },
  'backimage': { role: 'Back', isModel: false },
  'directbackimage': { role: 'Back', isModel: false },
  'directsideimage': { role: 'DirectSide', isModel: false },
  'sideimage': { role: 'Side', isModel: false },
  'directleftsideimage': { role: 'LeftSideExplicit', isModel: false },
  'directrightsideimage': { role: 'RightSideExplicit', isModel: false },
  'modelfrontimage': { role: 'Front', isModel: true },
  'modelbackimage': { role: 'Back', isModel: true },
  'modelsideimage': { role: 'Side', isModel: true },
  // Single-word role aliases observed in the wild:
  'fullfront': { role: 'Front', isModel: false },
  'profile': { role: 'Side', isModel: false }, // cap profile shots
  'rightside': { role: 'RightSideExplicit', isModel: false },
  'leftside': { role: 'LeftSideExplicit', isModel: false },
  // Bare `right` / `left` as the trailing role token (user-shortened):
  'right': { role: 'RightSideExplicit', isModel: false },
  'left': { role: 'LeftSideExplicit', isModel: false },
  // Concatenated role+ext where the dash before ".webp" was forgotten:
  'frontwebp': { role: 'Front', isModel: false },
  'backwebp': { role: 'Back', isModel: false },
  'sidewebp': { role: 'Side', isModel: false },
};

// Shopify-style UUIDs appear as 5 dash-separated hex chunks inserted before
// the resolution suffix:
//   L00550-Heliconia-back_0290cfc2-03a7-4398-81ca-355f7d1cf5bf_2000x.webp
// After tokenizing on _ and -, those 5 chunks appear as 5 trailing hex-only
// tokens (8-4-4-4-12 chars). Strip them.
function looksLikeHex(s: string): boolean {
  return /^[0-9a-f]+$/i.test(s);
}
function looksLikeUuidChunk(s: string, len: number): boolean {
  return s.length === len && looksLikeHex(s);
}

function parseFilename(
  name: string,
  pid: string,
  brand: string,
): ParsedFile | { kind: 'junk' | 'unrecognized'; rawName: string } {
  const extMatch = name.match(/\.(png|jpe?g|webp|gif)$/i);
  if (!extMatch) return { kind: 'junk', rawName: name };

  const base = name.slice(0, -extMatch[0].length);
  const tokens = tokenize(base);
  if (tokens.length === 0) return { kind: 'junk', rawName: name };

  // generic model-front / model-back / model-side (no color, no pid)
  if (tokens.length <= 2 && tokens[0].toLowerCase() === 'model') {
    return { kind: 'junk', rawName: name };
  }

  const lc = tokens.map((t) => t.toLowerCase());

  // Strip leading `ai_` provenance prefix (operator-generated AI fills)
  let i = 0;
  if (lc[0] === 'ai') i = 1;

  // Strip brand prefix if it matches sheet brand (multi-token aware)
  const brandTokens = brand
    ? brand.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
    : [];
  if (brandTokens.length > 0 && lc.length > brandTokens.length + i) {
    const head = lc.slice(i, i + brandTokens.length).join('_');
    if (head === brandTokens.join('_')) i += brandTokens.length;
  }

  // Strip pid token (case-insensitive). Accept exact match OR a numeric suffix
  // of the pid — handles filenames like `785-Front-Gray-LowRes` when pid=L00785.
  const pidLc = pid.toLowerCase();
  if (i < tokens.length) {
    const tok = lc[i];
    if (tok === pidLc) {
      i++;
    } else if (/^\d+$/.test(tok) && pidLc.endsWith(tok) && tok.length >= 3) {
      i++;
    }
  }

  // Strip trailing quality / model / "flipped" / UUID-chunk markers
  let j = tokens.length;
  let isModel = false;
  let isFlipped = false;
  while (j > i) {
    const t = lc[j - 1];
    if (t === 'model') { isModel = true; j--; continue; }
    if (t === 'flipped') { isFlipped = true; j--; continue; }
    if (QUALITY_TOKENS.has(t)) { j--; continue; }
    // Detect a 5-chunk Shopify UUID (8-4-4-4-12): peel 5 trailing tokens at once
    if (
      j - i >= 5 &&
      looksLikeUuidChunk(lc[j - 1], 12) &&
      looksLikeUuidChunk(lc[j - 2], 4) &&
      looksLikeUuidChunk(lc[j - 3], 4) &&
      looksLikeUuidChunk(lc[j - 4], 4) &&
      looksLikeUuidChunk(lc[j - 5], 8)
    ) { j -= 5; continue; }
    break;
  }
  if (j <= i) return { kind: 'unrecognized', rawName: name };

  // Try to identify the role. Two layouts seen in the wild:
  //   - trailing  : `..._Color_Role(_quality).ext`   (most common)
  //   - leading   : `..._Role_Color(_quality).ext`   (L00785 / L00900 family)
  let role: RoleRaw | null = null;
  let trailingConsumed = 1; // how many trailing tokens the role uses
  let leadingConsumed = 0;  // how many LEADING tokens (post-pid) the role uses

  // Trailing-role attempt
  if (j - i >= 2 && lc[j - 1] === 'side' && (lc[j - 2] === 'left' || lc[j - 2] === 'right')) {
    role = lc[j - 2] === 'left' ? 'LeftSideExplicit' : 'RightSideExplicit';
    trailingConsumed = 2;
  } else {
    const roleTok = lc[j - 1];
    if (roleTok === 'front') role = 'Front';
    else if (roleTok === 'back') role = 'Back';
    else if (roleTok === 'side') role = 'Side';
    else if (roleTok === 'directside') role = 'DirectSide';
    else if (COMPOUND_ROLE[roleTok]) {
      const cr = COMPOUND_ROLE[roleTok];
      role = cr.role;
      if (cr.isModel) isModel = true;
    }
  }

  // Leading-role fallback (`pid_Role_Color_quality`) when trailing failed
  if (!role && j - i >= 2) {
    const leadTok = lc[i];
    if (leadTok === 'front') { role = 'Front'; leadingConsumed = 1; trailingConsumed = 0; }
    else if (leadTok === 'back') { role = 'Back'; leadingConsumed = 1; trailingConsumed = 0; }
    else if (leadTok === 'side') { role = 'Side'; leadingConsumed = 1; trailingConsumed = 0; }
    else if (leadTok === 'directside') { role = 'DirectSide'; leadingConsumed = 1; trailingConsumed = 0; }
    else if (COMPOUND_ROLE[leadTok]) {
      const cr = COMPOUND_ROLE[leadTok];
      role = cr.role;
      if (cr.isModel) isModel = true;
      leadingConsumed = 1;
      trailingConsumed = 0;
    }
  }

  if (!role) return { kind: 'unrecognized', rawName: name };

  // If we saw "flipped" alone with a non-explicit role (e.g. just "side_flipped"
  // with no left/right qualifier), the source-side is ambiguous → unrecognized
  // so we don't accidentally consume it.
  if (isFlipped && role !== 'LeftSideExplicit' && role !== 'RightSideExplicit') {
    return { kind: 'unrecognized', rawName: name };
  }

  // Color = tokens[i+leadingConsumed ... j-trailingConsumed]; strip positional qualifiers
  const colorTokensRaw = tokens.slice(i + leadingConsumed, j - trailingConsumed);
  const colorTokens = colorTokensRaw.filter(
    (t) => !POSITIONAL_QUALIFIERS.has(t.toLowerCase()),
  );
  if (colorTokens.length === 0) return { kind: 'unrecognized', rawName: name };
  const color = colorTokens.map(titleCaseToken).join('_');

  return {
    rawName: name,
    fileId: '',
    mimeType: '',
    color,
    roleRaw: role,
    isModel,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Canonical filename builder
// ────────────────────────────────────────────────────────────────────────────
function brandSegment(brand: string): string {
  return brand.split(/\s+/).filter(Boolean).map(titleCaseToken).join('_');
}

function canonicalName(brand: string, pid: string, color: string, role: RoleCanonical): string {
  const segs = [brandSegment(brand), pid, color, role].filter((s) => s.length > 0);
  return `${segs.join('-')}.png`;
}

// ────────────────────────────────────────────────────────────────────────────
// Side-action planner per color
// ────────────────────────────────────────────────────────────────────────────
interface ColorPlanItem {
  src: ParsedFile;
  targetRole: RoleCanonical;
  flip: boolean;
}

interface ColorPlanResult {
  items: ColorPlanItem[];
  note?: string;
}

function planForColor(files: ParsedFile[], side: SideTag): ColorPlanResult {
  const items: ColorPlanItem[] = [];
  const notes: string[] = [];

  // Split by role / model
  const fronts = files.filter((f) => f.roleRaw === 'Front' && !f.isModel);
  const backs = files.filter((f) => f.roleRaw === 'Back' && !f.isModel);
  const directSides = files.filter((f) => f.roleRaw === 'DirectSide' && !f.isModel);
  const plainSides = files.filter((f) => f.roleRaw === 'Side' && !f.isModel);
  const explicitLefts = files.filter((f) => f.roleRaw === 'LeftSideExplicit' && !f.isModel);
  const explicitRights = files.filter((f) => f.roleRaw === 'RightSideExplicit' && !f.isModel);
  const modelFronts = files.filter((f) => f.roleRaw === 'Front' && f.isModel);
  const modelBacks = files.filter((f) => f.roleRaw === 'Back' && f.isModel);
  const modelSides = files.filter(
    (f) => (f.roleRaw === 'Side' || f.roleRaw === 'DirectSide') && f.isModel,
  );

  // Front + Back: just rename, no flip
  for (const f of fronts) items.push({ src: f, targetRole: 'Front', flip: false });
  for (const f of backs) items.push({ src: f, targetRole: 'Back', flip: false });
  for (const f of modelFronts) items.push({ src: f, targetRole: 'ModelFront', flip: false });
  for (const f of modelBacks) items.push({ src: f, targetRole: 'ModelBack', flip: false });
  for (const f of modelSides) items.push({ src: f, targetRole: 'ModelSide', flip: false });

  // Side anchor: DirectSide wins over plain Side
  const sideAnchor = directSides[0] ?? plainSides[0];
  const allNonModelSides = [...directSides, ...plainSides];

  if (allNonModelSides.length > 1 && side !== 'BOTH') {
    notes.push(
      `multiple-non-model-sides:${allNonModelSides.length} (DirectSide wins; others left alone)`,
    );
  }

  // Rule: explicit `*_left_side_flipped.png` / `*_right_side_flipped.png` always
  // win the LeftSide/RightSide slot they name. The anchor (DirectSide / plain
  // Side) only fills slots no explicit file already claims, with one flip allowed
  // to mirror the anchor into the opposite slot.
  const noSidesAtAll = !sideAnchor && !explicitLefts[0] && !explicitRights[0];

  switch (side) {
    case 'LEFT':
    case 'RIGHT': {
      if (noSidesAtAll) {
        notes.push(`${side.toLowerCase()}-tagged-but-no-side-file`);
        break;
      }
      // LeftSide
      if (explicitLefts[0]) {
        items.push({ src: explicitLefts[0], targetRole: 'LeftSide', flip: false });
      } else if (sideAnchor && side === 'LEFT') {
        // Anchor is the (sheet-asserted) left side
        items.push({ src: sideAnchor, targetRole: 'LeftSide', flip: false });
      } else if (sideAnchor && side === 'RIGHT') {
        // Anchor is the (sheet-asserted) right side; flip it to make LeftSide
        items.push({ src: sideAnchor, targetRole: 'LeftSide', flip: true });
      } else if (explicitRights[0]) {
        // No anchor, only explicit right — flip it to create LeftSide
        items.push({ src: explicitRights[0], targetRole: 'LeftSide', flip: true });
      }
      // RightSide
      if (explicitRights[0]) {
        items.push({ src: explicitRights[0], targetRole: 'RightSide', flip: false });
      } else if (sideAnchor && side === 'RIGHT') {
        items.push({ src: sideAnchor, targetRole: 'RightSide', flip: false });
      } else if (sideAnchor && side === 'LEFT') {
        items.push({ src: sideAnchor, targetRole: 'RightSide', flip: true });
      } else if (explicitLefts[0]) {
        items.push({ src: explicitLefts[0], targetRole: 'RightSide', flip: true });
      }
      break;
    }
    case 'BOTH': {
      if (noSidesAtAll) {
        notes.push('both-tagged-but-no-side-file');
        break;
      }
      // LeftSide: explicit_left wins, else anchor (no flip — assume it's left)
      if (explicitLefts[0]) {
        items.push({ src: explicitLefts[0], targetRole: 'LeftSide', flip: false });
      } else if (sideAnchor) {
        items.push({ src: sideAnchor, targetRole: 'LeftSide', flip: false });
        if (!explicitRights[0]) notes.push('both-with-only-one-side-assumed-left');
      } else if (explicitRights[0]) {
        items.push({ src: explicitRights[0], targetRole: 'LeftSide', flip: true });
      }
      // RightSide
      if (explicitRights[0]) {
        items.push({ src: explicitRights[0], targetRole: 'RightSide', flip: false });
      } else if (sideAnchor && !explicitLefts[0]) {
        // Anchor already used for LeftSide above → flip to fill RightSide
        items.push({ src: sideAnchor, targetRole: 'RightSide', flip: true });
      } else if (sideAnchor && explicitLefts[0]) {
        // Anchor wasn't consumed by LeftSide → use it as RightSide (assume it's right)
        items.push({ src: sideAnchor, targetRole: 'RightSide', flip: false });
      } else if (explicitLefts[0]) {
        // Only explicit_left exists; flip to make right
        items.push({ src: explicitLefts[0], targetRole: 'RightSide', flip: true });
      }
      if (allNonModelSides.length >= 2 && !explicitLefts[0] && !explicitRights[0]) {
        notes.push(`both-with-${allNonModelSides.length}-side-files-ambiguous`);
      }
      break;
    }
    case 'NO_NEED': {
      // Per operator: rename existing side file(s) to plain `Side` role; no flip.
      if (sideAnchor) {
        items.push({ src: sideAnchor, targetRole: 'Side', flip: false });
      }
      // explicit left/right_side_flipped on a NO_NEED pid: leave alone (operator can review)
      break;
    }
  }

  return { items, note: notes.length > 0 ? notes.join('; ') : undefined };
}

// ────────────────────────────────────────────────────────────────────────────
// Drive helpers
// ────────────────────────────────────────────────────────────────────────────
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
  const all: { id: string; name: string; mimeType: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) {
      if (f.id && f.name) all.push({ id: f.id, name: f.name, mimeType: f.mimeType ?? '' });
    }
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return all;
}

// ────────────────────────────────────────────────────────────────────────────
// Category inference (for the standardizer)
// ────────────────────────────────────────────────────────────────────────────
function inferCategory(productName: string): CategoryGroup {
  const lc = productName.toLowerCase();
  if (/hoodie|pullover|hood/.test(lc)) return 'hoodies';
  if (/polo/.test(lc)) return 'polos';
  if (/crewneck|sweatshirt|sweater/.test(lc)) return 'crewnecks';
  if (/jacket|coat|softshell/.test(lc)) return 'jackets';
  return 'tops';
}

// ────────────────────────────────────────────────────────────────────────────
// Sheet reader
// ────────────────────────────────────────────────────────────────────────────
interface PidRow {
  supplierCode: string;
  pid: string;
  brand: string;
  productName: string;
  hasSide: string;
  sideTag: SideTag;
}

async function readSheet(): Promise<PidRow[]> {
  const sheets = createSheetsClient();
  const api = google.sheets({ version: 'v4', auth: (sheets as any).context._options.auth });
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Complete-Bestsellers',
  });
  const rows = resp.data.values ?? [];
  if (rows.length < 2) return [];
  const out: PidRow[] = [];
  for (const r of rows.slice(1)) {
    const pid = (r[1] ?? '').toString().trim();
    if (!pid) continue;
    const hasSide = (r[7] ?? '').toString();
    out.push({
      supplierCode: (r[0] ?? '').toString().trim() || 'SSCANADA',
      pid,
      brand: (r[2] ?? '').toString().trim(),
      productName: (r[3] ?? '').toString().trim(),
      hasSide,
      sideTag: normalizeHasSide(hasSide),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
interface PlanRow {
  pid: string;
  supplier: string;
  brand: string;
  color: string;
  oldName: string;
  newName: string;
  action: 'rename' | 'flip+rename' | 'collision-skip' | 'duplicate-non-anchor';
  flip: boolean;
  fileId: string;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      pid: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const apply: boolean = !!args.apply;
  const onlyPid = (args.pid as string | undefined)?.trim();
  const limit = args.limit ? parseInt(args.limit as string, 10) : undefined;

  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const planPath = `${TMP_DIR}/finalize-drive-plan-${ts}.tsv`;
  const skipPath = `${TMP_DIR}/finalize-drive-skipped-pids-${ts}.tsv`;
  const collisionPath = `${TMP_DIR}/finalize-drive-collisions-${ts}.tsv`;
  const leavePath = `${TMP_DIR}/finalize-drive-leave-alone-${ts}.tsv`;
  const errPath = `${TMP_DIR}/finalize-drive-errors-${ts}.tsv`;
  writeFileSync(planPath, 'pid\tsupplier\tbrand\tcolor\told_name\tnew_name\taction\tflip\tfile_id\n');
  writeFileSync(skipPath, 'pid\tsupplier\tbrand\traw_has_side\treason\n');
  writeFileSync(collisionPath, 'pid\tcolor\tproposed_name\texisting_file_id\told_file_id\n');
  writeFileSync(leavePath, 'pid\told_name\tmime\treason\n');
  writeFileSync(errPath, 'pid\toldName\terror\n');

  const allPids = await readSheet();
  console.log(`[finalize] sheet rows: ${allPids.length}`);

  // Skip pids — log
  let processedPids: PidRow[] = [];
  for (const row of allPids) {
    if (row.sideTag === 'SKIP') {
      appendFileSync(
        skipPath,
        `${row.pid}\t${row.supplierCode}\t${row.brand}\t${JSON.stringify(row.hasSide)}\thas-side-unrecognized\n`,
      );
    } else {
      processedPids.push(row);
    }
  }
  if (onlyPid) processedPids = processedPids.filter((p) => p.pid === onlyPid);
  if (limit) processedPids = processedPids.slice(0, limit);

  console.log(`[finalize] pids to process: ${processedPids.length} (apply=${apply})`);

  const drive = createDriveClient();
  const rootCache = new Map<string, string | null>(); // supplierCode → folderId

  // Checkpoint: persist completed pids so we can resume after a crash without
  // redoing successful work. Only pids that finished cleanly (no per-pid throw)
  // are recorded. Re-running with --apply will skip these.
  const checkpointPath = `${TMP_DIR}/finalize-drive-checkpoint.txt`;
  const completedPids = new Set<string>();
  if (existsSync(checkpointPath)) {
    const raw = readFileSync(checkpointPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const p = line.trim();
      if (p) completedPids.add(p);
    }
    console.log(`[finalize] checkpoint: ${completedPids.size} pids already completed (will skip in --apply)`);
  }

  let pidsTouched = 0;
  let pidsFolderMissing = 0;
  let pidsSkippedByCheckpoint = 0;
  let plansCount = 0;
  let collisionsCount = 0;
  let leaveAloneCount = 0;
  let appliedCount = 0;
  let errorCount = 0;

  for (let pidIdx = 0; pidIdx < processedPids.length; pidIdx++) {
    const row = processedPids[pidIdx];
    const label = `${pidIdx + 1}/${processedPids.length} ${row.pid}`;

    if (apply && completedPids.has(row.pid)) {
      pidsSkippedByCheckpoint++;
      continue;
    }

    try {
    // Resolve supplier folder
    let supplierFolderId = rootCache.get(row.supplierCode);
    if (supplierFolderId === undefined) {
      supplierFolderId = await findFolder(drive, ROOT_FOLDER_ID, row.supplierCode);
      rootCache.set(row.supplierCode, supplierFolderId);
    }
    if (!supplierFolderId) {
      console.log(`  ${label}: supplier folder ${row.supplierCode} not found`);
      pidsFolderMissing++;
      continue;
    }

    const pidFolderId = await findFolder(drive, supplierFolderId, row.pid);
    if (!pidFolderId) {
      console.log(`  ${label}: folder not found`);
      pidsFolderMissing++;
      continue;
    }

    pidsTouched++;
    let files;
    try {
      files = await listFolderFiles(drive, pidFolderId);
    } catch (err) {
      console.log(`  ${label}: list error ${(err as Error).message}`);
      appendFileSync(errPath, `${row.pid}\t-\tlist:${(err as Error).message}\n`);
      errorCount++;
      continue;
    }

    // Parse & group
    const parsed: ParsedFile[] = [];
    for (const f of files) {
      const p = parseFilename(f.name, row.pid, row.brand);
      if ('kind' in p) {
        appendFileSync(leavePath, `${row.pid}\t${f.name}\t${f.mimeType}\t${p.kind}\n`);
        leaveAloneCount++;
        continue;
      }
      p.fileId = f.id;
      p.mimeType = f.mimeType;
      parsed.push(p);
    }

    // Group by color
    const byColor = new Map<string, ParsedFile[]>();
    for (const p of parsed) {
      if (!byColor.has(p.color)) byColor.set(p.color, []);
      byColor.get(p.color)!.push(p);
    }

    // Existing target-name → fileId map (for collision detection)
    const existingNames = new Map<string, string>();
    for (const f of files) existingNames.set(f.name, f.id);

    // Per-color plan
    const planRows: PlanRow[] = [];
    const targetNames = new Map<string, string>(); // newName → src oldName (within this pid)

    for (const [color, items] of byColor) {
      const { items: planItems, note } = planForColor(items, row.sideTag);

      // Track which source files were consumed as primary or flip
      const consumedAsAnchor = new Set<string>();
      for (const it of planItems) consumedAsAnchor.add(it.src.rawName);

      // Files NOT consumed (e.g. plain Side losing to DirectSide) → leave alone
      for (const item of items) {
        if (!consumedAsAnchor.has(item.rawName)) {
          appendFileSync(
            leavePath,
            `${row.pid}\t${item.rawName}\t${item.mimeType}\tnon-anchor-duplicate${note ? ` (${note})` : ''}\n`,
          );
          leaveAloneCount++;
        }
      }

      for (const it of planItems) {
        const newName = canonicalName(row.brand, row.pid, color, it.targetRole);

        // Skip no-op: source file is ALREADY canonically named. uploadToDrive
        // would update it in-place anyway, but we'd then race with a sibling
        // legacy-named row that wants to claim the same target. Letting the
        // legacy row win means it triggers the trash of the old name.
        if (it.src.rawName === newName) continue;

        // Within-pid collision: two DIFFERENT non-canonical sources mapping to
        // the same canonical name → keep the first, log the second.
        const prevSrc = targetNames.get(newName);
        if (prevSrc && prevSrc !== it.src.rawName) {
          appendFileSync(
            collisionPath,
            `${row.pid}\t${color}\t${newName}\twithin-pid-prev:${prevSrc}\t${it.src.rawName}\n`,
          );
          collisionsCount++;
          continue;
        }
        targetNames.set(newName, it.src.rawName);

        // Folder-level: target name exists in folder under a different fileId.
        // Always allowed — uploadToDrive will UPDATE in-place; this row then
        // trashes p.fileId via newFileId-vs-p.fileId compare. Just log it so
        // we can correlate which uploads were updates vs creates.
        const collidingId = existingNames.get(newName);
        if (collidingId && collidingId !== it.src.fileId) {
          appendFileSync(
            collisionPath,
            `${row.pid}\t${color}\t${newName}\tin-folder-update:${collidingId}\t${it.src.fileId}\n`,
          );
          // intentionally no `continue` — fall through to plan and apply
        }

        planRows.push({
          pid: row.pid,
          supplier: row.supplierCode,
          brand: row.brand,
          color,
          oldName: it.src.rawName,
          newName,
          action: it.flip ? 'flip+rename' : 'rename',
          flip: it.flip,
          fileId: it.src.fileId,
        });
      }
    }

    // Write plan rows
    for (const p of planRows) {
      appendFileSync(
        planPath,
        `${p.pid}\t${p.supplier}\t${p.brand}\t${p.color}\t${p.oldName}\t${p.newName}\t${p.action}\t${p.flip}\t${p.fileId}\n`,
      );
      plansCount++;
    }

    console.log(
      `  ${label} side=${row.sideTag} files=${files.length} parsed=${parsed.length} plans=${planRows.length}`,
    );

    if (!apply) continue;

    // ── APPLY ──────────────────────────────────────────────────────────────
    const category = inferCategory(row.productName);
    // Track which source fileIds we've already trashed (don't trash twice when 1 src → 2 outputs).
    // trashDriveFile is idempotent on the Drive side, so even a race losing this set is safe.
    const trashedIds = new Set<string>();
    // In-flight standardize promise dedupe: when one src produces both LeftSide
    // and RightSide, both plan rows await the same standardize promise.
    const stdInFlight = new Map<string, Promise<Buffer>>();
    const standardizeOnce = (fileId: string): Promise<Buffer> => {
      let p = stdInFlight.get(fileId);
      if (p) return p;
      p = (async () => {
        const raw = await downloadFromDrive(drive, fileId);
        const { buffer } = await standardizeImage(raw, category);
        return buffer;
      })();
      stdInFlight.set(fileId, p);
      return p;
    };

    const APPLY_CONCURRENCY = 5;
    const processOne = async (p: typeof planRows[number]) => {
      try {
        const stdBuffer = await standardizeOnce(p.fileId);
        const outBuf = p.flip
          ? await sharp(stdBuffer).flop().png().toBuffer()
          : stdBuffer;
        const url = await uploadToDrive(drive, outBuf, p.newName, row.supplierCode, row.pid);
        const newFileId = url.split('id=')[1];
        if (newFileId && newFileId !== p.fileId && !trashedIds.has(p.fileId)) {
          trashedIds.add(p.fileId); // claim before await so a parallel sibling skips
          await trashDriveFile(drive, p.fileId);
        }
        appliedCount++;
      } catch (err) {
        appendFileSync(errPath, `${row.pid}\t${p.oldName}\t${(err as Error).message}\n`);
        errorCount++;
        logger.warn(`[finalize] ${row.pid} ${p.oldName} → ${p.newName}: ${(err as Error).message}`);
      }
    };

    // Fixed-pool concurrency: keep up to APPLY_CONCURRENCY processOne() in flight.
    let nextIdx = 0;
    const workers = Array.from({ length: APPLY_CONCURRENCY }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= planRows.length) return;
        await processOne(planRows[idx]);
      }
    });
    await Promise.all(workers);

    // Pid finished cleanly — record in checkpoint so re-runs skip it
    if (apply) {
      appendFileSync(checkpointPath, `${row.pid}\n`);
      completedPids.add(row.pid);
    }
    } catch (pidErr) {
      // Top-level per-pid failure (e.g. findFolder ENOTFOUND when network drops).
      // Don't bail the whole run — log and move on.
      appendFileSync(errPath, `${row.pid}\t-\tpid-level:${(pidErr as Error).message}\n`);
      errorCount++;
      logger.warn(`[finalize] ${label} pid-level error: ${(pidErr as Error).message}`);
    }
  }

  console.log('\n── summary ─────────────────────────────────────');
  console.log(`pids in sheet:        ${allPids.length}`);
  console.log(`pids skipped:         ${allPids.length - processedPids.length - (onlyPid || limit ? 0 : 0)}`);
  console.log(`pids processed:       ${processedPids.length}`);
  console.log(`pids skipped (ckpt):  ${pidsSkippedByCheckpoint}`);
  console.log(`pids touched:         ${pidsTouched}`);
  console.log(`pids folder missing:  ${pidsFolderMissing}`);
  console.log(`plan rows:            ${plansCount}`);
  console.log(`collisions skipped:   ${collisionsCount}`);
  console.log(`leave-alone files:    ${leaveAloneCount}`);
  console.log(`applied:              ${appliedCount}`);
  console.log(`errors:               ${errorCount}`);
  console.log('');
  console.log(`plan TSV:             ${planPath}`);
  console.log(`skipped TSV:          ${skipPath}`);
  console.log(`collisions TSV:       ${collisionPath}`);
  console.log(`leave-alone TSV:      ${leavePath}`);
  console.log(`errors TSV:           ${errPath}`);
  console.log(apply ? '\n[APPLY] writes were sent to Drive.' : '\n[DRY-RUN] no writes — re-run with --apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
