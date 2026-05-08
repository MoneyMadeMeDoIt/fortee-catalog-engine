/**
 * Comprehensive product-imagery audit. Surfaces every category of mismatch
 * across BR, Drive, and the dest store in one pass — so we can triage and
 * fix systematically instead of chasing one-offs.
 *
 * Per pid, runs these checks:
 *   STORE-DRIFT       store media count for a (color, view) ≠ expected from BR
 *   STORE-EXTRA       store has media for a (color, view) BR doesn't have
 *   STORE-MISSING     BR/Drive has a (color, view) the store doesn't
 *   MODEL-DUPLICATED  store has the same model image attached >1 times
 *   MODEL-MISSING     non-headwear product has no model media on store
 *                       (or store has model but BR doesn't)
 *   DUPE-DRIVE        Drive folder has >1 files for same (color, view)
 *   CROSS-POLLUTION   Drive folder has a file not matching this pid's prefix
 *                       (heuristic: pid prefix in filename, allow numeric-only)
 *   BAD-ALT           store media has empty/non-canonical alt text
 *   WRONG-GARMENT     [vision, optional] FrontImage shows a different garment
 *                       type than BR.baseCategory
 *
 * Output: tmp/imagery-audit.tsv (sortable by issue type) + a console summary.
 *
 * Flags:
 *   --pids a,b,c       restrict to these productIds
 *   --supplier <code>  restrict to one supplier
 *   --vision           include WRONG-GARMENT check (expensive: ~$0.005/pid)
 *   --limit N          stop after N pids
 *   --no-store         skip store fetch (Drive + BR only)
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID ?? '1xIjATpaEdqJYHRiuy0Iy6wIYUcNCXC8k';

// Known supplier-prefixed filenames that are legitimate despite not starting
// with the pid. Add per-pid entries when a supplier consistently uses a brand-
// prefix naming (e.g., Richardson cap line uses 'Richardson_168_*').
// Without this allowlist, the cross-pollution check phantom-flags every
// Richardson_-prefixed file in pid 168's folder (BR points to those URLs and
// they're correct — the audit's "filename must start with pid" invariant is
// the wrong rule for supplier-branded naming conventions).
const KNOWN_SUPPLIER_PREFIXES: Record<string, string[]> = {
  // Richardson caps
  '168': ['Richardson_168_'],
  '112': ['Richardson_112_'],
  // BELLA + CANVAS line
  '1010': ['BELLA_+_CANVAS_1010_'],
  '3001': ['BELLA_+_CANVAS_3001_'],
  '3010': ['BELLA_+_CANVAS_3010_'],
  '3480': ['BELLA_+_CANVAS_3480_'],
  '4610': ['BELLA_+_CANVAS_4610_'],
  '6003': ['BELLA_+_CANVAS_6003_'],
  '6008': ['BELLA_+_CANVAS_6008_'],
  '6110': ['BELLA_+_CANVAS_6110_'],
  '8882': ['BELLA_+_CANVAS_8882_'],
  // Next Level
  '1510': ['Next_Level_1510_'],
  '3900': ['Next_Level_3900_'],
  '3911': ['Next_Level_3911_'],
  '9002': ['Next_Level_9002_'],
  // Comfort Colors
  '1466': ['Comfort_Colors_1466_'],
  '1467': ['Comfort_Colors_1467_'],
  // Gildan
  '5200': ['Gildan_5200_'],
  // American Apparel
  '1304': ['American_Apparel_1304_'],
};

interface Args { pids: string[] | null; supplier: string | null; vision: boolean; limit: number; noStore: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { pids: null, supplier: null, vision: false, limit: Infinity, noStore: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--pids') a.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--supplier') a.supplier = argv[++i];
    else if (x === '--vision') a.vision = true;
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--no-store') a.noStore = true;
  }
  return a;
}

interface Issue {
  pid: string;
  color: string;
  check: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  driveCount: string;
  storeCount: string;
}

interface BrPidData {
  supplier: string;
  baseCategory: string;
  variants: Map<string, { Front?: string; Back?: string; Side?: string; Model?: string }>;
  modelByPid?: string;
}

const HEADWEAR_RE = /\b(beanie|toque|cap|hat|snapback|trucker|visor|headwear|headband|bandana|balaclava|bucket)\b/i;

// --- Drive helpers --------------------------------------------------------
function getDrive(): drive_v3.Drive {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}
const folderCache = new Map<string, string | null>();
async function findFolder(drive: drive_v3.Drive, parent: string, name: string): Promise<string | null> {
  const k = `${parent}|${name.toLowerCase()}`;
  if (folderCache.has(k)) return folderCache.get(k)!;
  const q = `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  const id = r.data.files?.[0]?.id ?? null;
  folderCache.set(k, id);
  return id;
}
async function listFolder(drive: drive_v3.Drive, folderId: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const out: { id: string; name: string; mimeType: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files ?? []) out.push({ id: f.id!, name: f.name!, mimeType: f.mimeType! });
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

// --- Filename parsing -----------------------------------------------------
/** Loose pid-membership check. Accepts files starting with pid, pid+lowercase,
 *  numeric-only portion (e.g. "1290-Black-Front" for pid "L01290"), or any
 *  registered supplier-brand prefix in KNOWN_SUPPLIER_PREFIXES (e.g.
 *  "Richardson_168_Black_Front_High.jpg" for pid 168). */
