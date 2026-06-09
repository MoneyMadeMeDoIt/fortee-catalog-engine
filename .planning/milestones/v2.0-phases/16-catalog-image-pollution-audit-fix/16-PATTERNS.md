# Phase 16: Catalog Image Pollution Audit & Fix — Pattern Map

**Mapped:** 2026-05-12
**Files analyzed:** 13 new + 1 modified (+ optional extension)
**Analogs found:** 13 / 13 (all new files have a close analog in-repo)

This file tells the planner WHICH existing file to copy patterns from for each new file in Phase 16, with concrete line-numbered excerpts. Planner consumes this in plan-writing — each plan action should reference its analog by path + line range.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/image-pollution-trail.ts` | helper-lib (append-only TSV writer) | file-I/O (write) | `src/lib/rejects-tsv.ts` | exact (same role + same flow, parameterized) |
| `src/lib/verify-same-product.ts` | helper-lib (AI Vision verifier) | request-response | `src/lib/ai-image-generator.ts` lines 129-181 (`verifyGarmentTypeMatch`) | exact (sibling verifier, identical signature) |
| `src/lib/supplier-canonical.ts` | helper-lib (pid → URL resolver) | request-response (network fetch) | composite: `scripts/fetch-ss-images-fixed.ts` (S&S half) + `scripts/scrape-csw-product.ts` (CSW half) + `scripts/audit-product-imagery.ts:51-77` (prefix allowlist) | role-match (no single existing resolver; pattern is well-established across 3 files) |
| `scripts/audit-image-pollution.ts` | CLI (detection orchestrator) | batch (read-only) | `scripts/audit-garment-types.ts` (entire file) | exact (DI seam, parseArgs, chunked --all, env validation, isDirectRun guard) |
| `scripts/fix-image-pollution.ts` | CLI (fix orchestrator) | batch (read-write) | `scripts/audit-garment-types.ts` (DI seam) + `scripts/fetch-ss-images-fixed.ts` (read-update-write flow) | composite (no single file does both, but each half is exact) |
| `scripts/fix-image-pollution-manual.ts` | CLI (interactive operator) | event-driven (readline prompt loop) | `scripts/audit-garment-types.ts` (CLI skeleton) + RESEARCH.md `## Manual CLI UX Pattern` (designed scaffold) | role-match (no precedent for interactive readline in this codebase; pattern designed in RESEARCH) |
| `tests/lib/verify-same-product.test.ts` | test (unit) | request-response (mocked) | `tests/lib/rejects-tsv.test.ts` (Vitest mocking discipline) + Phase 15 verifier test if exists | role-match |
| `tests/lib/pollution-trail.test.ts` | test (unit) | file-I/O (mocked fs) | `tests/lib/rejects-tsv.test.ts` (entire file) | exact (same role, same mocking pattern) |
| `tests/lib/supplier-canonical.test.ts` | test (unit) | request-response (mocked fetch) | `tests/lib/rejects-tsv.test.ts` (Vitest framework) | role-match |
| `tests/scripts/audit-image-pollution.test.ts` | test (unit + invariant) | batch (mocked deps) | `tests/scripts/audit-garment-types.test.ts` (entire file, especially Test 7 invariant) | exact |
| `tests/scripts/fix-image-pollution.test.ts` | test (unit) | batch (mocked deps) | `tests/scripts/audit-garment-types.test.ts` (DI mocking) | role-match (no precedent for fix-orchestrator test in repo) |
| `tests/scripts/fix-image-pollution-manual.test.ts` | test (unit, mocked readline) | event-driven (mocked) | `tests/scripts/audit-garment-types.test.ts` (DI mocking) | role-match |
| `src/sheets/drive.ts` (MODIFY) | helper-lib (Drive API wrappers) | request-response | self — append 4 helpers (`downloadFromDrive`, `trashDriveFile`, `getDriveFileMetadata`, `extractFileId`) | exact (extending existing file) |
| `src/sheets/types.ts` (DECISION) | model (typed sheet row) | n/a | self — extension decision required | decision-only (extend SheetRow OR document raw-read pattern) |

---

## Pattern Assignments

### `src/lib/image-pollution-trail.ts` (helper-lib, file-I/O)

**Analog:** `src/lib/rejects-tsv.ts` (full file, 94 lines)

**Why this analog:** Phase 16's trail is the same shape — append-only TSV, header-on-first-write, sanitize-on-write, non-throwing on FS failure. Only differences: (a) more columns per D-14 schema, (b) date-stamped filename, (c) per-D-15 explicit `fsync` after each row.

**Critical RESEARCH instruction (line 295):** "Don't refactor `rejects-tsv.ts`. Copy the pattern into the new file — rejects-tsv has 1 caller (the Phase 15 verifier) plus 1 caller (the audit script). Merging risks breaking Phase 15. Keep them separate; the pattern is small enough." Do NOT generalize `appendRejectRow`; copy the file structure.

**Imports pattern** (`src/lib/rejects-tsv.ts:25-26`):
```typescript
import { existsSync, appendFileSync, writeFileSync } from 'fs';
import { logger } from './logger.js';
```

**Phase 16 addition needed** (per RESEARCH line 612, D-15 fsync requirement):
```typescript
import { existsSync, appendFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'fs';
```

**Header + path pattern** (`src/lib/rejects-tsv.ts:28-29`):
```typescript
const TSV_PATH = 'tmp/garment-type-rejects.tsv';
const HEADER = 'pid\tview\treason\ttimestamp\trun_id\n';
```

**Phase 16 generalization** (use a date-stamped path per D-14, 11-column schema):
```typescript
const TRAIL_HEADER =
  'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\trun_id\tnotes\n';
function getTrailPath(): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `tmp/image-pollution-fix-trail-${d}.tsv`;
}
```

**Row interface pattern** (`src/lib/rejects-tsv.ts:32-39`):
```typescript
export interface RejectRow {
  pid: string;
  view: 'back' | 'side';
  reason: string;
  timestamp: string;
  run_id: string;
}
```