function fileBelongsToPid(pid: string, name: string): boolean {
  const lower = name.toLowerCase();
  const pidLower = pid.toLowerCase();
  if (lower.startsWith(`${pidLower}_`) || lower.startsWith(`${pidLower}-`) || lower.startsWith(`${pidLower}.`)) return true;
  // Numeric-only: e.g. "L01290" → "1290-..." or "01290-..."
  const numericMatch = pidLower.match(/[a-z]*(\d+)[a-z]*/);
  if (numericMatch) {
    const num = numericMatch[1];
    const numStripped = num.replace(/^0+/, '');
    if (lower.startsWith(`${num}-`) || lower.startsWith(`${num}_`) ||
        lower.startsWith(`${numStripped}-`) || lower.startsWith(`${numStripped}_`) ||
        lower.startsWith(`${numStripped} `)) return true;
  }
  // Supplier-branded prefix allowlist (e.g. Richardson_168_*). Case-insensitive.
  const allowed = KNOWN_SUPPLIER_PREFIXES[pid];
  if (allowed) {
    for (const prefix of allowed) {
      if (name.toLowerCase().startsWith(prefix.toLowerCase())) return true;
    }
  }
  return false;
}

/** Parse "<pid><sep><color words><sep><view>(<rest>)?" — returns color/view if recognizable. */
function parseImageFilename(pid: string, name: string): { color: string; view: 'Front' | 'Back' | 'Side' | 'Model' } | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  if (/(_raw$|_raw_|_size_chart|_left_side_flipped|_right_side_flipped)/i.test(base)) return null;
  const lower = base.toLowerCase();
  const pidLower = pid.toLowerCase();
  let stripped = base;
  if (lower.startsWith(`${pidLower}_`) || lower.startsWith(`${pidLower}-`)) {
    stripped = base.slice(pid.length + 1);
  } else {
    // Numeric-only stripping
    const numericMatch = pidLower.match(/[a-z]*(\d+)[a-z]*/);
    if (numericMatch) {
      const num = numericMatch[1];
      const numStripped = num.replace(/^0+/, '');
      for (const cand of [num, numStripped]) {
        if (lower.startsWith(`${cand}-`) || lower.startsWith(`${cand}_`) || lower.startsWith(`${cand} `)) {
          stripped = base.slice(cand.length + 1); break;
        }
      }
    }
  }
  const m = stripped.match(/[-_ ](front|back|side|directside|modelfront|model|profile|left|right)([-_. ].*)?$/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const view = word === 'directside' ? 'Side'
            : word === 'modelfront' || word === 'model' ? 'Model'
            : word === 'left' || word === 'right' ? 'Side'
            : word === 'profile' ? 'Side'
            : (word.charAt(0).toUpperCase() + word.slice(1)) as 'Front' | 'Back' | 'Side';
  const colorRaw = stripped.slice(0, m.index!);
  const color = colorRaw.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
  return { color, view };
}

// --- Store helpers --------------------------------------------------------
const STORE_PAGE_QUERY = `
  query($after: String) {
    products(first: 25, after: $after) {
      edges { cursor node {
        id handle title
        media(first: 250) { edges { node { ... on MediaImage { id alt image { url } } } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
interface StoreProduct { id: string; handle: string; title: string; media: { id: string; alt: string; url: string }[] }

async function fetchAllStoreProducts(client: ShopifyClient): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  let after: string | null = null;
  for (let p = 0; p < 60; p++) {
    const r = (await client.request(STORE_PAGE_QUERY, { variables: { after } })) as any;
    for (const e of r.data.products.edges) {
      const node = e.node;
      // Don't require n.image — Shopify lazily populates that field, so freshly
      // attached media may have null image even though the alt is correct.
      // Filtering on it caused phantom STORE-DRIFT for processed-but-not-yet-
      // CDN'd media. Vision checks downstream filter for url separately.
      const media = node.media.edges
        .map((x: any) => x.node)
        .filter((n: any) => n && n.id)
        .map((n: any) => ({ id: n.id, alt: (n.alt ?? '').trim(), url: n.image?.url ?? '' }));
      out.push({ id: node.id, handle: node.handle, title: node.title, media });
    }
    if (!r.data.products.pageInfo.hasNextPage) break;
    after = r.data.products.pageInfo.endCursor;
  }
  return out;
}

function pidFromHandle(handle: string, pidByLower: Map<string, string>): string | null {
  const segs = handle.split('-');
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = pidByLower.get(segs[i].toLowerCase());
    if (p) return p;
  }
  return null;
}

// --- Vision (optional) ---------------------------------------------------
let cachedOpenAI: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (cachedOpenAI) return cachedOpenAI;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  cachedOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedOpenAI;
}
function extractDriveId(url: string): string | null {
  const m = url.match(/[?&]id=([\w-]+)/) || url.match(/\/d\/([\w-]+)/);
  return m ? m[1] : null;
}
async function fetchImageBase64(drive: drive_v3.Drive, url: string): Promise<string | null> {
  const id = extractDriveId(url);
  if (!id) return null;
  try {
    const r = await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data as ArrayBuffer).toString('base64');
  } catch { return null; }
}
async function classifyGarmentType(b64: string): Promise<string | null> {
  const cli = getOpenAI();
  const r = await cli.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 30, temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'In 1-3 words, what type of apparel item is this? (e.g. "t-shirt", "polo", "hoodie", "beanie", "cap", "jacket", "vest", "tank top", "long sleeve tee", "sweatshirt", "apron"). Lowercase, no extra commentary.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
    ] }],
  });
  return (r.choices[0]?.message?.content ?? '').trim().toLowerCase() || null;
}
function categoryFamily(s: string): string {
  const x = s.toLowerCase();
  if (/\b(beanie|toque|cap|hat|snapback|trucker|visor|head)\b/.test(x)) return 'headwear';
  if (/\bapron\b/.test(x)) return 'apron';
  if (/\b(hoodie|hooded|sweatshirt|crewneck|fleece|pullover|quarter[\s-]?zip|full[\s-]?zip)\b/.test(x)) return 'hoodie';
  if (/\b(jacket|coat|parka|softshell|windbreaker|outerwear)\b/.test(x)) return 'jacket';
  if (/\bvest\b/.test(x)) return 'vest';
  if (/\btank\s*top\b/.test(x) || /\bmuscle\b/.test(x)) return 'tank';
  if (/\b(polo|button[\s-]?up|button[\s-]?down|dress shirt)\b/.test(x)) return 'polo';
  if (/\blong[\s-]?sleeve\b/.test(x)) return 'long-sleeve-tee';
  if (/\b(t[\s-]?shirt|tee)\b/.test(x)) return 'tshirt';
  if (/\b(dress|bodysuit)\b/.test(x)) return 'dress';
  return 'other';
}

// --- Main audit logic ----------------------------------------------------
async function auditPid(args: {
  pid: string;
  br: BrPidData;
  drive: drive_v3.Drive;
  storeProduct: StoreProduct | null;
  doVision: boolean;
}): Promise<Issue[]> {
  const { pid, br, drive, storeProduct, doVision } = args;
  const issues: Issue[] = [];
  const expectedFamily = categoryFamily(br.baseCategory);
  const isHeadwear = HEADWEAR_RE.test(br.baseCategory);

  // 1. Drive folder scan
  const supplierFolderId = await findFolder(drive, ROOT_FOLDER_ID, br.supplier);
  let driveFiles: { id: string; name: string }[] = [];
  if (supplierFolderId) {
    const productFolderId = await findFolder(drive, supplierFolderId, pid);
    if (productFolderId) {
      driveFiles = (await listFolder(drive, productFolderId))
        .filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
    }
  }

  // CROSS-POLLUTION
  for (const f of driveFiles) {
    if (!fileBelongsToPid(pid, f.name)) {
      issues.push({ pid, color: '', check: 'CROSS-POLLUTION', severity: 'high',
        detail: `Drive file "${f.name}" doesn't match pid prefix`,
        driveCount: '1', storeCount: '-' });
    }
  }

  // DUPE-DRIVE
  const driveByKey = new Map<string, string[]>();
  for (const f of driveFiles) {
    const parsed = parseImageFilename(pid, f.name);
    if (!parsed) continue;
    const k = `${parsed.color.toLowerCase()}|${parsed.view}`;
    if (!driveByKey.has(k)) driveByKey.set(k, []);
    driveByKey.get(k)!.push(f.name);
  }
  for (const [k, names] of driveByKey) {
    if (names.length > 1) {
      const [color, view] = k.split('|');
      issues.push({ pid, color, check: 'DUPE-DRIVE', severity: 'medium',
        detail: `${view}: ${names.length} files in Drive — ${names.slice(0, 3).join('; ')}`,
        driveCount: String(names.length), storeCount: '-' });
    }
  }

  // 2. Store-side checks (if we have a store product)
  if (storeProduct) {
    // Group store media by (color, view)
    const storeMediaByKey = new Map<string, { id: string; alt: string; url: string }[]>();
    let modelMedia: { id: string; alt: string; url: string }[] = [];
    let badAlt: { id: string; alt: string }[] = [];
    for (const m of storeProduct.media) {
      const altLower = m.alt.toLowerCase().trim();
      // BAD-ALT: empty
      if (!altLower) { badAlt.push({ id: m.id, alt: m.alt }); continue; }
      // Model media
      if (/\bmodel\b/.test(altLower)) { modelMedia.push(m); continue; }
      // Try parse "<color> (front|back|left side|right side)" — multi-word
      // view labels MUST come first in the alternation so "Black left side"
      // parses as color=Black, view=left side rather than color="Black left".
      const mm = altLower.match(/^(.*?)\s+(left side|right side|front|back|side)$/);
      if (mm) {
        const color = mm[1].trim();
        const viewRaw = mm[2];
        const view = viewRaw === 'left side' || viewRaw === 'right side' || viewRaw === 'side' ? 'Side'
                   : (viewRaw.charAt(0).toUpperCase() + viewRaw.slice(1));
        const k = `${color}|${view}|${viewRaw}`;
        if (!storeMediaByKey.has(k)) storeMediaByKey.set(k, []);
        storeMediaByKey.get(k)!.push(m);
      } else {
        badAlt.push({ id: m.id, alt: m.alt });
      }
    }
    if (badAlt.length > 0) {
      issues.push({ pid, color: '', check: 'BAD-ALT', severity: 'low',
        detail: `${badAlt.length} store media with non-canonical alt: ${badAlt.slice(0, 3).map(b => `"${b.alt || '(empty)'}"`).join(', ')}`,
        driveCount: '-', storeCount: String(badAlt.length) });
    }

    // MODEL-DUPLICATED
    if (modelMedia.length > 1) {
      // Group by URL: identical URL = same image attached multiple times
      const byUrl = new Map<string, number>();
      for (const m of modelMedia) byUrl.set(m.url, (byUrl.get(m.url) ?? 0) + 1);
      const maxDupes = Math.max(...byUrl.values());
      issues.push({ pid, color: '', check: 'MODEL-DUPLICATED', severity: 'medium',
        detail: `${modelMedia.length} model media on store, ${byUrl.size} unique URLs (max ${maxDupes} copies of same image)`,
        driveCount: '-', storeCount: String(modelMedia.length) });
    }

    // MODEL-MISSING
    const hasModelOnStore = modelMedia.length > 0;
    const hasModelInBr = !!br.modelByPid;
    if (!isHeadwear && hasModelInBr && !hasModelOnStore) {
      issues.push({ pid, color: '', check: 'MODEL-MISSING-ON-STORE', severity: 'high',
        detail: `BR has ModelFrontImage but store has no model media`,
        driveCount: '1', storeCount: '0' });
    }
    if (!hasModelInBr && hasModelOnStore) {
      issues.push({ pid, color: '', check: 'MODEL-EXTRA-ON-STORE', severity: 'medium',
        detail: `Store has ${modelMedia.length} model media but BR has no ModelFrontImage`,
        driveCount: '0', storeCount: String(modelMedia.length) });
    }

    // STORE-DRIFT / MISSING / EXTRA per (color, view)
    // Note: push-bestsellers-to-store.ts skips ANY color that lacks all 3 of
    // Front, Back, Side. So a color missing one image won't be on the store
    // at all — flagging "store has 0 / expected 1" for those would be noise.
    for (const [color, vmap] of br.variants) {
      const colorIsPushable = !!(vmap.Front && vmap.Back && vmap.Side);
      if (!colorIsPushable) continue;
      const expected = (['Front', 'Back', 'Side'] as const)
        .map(v => ({ view: v, expectCount: v === 'Side' ? 2 : 1 })); // Side expands to left+right
      for (const { view, expectCount } of expected) {
        const matchKeys = [...storeMediaByKey.keys()].filter(k => {
          const [c, v] = k.split('|');
          return c.toLowerCase() === color.toLowerCase() && v === view;
        });
        const actualCount = matchKeys.reduce((s, k) => s + storeMediaByKey.get(k)!.length, 0);
        if (actualCount !== expectCount) {
          issues.push({ pid, color, check: 'STORE-DRIFT', severity: 'medium',
            detail: `${view}: expected ${expectCount}, store has ${actualCount}`,
            driveCount: String(expectCount), storeCount: String(actualCount) });
        }
      }
    }

    // STORE-EXTRA: store color not in BR
    const brColorsLower = new Set([...br.variants.keys()].map(c => c.toLowerCase()));
    const storeColors = new Set<string>();
    for (const k of storeMediaByKey.keys()) storeColors.add(k.split('|')[0]);
    for (const sc of storeColors) {
      if (!brColorsLower.has(sc)) {
        issues.push({ pid, color: sc, check: 'STORE-EXTRA-COLOR', severity: 'medium',
          detail: `Store has media for color "${sc}" but BR has no such variant`,
          driveCount: '0', storeCount: '?' });
      }
    }
  }

  // 3. Optional WRONG-GARMENT vision check (one front per color)
  if (doVision) {
    for (const [color, vmap] of br.variants) {
      if (!vmap.Front) continue;
      const b64 = await fetchImageBase64(drive, vmap.Front);
      if (!b64) continue;
      const detected = await classifyGarmentType(b64);
      if (!detected) continue;
      const detectedFamily = categoryFamily(detected);
      if (expectedFamily !== 'other' && detectedFamily !== 'other' && detectedFamily !== expectedFamily) {
        issues.push({ pid, color, check: 'WRONG-GARMENT', severity: 'high',
          detail: `BR baseCategory="${br.baseCategory}" (${expectedFamily}) but image shows "${detected}" (${detectedFamily})`,
          driveCount: '1', storeCount: '-' });
      }
    }
  }

  return issues;
}