**Phase 16 TrailRow** (per D-14):
```typescript
export type TrailOperation =
  | 'BR_WRITE' | 'DRIVE_UPLOAD' | 'DRIVE_DELETE'
  | 'SUPPLIER_FETCH' | 'AI_REGEN'
  | 'VERIFIER_PASS' | 'VERIFIER_FAIL'
  | 'MANUAL_SKIP' | 'MANUAL_ACCEPT';

export interface TrailRow {
  timestamp_iso: string;
  pid: string;
  operation: TrailOperation;
  column_or_path: string;  // e.g., 'FrontImage' or 'drive-fileId-abc123'
  old_value: string;
  new_value: string;
  tier: 1 | 2 | 3 | 0;     // 0 for audit-side events
  run_id: string;
  notes: string;
}
```

**Sanitization pattern** (`src/lib/rejects-tsv.ts:63-65`) — copy verbatim:
```typescript
function sanitize(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ');
}
```

**Apply sanitize to** `column_or_path`, `old_value`, `new_value`, `notes` (every operator-or-LLM-controlled field). The `operation` enum is bounded so no sanitization needed there.

**Append-with-fsync pattern** (mirror `src/lib/rejects-tsv.ts:79-93`, add fsync per D-15):
```typescript
export async function appendTrailRow(row: TrailRow): Promise<void> {
  const path = getTrailPath();
  const line = [
    row.timestamp_iso,
    row.pid,
    row.operation,
    sanitize(row.column_or_path),
    sanitize(row.old_value),
    sanitize(row.new_value),
    String(row.tier),
    row.run_id,
    sanitize(row.notes),
  ].join('\t') + '\n';

  try {
    if (!existsSync(path)) {
      writeFileSync(path, TRAIL_HEADER + line);
    } else {
      appendFileSync(path, line);
    }
    // D-15 fsync: durability gate so a crash loses at most one in-flight op.
    const fd = openSync(path, 'a');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (err) {
    logger.warn(`[image-pollution-trail] Failed to write trail row: ${err}`);
    // Non-throwing — trail is durable record, but operator should not crash on disk-full.
  }
}
```

**Resume-from-trail pattern** (designed in RESEARCH lines 618-637 — NEW helper, no in-repo precedent):
```typescript
export async function loadProcessedPids(): Promise<Set<string>> {
  const path = getTrailPath();
  if (!existsSync(path)) return new Set();
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').slice(1); // drop header
  const processed = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const pid = cols[1];
    const operation = cols[2];
    // Terminal-for-this-run operations (per RESEARCH Pitfall 8):
    if (['BR_WRITE', 'MANUAL_SKIP', 'MANUAL_ACCEPT'].includes(operation)) {
      processed.add(pid);
    }
  }
  return processed;
}
```

**Run-ID memoization** (`src/lib/rejects-tsv.ts:44-56`) — copy verbatim with new internal variable name (avoid collision with `rejects-tsv` if both imported):
```typescript
let _trailRunId: string | null = null;
export function getOrCreateTrailRunId(): string {
  if (_trailRunId === null) _trailRunId = new Date().toISOString();
  return _trailRunId;
}
```

**Test analog:** `tests/lib/rejects-tsv.test.ts` — copy all 8 behaviors verbatim (first-write/subsequent-write, sanitize tabs/newlines, run_id memoization, ISO-8601 format, row order, non-throwing on FS error). Add a 9th behavior for `loadProcessedPids` (mock `readFileSync`, return Set with both BR_WRITE and MANUAL_SKIP pids).

---

### `src/lib/verify-same-product.ts` (helper-lib, request-response)

**Analog:** `src/lib/ai-image-generator.ts` lines 71-181 (`VERIFIER_SYSTEM_PROMPT`, `VerifyGarmentTypeResult`, `verifyGarmentTypeMatch`)

**Why this analog:** Sibling verifier — same OpenAI client signature, same gpt-4o-mini model, same JSON-mode response, same `detail: 'low'`, same false-accept-on-error fallback. Only the system prompt differs.

**Result type pattern** (`src/lib/ai-image-generator.ts:71-78`):
```typescript
export interface VerifyGarmentTypeResult {
  match: boolean;
  reason: string;
}
```

**Phase 16 sibling:**
```typescript
export interface VerifySameProductResult {
  match: boolean;
  reason: string;
}
```