// --- main -----------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`audit-product-imagery: ${JSON.stringify({ ...args, pids: args.pids?.length })}`);

  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });

  // Build per-pid BR data
  const brByPid = new Map<string, BrPidData>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][h['productId']] ?? '').trim();
    if (!pid) continue;
    if (args.pids && !args.pids.includes(pid)) continue;
    const supplier = String(rows[i][h['supplierCode']] ?? '').trim();
    if (args.supplier && supplier !== args.supplier) continue;
    const baseCategory = String(rows[i][h['baseCategory']] ?? '').trim();
    if (!brByPid.has(pid)) brByPid.set(pid, { supplier, baseCategory, variants: new Map() });
    const e = brByPid.get(pid)!;
    if (supplier && !e.supplier) e.supplier = supplier;
    if (baseCategory && !e.baseCategory) e.baseCategory = baseCategory;
    const color = String(rows[i][h['colorName']] ?? '').trim();
    if (!color) continue;
    const k = color;
    const cur = e.variants.get(k) ?? {};
    const front = String(rows[i][h['FrontImage']] ?? '').trim();
    const back = String(rows[i][h['BackImage']] ?? '').trim();
    const side = String(rows[i][h['DirectSideImage']] ?? '').trim();
    const model = String(rows[i][h['ModelFrontImage']] ?? '').trim();
    if (front && !cur.Front) cur.Front = front;
    if (back && !cur.Back) cur.Back = back;
    if (side && !cur.Side) cur.Side = side;
    if (model && !cur.Model) cur.Model = model;
    if (model && !e.modelByPid) e.modelByPid = model;
    e.variants.set(k, cur);
  }

  let pidsToAudit = [...brByPid.keys()];
  if (Number.isFinite(args.limit)) pidsToAudit = pidsToAudit.slice(0, args.limit);
  logger.info(`Auditing ${pidsToAudit.length} pids`);

  // Fetch store products
  const storeByPid = new Map<string, StoreProduct>();
  if (!args.noStore) {
    const client = await createShopifyClient('DEST_SHOPIFY_');
    const allStore = await fetchAllStoreProducts(client);
    logger.info(`Fetched ${allStore.length} store products`);
    const pidByLower = new Map<string, string>();
    for (const p of brByPid.keys()) pidByLower.set(p.toLowerCase(), p);
    for (const sp of allStore) {
      const matchedPid = pidFromHandle(sp.handle, pidByLower);
      if (matchedPid && pidsToAudit.includes(matchedPid)) storeByPid.set(matchedPid, sp);
    }
    logger.info(`Matched ${storeByPid.size} store products to BR pids in scope`);
  }

  const drive = getDrive();
  const allIssues: Issue[] = [];
  let processed = 0;
  for (const pid of pidsToAudit) {
    const br = brByPid.get(pid)!;
    const sp = storeByPid.get(pid) ?? null;
    try {
      const issues = await auditPid({ pid, br, drive, storeProduct: sp, doVision: args.vision });
      allIssues.push(...issues);
    } catch (e) {
      logger.error(`[${pid}] audit error: ${e instanceof Error ? e.message : e}`);
    }
    processed++;
    if (processed % 25 === 0) logger.info(`Progress: ${processed}/${pidsToAudit.length}, issues so far: ${allIssues.length}`);
  }

  // Write TSV
  const lines = ['pid\tcolor\tcheck\tseverity\tdrive\tstore\tdetail'];
  for (const i of allIssues) lines.push([i.pid, i.color, i.check, i.severity, i.driveCount, i.storeCount, i.detail].join('\t'));
  writeFileSync('tmp/imagery-audit.tsv', lines.join('\n') + '\n');

  // Summary
  const byCheck = new Map<string, number>();
  const pidsByCheck = new Map<string, Set<string>>();
  for (const i of allIssues) {
    byCheck.set(i.check, (byCheck.get(i.check) ?? 0) + 1);
    if (!pidsByCheck.has(i.check)) pidsByCheck.set(i.check, new Set());
    pidsByCheck.get(i.check)!.add(i.pid);
  }
  logger.info(`\n=== Summary ===`);
  logger.info(`Pids audited:    ${pidsToAudit.length}`);
  logger.info(`Total issues:    ${allIssues.length}`);
  logger.info(`Affected pids:   ${new Set(allIssues.map(i => i.pid)).size}`);
  logger.info(`Issues by check:`);
  for (const [k, n] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
    logger.info(`  ${k.padEnd(28)}: ${String(n).padStart(5)} (${pidsByCheck.get(k)!.size} pids)`);
  }
  logger.info(`\nReport written to tmp/imagery-audit.tsv`);
}

await main();