**System prompt pattern** (`src/lib/ai-image-generator.ts:84-111`) — Phase 16 needs a DIFFERENT prompt (stricter "same specific product" vs Phase 15's "same family"). Use RESEARCH lines 429-452:
```typescript
const SAME_PRODUCT_SYSTEM_PROMPT = `You are comparing two product photos of garments on white backgrounds.
The FIRST image is a CANDIDATE (the image we're auditing).
The SECOND image is a REFERENCE (the canonical supplier photo of what the product SHOULD look like).

Decide whether both photos depict the SAME SPECIFIC PRODUCT — same garment style, same cut, same brand details (collar, hem, sleeve detail, fabric texture, logo placement if visible). They MAY differ in:
- Color (a navy hoodie and a black hoodie of the same style = SAME PRODUCT)
- Photo angle (slightly different framing = SAME PRODUCT)
- Lighting / exposure (= SAME PRODUCT)
- Model wearing it vs. flat lay (= SAME PRODUCT, but only if the garment itself matches)

They are DIFFERENT PRODUCTS if:
- The garment SHAPE differs (hoodie vs crewneck, polo vs t-shirt, etc.)
- The brand is visibly different (Adidas hoodie vs Gildan hoodie = different products even if both pullovers)
- Cut/fit family differs (oversized vs slim fit if visible)
- Decoration is intrinsic (printed logo, embroidery) and only appears on one

Respond with ONLY a JSON object on a single line:
{"match": true|false, "reason": "<short phrase, max 80 chars>"}

Examples:
- "same Bella+Canvas 6110 t-shirt, different color" → match=true
- "candidate is Gildan hoodie, reference is Adidas hoodie" → match=false
- "candidate is baby onesie, reference is adult t-shirt" → match=false
- "same crewneck sweatshirt, candidate has model wearing it" → match=true`;
```

**Function body — copy verbatim from `src/lib/ai-image-generator.ts:129-181`**, swap:
- function name → `verifySameProduct`
- argument names: `generatedBuffer` → `candidateBuffer`, `frontBuffer` → `referenceBuffer`
- system prompt → `SAME_PRODUCT_SYSTEM_PROMPT`
- user text labels: `"Reference (source front):"` → `"Candidate (BR image being audited):"` and `"Candidate (generated view):"` → `"Reference (supplier canonical):"`
- log prefix: `[ai-image-generator]` → `[verify-same-product]`

**Critical pattern to preserve** (`src/lib/ai-image-generator.ts:177-180`):
```typescript
} catch (err) {
  logger.warn(`[verify-same-product] failed: ${err}`);
  return { match: true, reason: 'verifier api error fallback' };
}
```

**The false-accept-on-error policy is mandatory per RESEARCH line 506:** "Same false-accept-on-error policy as Phase 15. Cost of a false-accept = one wrong image stays one more cycle. Cost of a false-reject = spending Tier 1 budget on something already correct."

**JSON parse with regex fallback** (`src/lib/ai-image-generator.ts:158-171`) — copy verbatim:
```typescript
let parsed: { match?: unknown; reason?: unknown };
try {
  parsed = JSON.parse(raw);
} catch {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m === null) {
    logger.warn(`[verify-same-product] parse failed (no JSON object found in: ${raw.slice(0, 100)})`);
    return { match: true, reason: 'verifier parse error fallback' };
  }
  parsed = JSON.parse(m[0]);
}
```

**Test analog:** Phase 15's verifier test (if one exists for `verifyGarmentTypeMatch`) — otherwise use `tests/lib/rejects-tsv.test.ts` for Vitest mocking patterns. Required cases:
1. Happy match path — mocked `client.chat.completions.create` returns `{match: true, reason: "..."}` → returns same
2. Mismatch path — mocked returns `{match: false, reason: "..."}` → returns same
3. JSON parse failure → returns `{match: true, reason: 'verifier parse error fallback'}` (false-accept)
4. API error → returns `{match: true, reason: 'verifier api error fallback'}`
5. Empty content → returns parse-fallback

---

### `src/lib/supplier-canonical.ts` (helper-lib, request-response)

**Analog:** composite of three existing files. No single resolver exists; the pattern is well-established across:

1. **S&S resolver pattern:** `scripts/fetch-ss-images-fixed.ts` lines 26-65 (`getAuth`, `ssGet`, `resolveStyleId`)
2. **CSW resolver pattern:** `scripts/scrape-csw-product.ts` lines 37-89 (`throttle`, `findHandle`, `fetchProductJson`)
3. **Prefix allowlist:** `scripts/audit-product-imagery.ts` lines 51-77 (`KNOWN_SUPPLIER_PREFIXES`)

**Why composite:** Phase 16 needs a single function `resolveSupplierCanonical(pid) → Promise<CanonicalResult | null>` that dispatches by prefix:
- `S*` → S&S Canada REST (reuse `resolveStyleId` + `ssGet` patterns)
- `L*` → CSW scraper (reuse `findHandle` + `fetchProductJson` patterns)
- numeric / brand prefix → consult `KNOWN_SUPPLIER_PREFIXES` (no scraper exists; return `null` per D-04)
- `H08*` → return `null` (headwear excluded per D-22)

**S&S auth pattern** (`scripts/fetch-ss-images-fixed.ts:26-31`):
```typescript
function getAuth(): string {
  const account = process.env.SS_ACCOUNT_NUMBER;
  const key = process.env.SS_API_KEY;
  if (!account || !key) throw new Error('SS_ACCOUNT_NUMBER and SS_API_KEY must be set');
  return `Basic ${Buffer.from(`${account}:${key}`).toString('base64')}`;
}
```

**S&S rate-limited fetch with 503 retry** (`scripts/fetch-ss-images-fixed.ts:20, 44-53`):
```typescript
const RATE_LIMIT_MS = 1100;
async function ssGet<T>(path: string, auth: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(SS_BASE + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (r.status === 503) { await new Promise(x => setTimeout(x, 10000)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`SS API ${r.status} on ${path}`);
    return r.json() as T;
  }
  return null;
}
```

**S&S styleID resolution** (`scripts/fetch-ss-images-fixed.ts:55-64`):
```typescript
async function resolveStyleId(pid: string, auth: string): Promise<number | null> {
  const styles = await ssGet<Array<{ styleID: number; styleName: string }>>(
    `/styles/?search=${encodeURIComponent(pid)}&fields=styleID,styleName`, auth,
  );
  if (!styles || styles.length === 0) return null;
  const exact = styles.find(s => String(s.styleName ?? '').toUpperCase() === pid.toUpperCase());
  if (exact) return exact.styleID;
  if (styles.length === 1) return styles[0].styleID;
  return null;
}
```

**S&S front-image URL builder** (`scripts/fetch-ss-images-fixed.ts:18-19, 39-42, 130`):
```typescript
const SS_IMG_BASE = 'https://www.ssactivewear.com/';
function makeLargeUrl(path: string): string {
  if (!path) return '';
  return SS_IMG_BASE + path.replace('_fm', '_fl'); // _fm thumb → _fl large
}
// Then: front: makeLargeUrl(item.colorFrontImage || '')
```

**CSW handle + product fetch pattern** (`scripts/scrape-csw-product.ts:51-89`):
```typescript
export async function findHandle(style: string): Promise<string | null> { /* search-suggest.json */ }
export async function fetchProductJson(handle: string): Promise<{ images: CSWImage[]; ... } | null> {
  const r = await get(`${BASE}/products/${handle}.json`);
  // ... returns images: CSWImage[] with .src CDN URLs
}
```

**CSW throttle pattern** (`scripts/scrape-csw-product.ts:14, 37-42`):
```typescript
const RATE_LIMIT_MS = 1000;
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}
```

**Prefix allowlist pattern** (`scripts/audit-product-imagery.ts:51-77`):
```typescript
const KNOWN_SUPPLIER_PREFIXES: Record<string, string[]> = {
  '168': ['Richardson_168_'],
  '6110': ['BELLA_+_CANVAS_6110_'],
  '8882': ['BELLA_+_CANVAS_8882_'],
  '5200': ['Gildan_5200_'],
  // ... 19 mappings total
};
```

**Phase 16 dispatcher signature** (NEW — design):
```typescript
export interface CanonicalResult {
  url: string;            // direct image URL the verifier will download
  source: 'ss' | 'csw';   // which supplier resolved it
  styleId?: number | string; // S&S styleID or CSW handle (for trail logging)
}

export async function resolveSupplierCanonical(
  pid: string,
): Promise<CanonicalResult | null> {
  // Headwear exclusion (D-22) — short-circuit BEFORE any network call
  if (/^H08/i.test(pid)) return null;

  // S&S Canada
  if (/^S/i.test(pid)) {
    // ... reuse ssGet + resolveStyleId pattern, then fetch /products/?style=ID
    // return { url: front image URL, source: 'ss', styleId: ssId }
  }

  // CSW
  if (/^L/i.test(pid)) {
    // ... reuse findHandle + fetchProductJson pattern
    // return { url: first image src, source: 'csw', styleId: handle }
  }

  // Numeric or other brand prefix — no scraper, log + return null
  if (KNOWN_SUPPLIER_PREFIXES[pid]) {
    logger.info(`[supplier-canonical] ${pid} is in allowlist but no scraper exists (Phase 16 D-12 expansion candidate)`);
    return null;
  }

  return null;
}
```

**MEMORY CALLOUT** (per user memory `feedback_strict_side_profile` + RESEARCH line 132-134): S&S `colorSideImage` is sometimes the on-model side view. Phase 16's supplier-canonical MUST trust ONLY `colorDirectSideImage` and `colorFrontImage`; never trust `colorSideImage` for the canonical comparison. See `scripts/fetch-ss-images-fixed.ts:132-138` for the lesson.

**Test analog:** `tests/lib/rejects-tsv.test.ts` (Vitest mock framework). Required cases:
1. `H08*` pid → returns `null` without any fetch
2. `S*` pid (mocked ssGet) → returns `{source: 'ss', url, styleId}`
3. `L*` pid (mocked fetch) → returns `{source: 'csw', url, styleId}`
4. Numeric pid in `KNOWN_SUPPLIER_PREFIXES` → returns `null` (logged)
5. Unknown prefix → returns `null`

---

### `scripts/audit-image-pollution.ts` (CLI, batch read-only)

**Analog:** `scripts/audit-garment-types.ts` (entire file, 307 lines)

**Why this analog:** Same role (read-only audit CLI), same project conventions (parseArgs from node:util, env validation fail-fast, DI seam, chunked --all reader, ESM `isDirectRun` guard). Phase 16 adds 3 passes instead of 1, but the script skeleton is identical.

**DI seam pattern** (`scripts/audit-garment-types.ts:34-45`):
```typescript
export interface RunGarmentTypeAuditDeps {
  args: RunGarmentTypeAuditArgs;
  sheetsClient: unknown;
  openai: OpenAI;
  readAllRowsFn: typeof readAllRows;
  readRowRangeFn: typeof readRowRange;
  downloadImageFn: typeof downloadImage;
  verifierFn: typeof verifyGarmentTypeMatch;
  appendRejectRowFn: typeof appendRejectRow;
  spreadsheetId: string;
  sheetName: string;
}
```

**Phase 16 DI seam** (per RESEARCH lines 886-910 — expand with new deps):
```typescript
export interface RunImagePollutionAuditArgs {
  all: boolean;
  pid?: string;
  dryRun: boolean;
  reAudit: boolean;
  postMortem: boolean;
  limit?: number;
  help: boolean;
}

export interface RunImagePollutionAuditDeps {
  args: RunImagePollutionAuditArgs;
  sheetsClient: unknown;
  driveClient: drive_v3.Drive;
  openai: OpenAI;
  // Raw-row reader (NOT readAllRows — Pitfall 1: SheetRow lacks Model* fields)
  readRawRowsFn: (range: string) => Promise<string[][]>;
  // Network downloaders
  downloadImageFn: typeof downloadImage;
  downloadFromDriveFn: typeof downloadFromDrive;
  getDriveFileMetadataFn: typeof getDriveFileMetadata;
  // Verifiers
  verifyShapeFn: typeof verifyGarmentTypeMatch;     // Pass 3
  verifySameProductFn: typeof verifySameProduct;    // Pass 2
  // Supplier canonical
  supplierCanonicalFn: typeof resolveSupplierCanonical;
  // Trail writer
  appendTrailRowFn: typeof appendTrailRow;
  // Constants
  spreadsheetId: string;
  sheetName: string;
}
```

**parseArgs pattern** (`scripts/audit-garment-types.ts:231-240`) — extend with new flags per Claude's Discretion:
```typescript
const { values } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    pid: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    're-audit': { type: 'boolean', default: false },
    'post-mortem': { type: 'boolean', default: false },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
```

**Env validation pattern** (`scripts/audit-garment-types.ts:249-259`) — copy verbatim, ADD S&S envs:
```typescript
const required = [
  'OPENAI_API_KEY',
  'GOOGLE_SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'SS_ACCOUNT_NUMBER',   // NEW — for Tier 1 / Pass 2 S&S canonical
  'SS_API_KEY',          // NEW
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}
```

**Chunked --all reader pattern** (`scripts/audit-garment-types.ts:184-218`):
```typescript
const CHUNK_SIZE = 1000;
let chunkNum = 0;
let hasMore = true;
let productsProcessed = 0;
const seenColors = new Set<string>();
while (hasMore) {
  const offset = chunkNum * CHUNK_SIZE;
  const { rows } = await readRowRangeFn(...);
  if (rows.length === 0) { hasMore = false; break; }
  if (rows.length < CHUNK_SIZE) hasMore = false;
  for (const r of rows) {
    const key = `${r.styleID.trim()}|${r.colorName.trim()}`;
    if (seenColors.has(key)) continue;
    seenColors.add(key);
    if (args.limit !== undefined && productsProcessed >= args.limit) { hasMore = false; break; }
    await processRow(r);
    productsProcessed++;
  }
  chunkNum++;
}
```

**Phase 16 adaptation:** Use raw-row reader instead (Pitfall 1). Dedupe by pid only (one pass per pid, not per color), per the audit-by-pid scope.

**Raw-row read pattern** (`scripts/fetch-ss-images-fixed.ts:72-86`) — copy this verbatim for Pass 1:
```typescript
const resp = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `'Bestsellers-Ready'`,
});
const rows = (resp.data.values ?? []) as string[][];
const h: Record<string, number> = {};
rows[0].forEach((x, i) => { h[x] = i; });

const pidIdx = h['productId'];
const frontIdx = h['FrontImage'];
const backIdx = h['BackImage'];
const sideIdx = h['DirectSideImage'];
const modelFIdx = h['ModelFrontImage'];
const modelSIdx = h['ModelSideImage'];
const modelBIdx = h['ModelBackImage'];
```

**isDirectRun guard pattern** (`scripts/audit-garment-types.ts:301-307`):
```typescript
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-image-pollution');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

**Per-row try/catch fall-through** (`scripts/audit-garment-types.ts:158-161`) — copy verbatim:
```typescript
try {
  // ... verify call
} catch (err) {
  logger.warn(`[audit-image-pollution] Failed verifying ${row.productId}/${view}: ${err}`);
  // Do NOT increment counts on verifier exception — only on confirmed mismatch.
}
```

**Summary print pattern** (`scripts/audit-garment-types.ts:294-298`) — extend for D-09 header:
```typescript
console.log(`\n=== Summary ===`);
console.log(`Processed: ${summary.pidsScanned}`);
console.log(`Polluted: ${summary.pidsPolluted}`);
console.log(`Headwear skipped: ${summary.headwearSkipped}`);
console.log(`Class breakdown: shared_url=${summary.classCounts.shared_url} content_mismatch=${summary.classCounts.content_mismatch} model_pollution=${summary.classCounts.model_pollution} shape_drift=${summary.classCounts.shape_drift} invalid_image_format=${summary.classCounts.invalid_image_format}`);
console.log(`Output: tmp/image-pollution-audit-${date}.tsv (run_id: ${getOrCreateTrailRunId()})`);
```

**Test analog:** `tests/scripts/audit-garment-types.test.ts` (entire file, especially Test 7 invariant on line 177-214 — the read-only static guarantee). Phase 16's audit script MUST have an equivalent Test 7 that verifies it imports no write-side modules (`uploadToDrive`, `writeUpdates`, `trashDriveFile`).

---

### `scripts/fix-image-pollution.ts` (CLI, batch read-write)

**Analog:** Composite — `scripts/audit-garment-types.ts` for the CLI skeleton; `scripts/fetch-ss-images-fixed.ts` for the read-update-write flow.

**CLI skeleton** — copy `scripts/audit-garment-types.ts:230-307` verbatim with renamed flags + DI seam.

**Update collection pattern** (`scripts/fetch-ss-images-fixed.ts:147-180`):
```typescript
const updates: Array<{ range: string; values: string[][] }> = [];
// ... per row:
const rn = i + 1;  // 1-indexed sheet row
const fillCell = (idx: number, val: string): boolean => {
  if (val && !String(row[idx] ?? '').trim()) {
    updates.push({ range: `'${TAB}'!${colLetter(idx)}${rn}`, values: [[val]] });
    return true;
  }
  return false;
};
```

**Phase 16 adaptation** — use `columnToLetter` from `src/sheets/column-map.ts:11-19` instead of inline `colLetter` (project convention). Also: Phase 16 OVERWRITES (not fill-only), since the cell already has a polluted value:
```typescript
import { columnToLetter } from '../src/sheets/column-map.js';
import { writeUpdates } from '../src/sheets/writer.js';

// Per fix:
updates.push({
  range: `'${TAB}'!${columnToLetter(colIdx)}${rowNum}`,
  values: [[newUrl]],
});
```

**Batched write pattern** — use `src/sheets/writer.ts:18-48` `writeUpdates(sheets, spreadsheetId, updates)` (project's official helper). Per `src/sheets/writer.ts:9` it chunks at 50_000 cells, uses `RAW` input. Do NOT re-implement chunking.

**Drive upload-in-place pattern + the CRITICAL trash gotcha** (per user memory `feedback_drive_update_in_place` + RESEARCH lines 938-946):

```typescript
// uploadToDrive returns the SAME fileId for an existing filename (update-in-place).
// MUST compare origFileId vs newFileId BEFORE trashing the old file.
const origFileId = extractFileId(currentBrUrl);
const newUrl = await uploadToDrive(drive, newBuffer, filename, supplierCode, styleId);
const newFileId = extractFileId(newUrl);

if (origFileId && newFileId && origFileId !== newFileId) {
  // Different fileIds — safe to trash the old one
  await trashDriveFile(drive, origFileId);
  await appendTrailRow({ pid, operation: 'DRIVE_DELETE', column_or_path: origFileId, tier, ... });
}
// else: uploadToDrive updated in-place; the old fileId IS the new fileId. Never trash.
```

**Tier-1 happy path skeleton** (per RESEARCH architecture diagram):
```typescript
async function tier1Fix(pid: string, polluted: PollutionRow, deps: Deps): Promise<TierResult> {
  // 1. Resolve canonical
  const canonical = await deps.supplierCanonicalFn(pid);
  if (!canonical) return { tier: 1, status: 'no_canonical', cascade: true };

  // 2. Fetch new image
  const newBuffer = await deps.downloadImageFn(canonical.url);

  // 3. Verifier-after-fix (only if replacing back/side/model, per RESEARCH lines 511-518)
  if (polluted.affected_columns !== 'FrontImage') {
    const frontBuf = await deps.downloadFromDriveFn(deps.driveClient, extractFileId(polluted.current_front)!);
    const result = await deps.verifySameProductFn(deps.openai, newBuffer, frontBuf);
    await deps.appendTrailRowFn({
      pid, operation: result.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
      column_or_path: polluted.affected_columns,
      old_value: polluted.current_url, new_value: canonical.url,
      tier: 1, notes: result.reason, ...
    });
    if (!result.match) return { tier: 1, status: 'verifier_rejected', cascade: true };
  }

  // 4. Upload to Drive (preserving fileId if same filename)
  // 5. Compare origFileId vs newFileId — only trash if different
  // 6. writeUpdates to BR
  // 7. Trail rows for DRIVE_UPLOAD + BR_WRITE
  return { tier: 1, status: 'fixed' };
}
```

**Tier-2 invocation** (`src/lib/ai-image-generator.ts:341-479` — `generateGarmentView` already runs Phase 15 verifier inline at line 388 + 392 strict-AND filter). Per RESEARCH line 513-514: "Phase 15's generateGarmentView ALREADY runs verifyGarmentTypeMatch internally (strict AND filter, line 392) — the output is verifier-passing by construction. No second verifier call needed for Tier 2."

**Tier-counting pattern for R6 gate**:
```typescript
const tier3Count = pollutedRows.filter(r => r.tier1_status === 'cascade' && r.tier2_status === 'cascade').length;
if (tier3Count > 20) {
  console.error(`BLOCKED-QUEUE-OVERFLOW: manual queue size ${tier3Count} exceeds R6 cap (20)`);
  // Write JSON summary, exit non-zero
  process.exit(2);
}
```

**Test analog:** `tests/scripts/audit-garment-types.test.ts` (DI mocking pattern). Required cases per RESEARCH Wave 0 Gaps:
1. R3 happy path — supplier fetch + verifier pass + BR write logged
2. R9 safety rail — mocked verifier fail → no BR write, cascade to next tier, `VERIFIER_FAIL` row in trail
3. R4 Tier 2 — mocked `generateGarmentView` returns null → cascade to Tier 3
4. R6 gate — feed 21 tier-3-cascaded pids → exit code 2 (BLOCKED-QUEUE-OVERFLOW)
5. R8 safety rail — pid with no verifier-confirmed pollution + delete attempt → skipped, logged as safety-rail-skip
6. Drive update-in-place gotcha — origFileId === newFileId → trashDriveFile NOT called

---

### `scripts/fix-image-pollution-manual.ts` (CLI, event-driven)

**Analog:** RESEARCH lines 521-595 (designed scaffold) + `scripts/audit-garment-types.ts:230-307` (CLI skeleton).

**No in-repo precedent for interactive readline.** Grep over `package.json` confirms no `inquirer`/`prompts` dependency — use Node built-in per RESEARCH line 522.

**readline scaffold** (RESEARCH lines 526-538) — copy:
```typescript
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = createInterface({ input, output });

async function promptForChoice(prompt: string, validChoices: string[]): Promise<string> {
  while (true) {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (validChoices.includes(answer)) return answer;
    console.log(`Invalid choice. Expected one of: ${validChoices.join(', ')}`);
  }
}
```

**Per-row prompt loop** — copy RESEARCH lines 539-595 verbatim. Key invariants:

1. **Choice menu fixed:** `[r]eplace | [s]kip | [a]ccept-as-is | [d]elete | [v]iew | [q]uit` (D-13)
2. **`d` requires literal "DELETE" confirmation** (D-13, D-19)
3. **`r` requires verifier-after-fix:** download candidate via `downloadFromDrive`, download SoT front, run `verifySameProduct`. On fail: prompt `[r]etry | [s]kip | [f]orce`. `[f]orce` requires typing literal `FORCE`.
4. **Trail-row ordering invariant** (RESEARCH lines 599-612): VERIFIER_PASS row → fsync → BR/Drive mutate → BR_WRITE row → fsync. Skip without mutate logs MANUAL_SKIP or MANUAL_ACCEPT.

**Quit-and-resume invariant:**
- `q` calls `rl.close()` + `process.exit(0)` after current row's trail rows are fsync'd
- On next run, `loadProcessedPids()` from `src/lib/image-pollution-trail.ts` (designed above) returns terminal-operation pids (BR_WRITE, MANUAL_SKIP, MANUAL_ACCEPT). Already-handled rows are silently skipped.

**Test analog:** RESEARCH Wave 0 gap — `tests/scripts/fix-image-pollution-manual.test.ts`. Pattern: mock `rl.question` via DI seam (don't import `node:readline/promises` directly inside the per-row handler; accept a `promptFn: (q: string) => Promise<string>` dep). Required cases per R5 + R8:
1. `r` choice → prompts new URL → verifier pass → BR_WRITE trail row written
2. `r` choice → verifier fail → cascade prompt → `s` → MANUAL_SKIP, no BR write
3. `d` choice → wrong confirmation text → abort, no BR write, no DRIVE_DELETE
4. `d` choice → "DELETE" typed exactly → BR cell blanked, DRIVE_DELETE trail row, Drive file trashed
5. `s` choice → MANUAL_SKIP trail row, no mutations
6. `a` choice → MANUAL_ACCEPT trail row, no mutations
7. `q` choice mid-queue → process.exit(0); subsequent run skips already-processed pids

---

### `src/sheets/drive.ts` (MODIFY — add 4 helpers)

**Analog:** self — existing patterns in same file.

**Existing patterns to mirror** (`src/sheets/drive.ts:18-47` createDriveClient + `:94-155` uploadToDrive):
- All functions take `drive: drive_v3.Drive` as first arg
- All Drive API calls use `supportsAllDrives: true`
- Logger calls use `[drive]` prefix
- Empty/missing-id checks return `null`, never throw

**`extractFileId`** — extracted from `scripts/fetch-fixture-binaries.ts:42-49` (verbatim copy, just relocate):
```typescript
/** Extract Drive fileId from a public-view URL. Returns null if not a Drive URL. */
export function extractFileId(url: string): string | null {
  if (!url) return null;
  const ucMatch = url.match(/[?&]id=([\w-]{20,})/);
  if (ucMatch) return ucMatch[1];
  const fileMatch = url.match(/\/file\/d\/([\w-]{20,})/);
  if (fileMatch) return fileMatch[1];
  return null;
}
```

**`downloadFromDrive`** — extracted from `scripts/fetch-fixture-binaries.ts:51-58`:
```typescript
/** Download a Drive file's content by fileId. Returns Buffer. */
export async function downloadFromDrive(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(response.data as ArrayBuffer);
}
```

**`trashDriveFile`** — extracted from `scripts/dedupe-drive-duplicates.ts` (pattern per RESEARCH line 204):
```typescript
/** Soft-delete a Drive file by moving to trash. Idempotent. */
export async function trashDriveFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
  logger.info(`[drive] Trashed file ${fileId}`);
}
```

**`getDriveFileMetadata`** — NEW per RESEARCH line 205 (for Pass 1 invalid_image_format detection):
```typescript
export interface DriveFileMetadata {
  mimeType: string;
  size: string;     // Drive API returns as string
  name: string;
}

/** Fetch metadata (mimeType, size, name) for a Drive file. */
export async function getDriveFileMetadata(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveFileMetadata> {
  const resp = await drive.files.get({
    fileId,
    fields: 'mimeType,size,name',
    supportsAllDrives: true,
  });
  return {
    mimeType: resp.data.mimeType ?? '',
    size: resp.data.size ?? '0',
    name: resp.data.name ?? '',
  };
}
```

**Tests:** Existing `src/sheets/drive.ts` may not have a dedicated test file (search confirmed earlier — none in `tests/sheets/`). Tests for the new helpers can live in `tests/sheets/drive.test.ts` (NEW) or be exercised indirectly via `tests/scripts/audit-image-pollution.test.ts` mocks. Recommendation: skip dedicated drive.ts tests; mock `downloadFromDriveFn`, `getDriveFileMetadataFn`, `trashDriveFile` at the script-level DI seam.

---

### `src/sheets/types.ts` (DECISION REQUIRED — extend SheetRow OR document raw-read)

**Per RESEARCH line 40 + Pitfall 1 (lines 928-936):** `SheetRow` lacks `ModelFrontImage` / `ModelSideImage` / `ModelBackImage`. Two options:

**Option A — Extend SheetRow + SHEET_COLUMNS** (high-risk: every caller of `readAllRows` becomes responsible for either using the new fields or being indifferent):
- Append 3 fields to `SheetRow` interface (`src/sheets/types.ts:5-45`)
- Append 3 entries to `SHEET_COLUMNS` constant (`src/sheets/types.ts:51-91`)
- Risk: changes the typed row shape for every existing caller (~15 scripts use SheetRow). Phase 14/15 audits may regress.

**Option B — Document the raw-read pattern in Phase 16 code** (low-risk, recommended by RESEARCH line 934):
- Leave `src/sheets/types.ts` untouched
- In `scripts/audit-image-pollution.ts` and `scripts/fix-image-pollution.ts`, use `sheets.spreadsheets.values.get` + header indexing (pattern from `scripts/fetch-ss-images-fixed.ts:72-86`)
- Add a code-comment in the audit script: `// Cannot use readAllRows — SheetRow (src/sheets/types.ts) lacks Model* columns. See RESEARCH Pitfall 1.`

**Recommendation for planner:** Option B (Phase 16 should NOT change shared types — minimizes blast radius). Document the decision in the plan.

---

## Shared Patterns

### Pattern 1 — DI seam for testability (applies to all 3 scripts)

**Source:** `scripts/audit-garment-types.ts:34-45` + `tests/scripts/audit-garment-types.test.ts:45-74`

**Apply to:** `scripts/audit-image-pollution.ts`, `scripts/fix-image-pollution.ts`, `scripts/fix-image-pollution-manual.ts`

**Discipline:** Every external dependency (sheets client, drive client, openai client, downloader, verifier, trail writer, supplier resolver, readline prompter) is a function-typed property on a `Deps` interface. The script's CLI entry constructs concrete deps; tests construct mocked deps.

**Why mandatory:** Phase 15's `tests/scripts/audit-garment-types.test.ts` proves the pattern works for this codebase. Phase 16 audit script's Test 7 (invariant) requires it.

---

### Pattern 2 — Read-only invariant test (applies to audit script ONLY)

**Source:** `tests/scripts/audit-garment-types.test.ts:177-214`

**Apply to:** `tests/scripts/audit-image-pollution.test.ts` (R1's read-only constraint)

**Discipline:** A static test parses the audit-script source file and asserts:
- No `import` from `'../src/sheets/drive'` (no Drive writes)
- No `import` from `'../src/sheets/writer'` (no BR writes)
- No `uploadToDrive`, `writeUpdates`, `trashDriveFile` symbols anywhere outside the safety-comment block at top of file

**Why mandatory:** Phase 15 ships this guarantee — Phase 16 audit script MUST maintain it.

---

### Pattern 3 — Non-throwing TSV writer with sanitize-on-write

**Source:** `src/lib/rejects-tsv.ts:63-93`

**Apply to:** `src/lib/image-pollution-trail.ts`

**Discipline:** TSV writes are non-fatal (catch all FS errors, log warn, do not re-throw). Every LLM-or-operator-controlled string field is sanitized via `/[\t\n\r]+/g → ' '` before tab-join. ASVS V5 TSV-injection guard.

---

### Pattern 4 — gpt-4o-mini Vision verifier (request-response)

**Source:** `src/lib/ai-image-generator.ts:129-181`

**Apply to:** `src/lib/verify-same-product.ts`, plus implicit reuse via `verifyGarmentTypeMatch` in Pass 3.

**Discipline (all 6 properties below are mandatory):**
1. Model: `'gpt-4o-mini'`
2. `max_tokens: 100`
3. `response_format: { type: 'json_object' }`
4. Image encoding: `data:image/png;base64,${buffer.toString('base64')}` with `detail: 'low'`
5. Two-step JSON parse: direct `JSON.parse` first; on failure, regex-extract `/\{[\s\S]*\}/` and re-parse
6. False-accept fallback on ANY error: `return { match: true, reason: 'verifier ... fallback' }`

---

### Pattern 5 — Rate-limited supplier fetch with 503 retry

**Source:** `scripts/fetch-ss-images-fixed.ts:20, 44-53` (S&S) and `scripts/scrape-csw-product.ts:14, 37-42` (CSW)

**Apply to:** `src/lib/supplier-canonical.ts`, and any new scraper added per D-12 contingency

**Discipline:**
- S&S: `RATE_LIMIT_MS = 1100` between calls (60 req/min); on 503 sleep 10s + retry once
- CSW: `RATE_LIMIT_MS = 1000` with module-global `lastRequestAt` throttle
- All fetches set explicit `User-Agent` (per CSW pattern line 46)

---

### Pattern 6 — Drive update-in-place compare-before-trash (CRITICAL)

**Source:** `src/sheets/drive.ts:104-125` + user memory `feedback_drive_update_in_place`

**Apply to:** `scripts/fix-image-pollution.ts`, `scripts/fix-image-pollution-manual.ts`

**Discipline:**
```typescript
const origFileId = extractFileId(currentBrUrl);
const newUrl = await uploadToDrive(drive, buffer, filename, supplier, styleId);
const newFileId = extractFileId(newUrl);
if (origFileId && newFileId && origFileId !== newFileId) {
  await trashDriveFile(drive, origFileId);
}
// else: uploadToDrive updated in-place — origFileId IS newFileId — NEVER trash.
```

**Why critical:** Without this check, the fix flow destroys its own output (per user memory).

---

### Pattern 7 — Headwear (H08*) hard exclusion

**Source:** D-22 + RESEARCH Pitfall 7 (line 982)

**Apply to:** `scripts/audit-image-pollution.ts` (every Pass) + `src/lib/supplier-canonical.ts`

**Discipline:** At the START of each Pass 1/2/3 loop body, check `if (/^H08/i.test(pid)) { headwearSkipped++; continue; }`. Increment `headwear_skipped_count` ONCE per pid, not once per pass.

---

### Pattern 8 — env-validation fail-fast

**Source:** `scripts/audit-garment-types.ts:247-259`

**Apply to:** all 3 new scripts

**Discipline:** Validate `process.env[k]` for all required keys BEFORE constructing any clients (otherwise SDK errors mask the real "missing env var" cause). Console.error + `process.exit(1)` on missing.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| (none) | — | — | Every Phase 16 file has at least a role-match analog. The closest to "no analog" is the interactive CLI (`fix-image-pollution-manual.ts`), but Node `readline/promises` is a built-in and the RESEARCH-designed scaffold (lines 521-595) is concrete enough to be treated as the analog. |

---

## File Lifecycle Notes (for planner waves)

| File | Wave priority | Depends on | Blocks |
|------|---------------|------------|--------|
| `src/lib/image-pollution-trail.ts` | Wave 1 (foundation) | none | scripts |
| `src/lib/verify-same-product.ts` | Wave 1 (foundation) | none | audit + fix |
| `src/sheets/drive.ts` (modify) | Wave 1 (foundation) | none | audit (metadata) + fix (download + trash) |
| `src/lib/supplier-canonical.ts` | Wave 2 | drive.ts (modify) | audit Pass 2 + Tier 1 |
| `scripts/audit-image-pollution.ts` | Wave 3 | all of Wave 1+2 | fix scripts (consumes audit TSV) |
| `scripts/fix-image-pollution.ts` | Wave 4 | audit TSV + supplier-canonical | manual CLI (consumes manual queue TSV) |
| `scripts/fix-image-pollution-manual.ts` | Wave 5 | fix orchestrator output | re-audit |
| `tests/*` | concurrent with their target file | n/a | n/a |

---

## Metadata

**Analog search scope:** `src/lib/`, `src/sheets/`, `scripts/`, `tests/lib/`, `tests/scripts/`
**Files scanned (full or targeted):** `src/lib/rejects-tsv.ts`, `src/lib/ai-image-generator.ts`, `src/sheets/drive.ts`, `src/sheets/writer.ts`, `src/sheets/column-map.ts`, `src/sheets/types.ts`, `scripts/audit-garment-types.ts`, `scripts/fetch-ss-images-fixed.ts`, `scripts/scrape-csw-product.ts`, `scripts/audit-product-imagery.ts`, `scripts/fetch-fixture-binaries.ts`, `tests/lib/rejects-tsv.test.ts`, `tests/scripts/audit-garment-types.test.ts`
**Pattern extraction date:** 2026-05-12
**Phase 16 spec ambiguity:** 0.18 (gate ≤ 0.20)

## PATTERN MAPPING COMPLETE
