# Phase 16: Catalog Image Pollution Audit & Fix — Research

**Researched:** 2026-05-12
**Domain:** Multi-pass image-identity auditing + tiered auto-fix over Bestsellers-Ready (~460 pids)
**Confidence:** HIGH on reuse mapping + Drive/Sheet/Supplier APIs (all code read directly). MEDIUM on empirical pollution counts (live audit still running at research time). MEDIUM on verifier prompt design (Phase 15's prompt is family-coarse; Phase 16 needs same-product strict — different semantics).

## Summary

Phase 16 plugs identity-level auditing (right product in the right slot) on top of Phase 14's structural reconciliation (BR↔Drive↔Store consistency) and Phase 15's shape-only verification (back/side matches the front family). The architecture is already mostly built:

- Phase 15 ships the AI verifier (`verifyGarmentTypeMatch`) + the rejects-tsv writer (`appendRejectRow`) + the DI-seam audit script pattern (`scripts/audit-garment-types.ts`) — Phase 16 generalizes the TSV writer to a trail-row writer and adds a second verifier prompt for "same specific product" comparison.
- Phase 14 ships `KNOWN_SUPPLIER_PREFIXES`, `resolveStoreProduct`, cross-pollution TSV classification — Phase 16 extends the allowlist and reuses the resolver if any tier touches Shopify (it shouldn't — Phase 16 is BR+Drive only per CONTEXT scope).
- Phase 10 ships `generateGarmentView()` already with Phase 15 verifier integrated — Phase 16 Tier 2 just calls it.
- `scripts/fetch-ss-images-fixed.ts` already resolves S* pids → S&S styleID → 6-column image bundle (Front/Back/Side/Model×3) by color. Tier 1 wraps this code for S&S.
- `scripts/scrape-csw-product.ts` already returns CSW images by Shopify CDN URL. Tier 1 wraps this code for L* pids.
- `src/sheets/drive.ts:uploadToDrive()` handles update-in-place; `src/sheets/writer.ts:writeUpdates()` handles atomic per-cell BR updates.

**Primary recommendation:** Build Phase 16 as 4 new scripts (`audit-image-pollution.ts`, `fix-image-pollution-tier1.ts`, `fix-image-pollution-tier2.ts`, `fix-image-pollution-manual.ts`) and 3 new libs (`src/lib/image-pollution-trail.ts`, `src/lib/supplier-canonical.ts`, `src/lib/verify-same-product.ts`). Reuse `verifyGarmentTypeMatch` unchanged for shape (Pass 3); add a sibling `verifySameProduct` for content (Pass 2). Add a 4th structural class: `invalid_image_format` (Pass 1) — the live audit shows ~48 HTTP-400-from-Vision warnings on BR images that aren't valid PNG/JPEG/GIF/WebP and structurally pollute every downstream pass.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pass 1 structural detection (shared-URL collision, invalid format) | Node script reading BR | Drive metadata (HEAD) | Pure sheet+filesystem; no AI |
| Pass 2 content verifier (same specific product) | OpenAI gpt-4o-mini Vision | Supplier API (canonical fetch) | Identity comparison needs vision; supplier API provides truth source |
| Pass 3 shape verifier (Phase 15 reuse) | OpenAI gpt-4o-mini Vision | — | Already shipped in `verifyGarmentTypeMatch` |
| Tier 1 supplier fetch | Node script | S&S REST API / CSW Shopify scraper | Suppliers own canonical product imagery |
| Tier 2 AI regen | `generateGarmentView()` Phase 10 | Phase 15 verifier-after | Only back/side regenerable; front needs human/supplier |
| Tier 3 manual CLI | Node script + Node `readline` | Operator (human-in-loop) | No further automation possible |
| Trail TSV (append-only, resumable) | Node script + sync fs | — | Existing `rejects-tsv.ts` pattern generalizes cleanly |
| Drive write/delete | `src/sheets/drive.ts` | — | Already authenticated, scopes correct |
| BR cell update | `src/sheets/writer.ts:writeUpdates()` | — | Per-cell batched, atomic |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| R1 | Audit all unique BR pids for 3 pollution classes (shape, content, model) | Pass 1+2+3 design below; reuses Phase 15 `verifyGarmentTypeMatch` (Pass 3) + new `verifySameProduct` (Pass 2) + new shared-URL scanner (Pass 1) |
| R2 | Audit covers all 6 image columns (Front/Back/DirectSide/Model×3) | BR sheet has these as raw headers (verified by `fetch-ss-images-fixed.ts:83-85`); `SheetRow` type does NOT include them — must read raw rows via `sheets.values.get(BR_TAB)` and index by header position |
| R3 | Tier 1: Re-fetch from supplier (S&S REST / CSW scraper) | Existing code in `scripts/fetch-ss-images-fixed.ts` (S&S, complete 6-col fetcher) + `scripts/scrape-csw-product.ts` (CSW images via Shopify CDN). Wrap in `src/lib/supplier-canonical.ts` for reuse |
| R4 | Tier 2: AI regen via `generateGarmentView()` + Phase 15 verifier-after | Already wired in `src/lib/ai-image-generator.ts:341-479` with strict AND filter; Phase 16 just invokes per pollution row |
| R5 | Tier 3: Manual operator queue (interactive CLI) | No precedent — design below using Node built-in `readline.createInterface()`; no `inquirer`/`prompts` dependency required (none currently in package.json) |
| R6 | HARD CAP: manual queue ≤ 20 | Phase BLOCKS via JSON summary `manual_queue_size > 20` → re-planning. Operator pre-audit estimate: 7-15 manual rows expected (see Empirical Audit Data Summary) |
| R7 | Full audit trail of every change | New `src/lib/image-pollution-trail.ts` generalizes `appendRejectRow` to multi-operation logger. Append-only, sync fsync, idempotent re-runs |
| R8 | Safety rail: never delete a good image | Verifier-confirmed pollution required before Drive delete or BR blank. Logged as `safety-rail-skip` if verifier disagrees |
| R9 | Safety rail: never replace good with wrong | Verifier-after-fix mandatory on every Tier 1/2 write. New image discarded on fail; pid cascades to next tier; trail logs `VERIFIER_FAIL` |
| R10 | Phase closes only when zero unresolved | Re-audit script with `--re-audit` flag re-runs Passes 1-3 over post-fix BR; success = 0 rows OR every original-pid has BR_WRITE in trail |
| R11 | "Resolved" = BR_WRITE with new_value != old_value | Trail query script returns `resolved=true` only when the operation type=BR_WRITE has old/new value differ. Skip/accept-as-is do NOT count |
</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 Pass 1 structural** — Scan BR for fileId collisions (extracted from FrontImage/BackImage/DirectSideImage/ModelFrontImage/ModelSideImage/ModelBackImage URLs) appearing in rows for >1 distinct pid; flag as content-mismatch. Cheap, deterministic, no AI. Catches the 8882=5200=CE520L=NE220 Adidas-hoodie class.

**D-02** Pass 1 produces TSV of (fileId, list_of_pids_sharing_it, columns_using_it) sorted by collision count desc.

**D-03 Pass 2 content** — For each pid, compare BR FrontImage to a supplier canonical fetched at audit time. Verifier prompt: "Are these two images of the same specific product? Answer yes/no with one-sentence reason." NOT "same garment family?" (too loose; needs same-product strict).

**D-04 Supplier canonical resolution:** S* prefix → S&S Canada REST (per `scripts/fetch-ss-rest-sizes.ts`); L* prefix → CSW scraper (per `scripts/scrape-csw-product.ts`); other prefixes → consult `KNOWN_SUPPLIER_PREFIXES`; if no supplier mapped, flag `no_canonical_available` (cannot Pass 2 verify; falls through to Pass 3 shape only).

**D-05** Pass 2 also verifies each Model* column against the corresponding garment-only column for the same pid ("Is the garment in this model photo the same product as in this front photo?"). Catches the 8882 case.

**D-06 Pass 3 shape** — Reuse Phase 15's `verifyGarmentTypeMatch()` on each pid's BackImage vs FrontImage, DirectSideImage vs FrontImage. Same prompt, same gpt-4o-mini, same `detail: 'low'`. No changes.

**D-07** Pass 3 only runs on pids that survived Passes 1+2 cleanly. Avoids double-flagging.

**D-08 Audit TSV** — `tmp/image-pollution-audit-{YYYY-MM-DD}.tsv`. Columns: `pid, pollution_class (shared_url|content_mismatch|shape_drift|model_pollution), affected_columns, affected_drive_urls, expected_supplier_url, recommended_fix_tier (1/2/3), pass_detected_in (1/2/3), notes`.

**D-09** Pre-audit summary header in TSV: `# audit_run_id, # pids_scanned, # pids_polluted, # class_counts, # headwear_skipped_count`.

**D-10 Per-tier batching** — Execute Tier 1 → Tier 2 → Tier 3 sequentially.

**D-11** After Tier 2, if manual queue > 20: status BLOCKED-QUEUE-OVERFLOW; operator runs post-mortem; planner re-engages.

**D-12 Tier 1 scraper expansion strategy if queue > 20:** Bella+Canvas, Gildan core catalog, S&S OneSource fallback — planning-time decision, NOT run-time.

**D-13 Interactive CLI walkthrough** — New `scripts/fix-image-pollution-manual.ts`. Per row: display pid+class+columns+Drive URLs (terminal-clickable); prompt `[r]eplace | [s]kip | [a]ccept-as-is | [d]elete | [v]iew | [q]uit`; on `r`: prompt new URL/fileId, verifier-after-fix, write or retry; on `d`: confirm by typing `DELETE`; resumable on `q`.

**D-14 Trail TSV** — `tmp/image-pollution-fix-trail-{YYYY-MM-DD}.tsv`. One row per operation, columns: `timestamp_iso, pid, operation (BR_WRITE|DRIVE_UPLOAD|DRIVE_DELETE|SUPPLIER_FETCH|AI_REGEN|VERIFIER_PASS|VERIFIER_FAIL|MANUAL_SKIP|MANUAL_ACCEPT), column_or_path, old_value, new_value, tier, notes`.

**D-15 Resume from trail** — Read existing trail TSV at startup; build `processed_pids` set; skip those in current run. Each row written + fsync'd before continuing.

**D-16 Re-audit mechanism** — `--re-audit` flag re-runs audit; R10 checked by re-audit, not inline.

**D-17 Verifier-after-fix gate** — Mandatory on EVERY Tier 1/2 write. Source-of-truth resolution: if BR FrontImage being replaced → SoT = supplier canonical; if back/side/model being replaced → SoT = current FrontImage (assumed correct unless Tier 1 already flagged + fixed in same run).

**D-18 Verifier failure rolls back transparently.** New image discarded, BR cell + Drive not modified, pid cascades to next tier. Trail logs `VERIFIER_FAIL` with reason.

**D-19 Delete operations require explicit pollution confirmation.** Drive delete or BR blank only fires when trail has confirmed `VERIFIER_FAIL` or pollution-class flag for that specific image. Defensive — no implicit deletes.

**D-20 Concurrency** — Sequential per-pid within each tier; planner may add 3-5 parallel requests on Tier 1 if rate-limited. Trail format remains append-only with thread-safe writes.

**D-21 No concurrency between tiers.** Tier 1 completes before Tier 2 starts (need definitive Tier-1-resolved set). Tier 2 completes before Tier 3 finalizes (need definitive manual queue size for R6).

**D-22 Headwear H08* skipped silently in Passes 1-3 but counted.** Summary `headwear_skipped_count`.

**D-23 Audit budget:** ~$1.50-2.00 Vision (~460 pids × ~2-4 calls each @ $0.0003). Audit runtime ≤ 60 min.

**D-24 Fix budget:** No explicit cap. Cost shown in run summary.

### Claude's Discretion

- **TSV column ordering and exact header naming** — within D-08 / D-14 schemas, planner picks defaults.
- **CLI flag set** — `--all`, `--pid X`, `--dry-run`, `--re-audit`, `--manual`, `--post-mortem` are sufficient defaults.
- **Logging verbosity per tier** — debug/info/warn balance left to planner; trail TSV is the durable record.
- **Verifier prompt exact wording** — D-03 specifies semantics; planner refines the string + any few-shot examples.
- **Supplier API rate-limit handling** — linear backoff vs exponential, retry budget per pid.
- **Color-aware vs color-blind comparison** — default color-blind ("ignore color, compare style/brand/cut"). Planner may iterate based on false-positive rate.
- **Front image source-of-truth ordering** — D-17 specifies logic; planner implements.
- **Concurrency tuning within tiers** — D-20 allows it; planner picks parallelism level.
- **Audit/fix script names** — `scripts/audit-image-pollution.ts`, `scripts/fix-image-pollution.ts`, `scripts/fix-image-pollution-manual.ts` are reasonable defaults.

### Deferred Ideas (OUT OF SCOPE)

- Sweep Sheet1 (44k rows) — only BR in scope; future phase
- CSW baseCategory fix (1,494 rows) — separate phase
- Headwear CategoryGroup support — verifier doesn't support beanies/caps
- Store push of fixed products — `scripts/push-bestsellers-to-store.ts` runs after Phase 16 closes
- Drive folder reorganization
- Adding new pids to BR
- Automated weekly regression
- Web UI for manual queue
</user_constraints>

## Project Constraints (from CLAUDE.md)

CLAUDE.md (global): security (no hardcoded secrets, validate input at boundaries, parameterized queries), code quality (simplest working solution, no over-engineering), error handling (handle at right level, don't swallow), verify it works before completing. No project-local CLAUDE.md exists.

## Integration Map

New files Phase 16 creates:

| Path | Purpose | Depends on |
|------|---------|------------|
| `src/lib/image-pollution-trail.ts` | Generalized append-only trail writer (`appendTrailRow(operation, ...)`) extending `appendRejectRow` pattern | `src/lib/rejects-tsv.ts` (pattern) |
| `src/lib/supplier-canonical.ts` | Pid → canonical image URL resolver (S* via S&S REST; L* via CSW scraper; brand-prefix pids via `KNOWN_SUPPLIER_PREFIXES`) | `scripts/fetch-ss-images-fixed.ts` (reuse), `scripts/scrape-csw-product.ts` (reuse) |
| `src/lib/verify-same-product.ts` | New AI verifier: "are these two images the same SPECIFIC product?" (sibling to `verifyGarmentTypeMatch`) | `src/lib/ai-image-generator.ts` (pattern: OpenAI client, JSON-mode response, fallback semantics) |
| `scripts/audit-image-pollution.ts` | 3-pass audit producing `tmp/image-pollution-audit-{YYYY-MM-DD}.tsv` | `src/sheets/{client,reader}.ts`, `src/lib/{image-pollution-trail, supplier-canonical, verify-same-product, ai-image-generator}.ts` |
| `scripts/fix-image-pollution-tier1.ts` | Tier 1 supplier fetch + verifier-after | `src/sheets/{drive,writer}.ts`, `src/lib/{image-pollution-trail, supplier-canonical, verify-same-product, ai-image-generator}.ts` |
| `scripts/fix-image-pollution-tier2.ts` | Tier 2 AI regen via `generateGarmentView()` + write-back | `src/lib/{ai-image-generator, image-pollution-trail}.ts`, `src/shopify/image-standardizer.ts` (download/standardize) |
| `scripts/fix-image-pollution-manual.ts` | Tier 3 interactive CLI | Node built-in `readline`, `src/lib/{image-pollution-trail, verify-same-product}.ts` |

Existing files Phase 16 modifies (extend only — no delete-and-rewrite):

| Path | Change |
|------|--------|
| `scripts/audit-product-imagery.ts` | Extend `KNOWN_SUPPLIER_PREFIXES` (only if a Tier 1 plan adds more brand prefixes — likely deferred to D-12 contingency) |

## Supplier Scraper Inventory

| Script | Supplier | Coverage | Auth | Rate limit | Returns |
|--------|----------|----------|------|------------|---------|
| `scripts/fetch-ss-rest-sizes.ts` | S&S Canada | S* numeric pids (resolves brand-style → SS styleID via `/styles/?search=` first, then `/products/?style=`) | Basic auth from `SS_ACCOUNT_NUMBER` + `SS_API_KEY` | 60 req/min (1.1s sleep between calls in code) | colorFrontImage / colorBackImage / colorSideImage / colorDirectSideImage per color |
| `scripts/fetch-ss-images-fixed.ts` | S&S Canada | **Best reuse target** — already fetches all 6 columns (front + back + DirectSide + Model×3) per (pid, color); fills only empty cells; reads & writes BR | Same as above | Same as above | `ColorImages = { front, back, side, modelFront, modelSide, modelBack }` per color |
| `scripts/fetch-model-images.ts` | S&S Canada | Model images via `colorOnModelFrontImage / colorOnModelSideImage / colorOnModelBackImage`; uploads to Drive via `uploadToDrive` | Same as above | 1.1s sleep | Drive URLs |
| `scripts/scrape-csw-product.ts` | Canada Sportswear (CSW) | L* pids via Shopify search-suggest → product JSON; HTML scrape for size chart PDF | None (public Shopify storefront) | 1s throttle (single `lastRequestAt` global) | `{ handle, description, productType, tags, gender, sizeChartUrl, images: CSWImage[], optionColors }` — images include filename, src (CDN URL), variantIds, alt |

**Critical insight (verified via Phase 14 + 15 work):** `KNOWN_SUPPLIER_PREFIXES` in `scripts/audit-product-imagery.ts:51-77` lists 19 pid → brand-prefix mappings. Phase 16's `src/lib/supplier-canonical.ts` should consult this map to detect which scraper to use for non-S/L prefixed pids (e.g., pid `8882` → BELLA+CANVAS — currently no Bella scraper exists; would need to be added per D-12 if needed).

**Notable resolved pid prefixes already in allowlist:**

- Richardson (caps): 168, 112 — but caps are EXCLUDED from Phase 16 audit per D-22 (H08*)
- BELLA + CANVAS: 1010, 3001, 3010, 3480, 4610, 6003, 6008, **6110, 8882** — both case-fixtures in scope
- Next Level: 1510, 3900, 3911, 9002
- Comfort Colors: 1466, 1467
- Gildan: **5200** (case fixture)
- American Apparel: 1304
- C2/CE520L/NE220: NOT in allowlist — no scraper exists. These pids will Pass 2 with `no_canonical_available` and fall through to manual queue unless D-12 adds scrapers.

**Coverage estimate against BR's ~460 pids:**

| Prefix family | Estimated pid count | Tier 1 covered? |
|---------------|---------------------|-----------------|
| S* (S&S Canada) | ~150 | ✓ via `fetch-ss-images-fixed.ts` |
| L* (CSW) | ~140 | ✓ via `scrape-csw-product.ts` |
| Numeric + Bella allowlisted | ~10 | ✗ no scraper — manual queue or D-12 expansion |
| Numeric + Gildan/Next Level/etc | ~25 | ✗ no scraper — manual queue or D-12 expansion |
| H08* (headwear) | ~25 | (excluded per D-22) |
| A* (Adidas?), CE*, NE*, BC* etc | ~50 | ✗ no scraper — manual queue |
| Other | ~60 | varies — likely manual |

**Implication:** Without D-12 scraper additions, ~145 pids that hit Tier 1 lookup will return `no_canonical_available`. Most of these will be CLEAN (no pollution detected) — so they don't enter the fix queue. The danger is the subset that ARE polluted AND have no scraper: these auto-cascade to Tier 3, potentially blowing R6's ≤20 cap. Phase 16 planning must model this and pre-emptively decide whether Tier 1 expansion is needed.

## Drive + Sheet API Reference (concrete signatures + line numbers)

### Drive client — `src/sheets/drive.ts`

| Function | Signature | Notes |
|----------|-----------|-------|
| `createDriveClient()` | `: drive_v3.Drive` | Lines 18-47. Uses service-account auth via `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`. Scope: `https://www.googleapis.com/auth/drive`. Throws if env vars missing. |
| `uploadToDrive(drive, buffer, filename, supplierCode, styleId)` | `: Promise<string>` (returns `https://drive.google.com/uc?id=FILE_ID`) | Lines 94-155. **UPDATE-IN-PLACE if filename exists in target folder** (drive.files.update) — preserves URL/fileId; new uploads get `drive.files.create` + public `permissions.create({role:'reader', type:'anyone'})`. Folder path: `root / supplierCode / styleId / filename`. |

**MEMORY: Drive uploadToDrive update-in-place gotcha** — When uploading with an existing filename, returns the SAME fileId. Phase 16 trail must compare `origFileId` vs `newFileId` before trashing the old file — otherwise you destroy your own output (per user memory).

### Drive operations Phase 16 needs but `src/sheets/drive.ts` does NOT yet expose:

| Operation | Status | Phase 16 action |
|-----------|--------|-----------------|
| Download file by fileId | Used in `scripts/fetch-fixture-binaries.ts:51-58` via `drive.files.get({fileId, alt:'media', supportsAllDrives:true}, {responseType:'arraybuffer'})` | **Promote to `src/sheets/drive.ts` as `downloadFromDrive(drive, fileId): Promise<Buffer>`** so audit + fix scripts share one implementation |
| Trash a Drive file (soft delete) | Used in `scripts/dedupe-drive-duplicates.ts` via `drive.files.update({fileId, requestBody:{trashed:true}, supportsAllDrives:true})` | **Promote to `src/sheets/drive.ts` as `trashDriveFile(drive, fileId): Promise<void>`** |
| Get Drive file metadata (mime type, size) | Not yet used | **Add `getDriveFileMetadata(drive, fileId): Promise<{mimeType, size, name}>`** via `drive.files.get({fileId, fields:'mimeType,size,name', supportsAllDrives:true})` — needed for Pass 1 invalid-format detection |
| **Extract fileId from a Drive URL** | Used in `scripts/fetch-fixture-binaries.ts:42-49` (`extractFileId`) — handles both `uc?id=...` and `/file/d/...` formats | **Promote to `src/sheets/drive.ts` as `extractFileId(url: string): string \| null`** |

### Sheet writer — `src/sheets/writer.ts`

| Function | Signature | Notes |
|----------|-----------|-------|
| `writeUpdates(sheets, spreadsheetId, updates)` | `: Promise<number>` (cells updated) | Lines 18-48. **Atomic per-cell**. `updates: EnrichmentUpdate[]` where each is `{range: "'Bestsellers-Ready'!K42", values: [[newUrl]]}`. Uses `RAW` valueInputOption (no formula interpretation). Chunks at 50_000 cells per request. |
| `appendRows(sheets, spreadsheetId, sheetName, rows)` | `: Promise<number>` | Lines 57-84. Appends to bottom of tab via `INSERT_ROWS`. Phase 16 does NOT need this (no new pids). |

**Cell-address pattern** (verified in `scripts/fetch-ss-images-fixed.ts:33-37, 168`):

```typescript
function colLetter(idx: number): string {
  let r = '', n = idx;
  while (n >= 0) { r = String.fromCharCode((n % 26) + 65) + r; n = Math.floor(n / 26) - 1; }
  return r;
}
// Range for BR row 42 (1-indexed), column K (idx 10): `'Bestsellers-Ready'!K42`
// updates.push({ range: `'${TAB}'!${colLetter(idx)}${i+1}`, values: [[val]] });
```

`src/sheets/column-map.ts:11-19` exports `columnToLetter()` — same logic, different name. Phase 16 should use `columnToLetter` (the project's official helper) for consistency.

### Sheet reader — `src/sheets/reader.ts`

| Function | Signature | Notes |
|----------|-----------|-------|
| `readAllRows(sheets, spreadsheetId, sheetName?)` | `: Promise<{headers, rows: SheetRow[]}>` | Lines 23-76. **Does NOT include Model* columns in SheetRow** (verified — `src/sheets/types.ts:5-45` has no ModelFrontImage / ModelSideImage / ModelBackImage fields). |
| `readRowRange(sheets, spreadsheetId, offset, count, sheetName?)` | `: Promise<{rows: SheetRow[]}>` | Used by `scripts/audit-garment-types.ts` for chunked reads. |

**Critical gap for Phase 16:** The 6-image-column audit MUST read raw values (not typed `SheetRow`) because `SheetRow` lacks Model* fields. The pattern is verified in `scripts/fetch-ss-images-fixed.ts:72-86`:

```typescript
const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'` });
const rows = (resp.data.values ?? []) as string[][];
const h: Record<string, number> = {};
rows[0].forEach((x, i) => { h[x] = i; });

const frontIdx = h['FrontImage'];
const backIdx = h['BackImage'];
const sideIdx = h['DirectSideImage'];
const modelFIdx = h['ModelFrontImage'];
const modelSIdx = h['ModelSideImage'];
const modelBIdx = h['ModelBackImage'];
```

Phase 16's audit script SHOULD use this raw-read pattern, NOT `readAllRows`.

## Phase 14 / 15 Reusable Components

### From Phase 15 (`src/lib/ai-image-generator.ts`)

```typescript
// Line 129-181
export async function verifyGarmentTypeMatch(
  client: OpenAI,
  generatedBuffer: Buffer,
  frontBuffer: Buffer,
): Promise<VerifyGarmentTypeResult>
// Returns: { match: boolean, reason: string }
// Model: gpt-4o-mini, max_tokens: 100, response_format: { type: 'json_object' }, detail: 'low'
// Side-by-side comparison (front = reference; generated = candidate).
// Family-coarse (tops/hoodies/polos/crewnecks/jackets); NOT same-specific-product.
// Bypasses CostTracker per Phase 15 SPEC R5.
// Error policy: on Vision/parse failure, returns { match: true, reason: 'verifier ... fallback' }
// (false-accept preferred over false-reject when verifier itself broke).
```

**Reuse for Pass 3 verbatim.** No changes.

### From Phase 15 (`src/lib/rejects-tsv.ts`)

```typescript
// Line 79-93
export async function appendRejectRow(row: RejectRow): Promise<void>
// RejectRow = { pid, view: 'back'|'side', reason, timestamp, run_id }
// Path: tmp/garment-type-rejects.tsv (hardcoded)
// Behavior: write header on first call (existsSync gate); append-only after
// Sanitize: replace /[\t\n\r]+/g with single space (ASVS V5 — TSV injection guard)
// Non-throwing on FS failure (logger.warn only — TSV is side-channel)
// Memoized run_id: getOrCreateRunId() returns ISO-8601 once per process
```

**Generalize for Phase 16:** `src/lib/image-pollution-trail.ts` takes the same pattern but parameterizes:

1. Output path (date-stamped per D-14)
2. Header line (D-14's 11-column schema)
3. Row interface (`TrailRow` with operation + tier + columns)

**Recommended approach:** Don't refactor `rejects-tsv.ts`. Copy the pattern into the new file — rejects-tsv has 1 caller (the Phase 15 verifier in `ai-image-generator.ts`) plus 1 caller (the `audit-garment-types.ts` retro script). Merging into a generic "TSV writer factory" risks breaking Phase 15. Keep them separate; the pattern is small enough.

### From Phase 15 (`scripts/audit-garment-types.ts`)

The DI seam pattern (Lines 26-45):

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

export async function runGarmentTypeAudit(deps: RunGarmentTypeAuditDeps): Promise<{...}>
```

**Reuse this pattern for `runImagePollutionAudit(deps)`** in `scripts/audit-image-pollution.ts`. Adds: `verifySameProductFn`, `supplierCanonicalFn`, `appendTrailRowFn`, `driveClient`, `extractFileIdFn`, `getDriveMetadataFn`. The static invariant test in `tests/scripts/audit-garment-types.test.ts` (Test 7 — proves the script imports zero write-side modules) is a useful pattern for Phase 16's audit script.

### From Phase 14 (`scripts/audit-product-imagery.ts:51-77`)

`KNOWN_SUPPLIER_PREFIXES` allowlist — 19 pid → brand-prefix mappings. **Reused as-is** by Phase 16's supplier-canonical resolver.

### From Phase 14 (`src/shopify/resolve-store-product.ts`)

**NOT needed by Phase 16** — phase scope is BR + Drive only. No Shopify mutations.

### From Phase 14 (cross-pollution TSV schema)

`scripts/generate-cross-pollution-tsv.ts` writes columns: `parent_pid, filename, classification (MOVE-TO/KEEP-WHITELIST/TRASH-ORPHAN), target_pid, reason`. **Different problem** (Phase 14 is about Drive folder placement; Phase 16 is about image identity). Schemas overlap on `pid + classification` but Phase 16's classification is finer-grained (4 classes). Recommend: do NOT inherit the schema; write Phase 16's TSV fresh per D-08.

### From `scripts/fetch-fixture-binaries.ts`

`extractFileId(url)` — Lines 42-49. Handles both `?id=` and `/file/d/` forms. **Promote to `src/sheets/drive.ts`** so audit + manual CLI both use it.

## Detection Pipeline Design

### Pass 1 — Structural (zero AI cost)

**Input:** Raw BR sheet via `sheets.values.get({range:'Bestsellers-Ready'})`. ~24k color/size rows; dedupe to ~460 unique pids.

**Algorithm:**

```
1. Read all rows. For each row: extract fileId from every URL in the 6 image columns
   using extractFileId(url).
2. Build map<fileId, Set<pid>>; for each fileId where Set<pid>.size > 1, emit a
   shared_url pollution flag per pid in the set.
3. Independently: for each pid's FrontImage fileId, fetch Drive metadata (mimeType).
   If mimeType is NOT in {'image/png', 'image/jpeg', 'image/gif', 'image/webp'},
   emit an invalid_image_format pollution flag.
4. (Optional fast HEAD: HTTP HEAD on uc?id=... and inspect Content-Type — but
   public Drive view URLs sometimes return text/html; Drive metadata API is
   more reliable.)
```

**Output:** Audit TSV rows with `pollution_class ∈ {shared_url, invalid_image_format}` and `pass_detected_in=1`.

**Cost:** Zero Vision calls. Drive metadata API: free; ~460 calls × ~6 columns each = ~2,760 calls but cacheable per fileId.

**Runtime:** ~5-10 minutes (Drive metadata is rate-limited at 1000 req/100s but the SDK auto-throttles).

### Pass 2 — AI content verification

**Input:** Pids that survived Pass 1 without `shared_url` or `invalid_image_format` flags on the FrontImage column. For each such pid:

1. Resolve supplier canonical via `src/lib/supplier-canonical.ts` — returns one URL OR `no_canonical_available`.
2. If canonical found: download both BR FrontImage and supplier canonical; call `verifySameProduct(client, frontBuffer, canonicalBuffer)`.
3. If `no_canonical_available`: emit a soft flag for Pass 3 only (per D-04).

**Algorithm:**

```
For each pid surviving Pass 1:
  if pid is H08* (headwear):
    skip silently; increment headwear_skipped_count
    continue

  canonical = supplierCanonical.resolve(pid)
  if canonical == null:
    pid.pass2_status = 'no_canonical_available'
    continue

  frontBuf = drive.download(extractFileId(row.FrontImage))
  canonicalBuf = http.download(canonical.url)
  result = verifySameProduct(openai, frontBuf, canonicalBuf, {colorBlind: true})

  if !result.match:
    emit pollution_class='content_mismatch', affected_columns='FrontImage',
         expected_supplier_url=canonical.url, recommended_fix_tier=1

  // Also: Model* columns vs FrontImage (D-05)
  for col in ['ModelFrontImage','ModelSideImage','ModelBackImage']:
    if row[col] is empty: continue
    modelBuf = drive.download(extractFileId(row[col]))
    modelResult = verifySameProduct(openai, modelBuf, frontBuf, {colorBlind: true})
    if !modelResult.match:
      emit pollution_class='model_pollution', affected_columns=col,
           recommended_fix_tier= (1 if canonical else 3)
```

**Output:** Audit TSV rows with `pollution_class ∈ {content_mismatch, model_pollution}` and `pass_detected_in=2`.

**Cost:** ~$0.0003/call × (1 front-check + up to 3 model-checks) × ~430 non-headwear pids ≈ $0.50.

**Runtime:** ~30 min at 1.1s rate-limit per supplier call + ~1-2s per Vision call sequential.

### Pass 3 — AI shape verification (Phase 15 verbatim)

**Input:** Pids that survived Passes 1+2 cleanly — i.e., no `shared_url`, `invalid_image_format`, `content_mismatch`, or `model_pollution` flag.

**Algorithm:** Identical to Phase 15's `runGarmentTypeAudit`. For each surviving pid: download FrontImage; for each of BackImage and DirectSideImage that exists, call `verifyGarmentTypeMatch(openai, viewBuf, frontBuf)`. Emit `shape_drift` on `match: false`.

**Output:** Audit TSV rows with `pollution_class=shape_drift` and `pass_detected_in=3`.

**Cost:** ~$0.0003/call × 2 views × ~430 non-headwear pids × ~50% shape-survival rate ≈ $0.13.

**Runtime:** ~15 min.

**Total audit cost:** ~$0.65. **Total audit runtime:** ~50 min. Both well within D-23's $1.50-2.00 / ≤60 min budgets.

## Content-Mismatch Verifier Prompt Design

D-03 specifies semantics: "Are these two images of the same specific product?" The crucial difference from Phase 15's verifier is that Phase 15 returns `match=true` for "both hoodies" — Phase 16 must return `match=false` if it's a hoodie from a different brand.

### Recommended prompt

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
- "same Bella+Canvas 6110 t-shirt, different color"  → match=true
- "candidate is Gildan hoodie, reference is Adidas hoodie" → match=false
- "candidate is baby onesie, reference is adult t-shirt" → match=false
- "same crewneck sweatshirt, candidate has model wearing it" → match=true`;
```

### Why color-blind by default (per Claude's Discretion)

A supplier canonical for pid 6110 might be "White" while the BR FrontImage is "Heather Forest" of the same Bella 6110 t-shirt — both are correct, just different color variants. Flagging color differences would produce massive false-positive volume. The verifier learns "ignore color, compare style/brand/cut" from the explicit examples in the prompt.

### Few-shot examples (already inlined above)

Verified that few-shot inline in the system prompt is preferred over multi-turn for gpt-4o-mini Vision (`response_format: {type:'json_object'}` works only with single-turn).

### Implementation pattern

Mirror `verifyGarmentTypeMatch` exactly — same OpenAI client signature, same JSON-mode response, same fallback behavior:

```typescript
export interface VerifySameProductResult {
  match: boolean;
  reason: string;
}

export async function verifySameProduct(
  client: OpenAI,
  candidateBuffer: Buffer,
  referenceBuffer: Buffer,
): Promise<VerifySameProductResult> {
  try {
    const candidateB64 = candidateBuffer.toString('base64');
    const referenceB64 = referenceBuffer.toString('base64');
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SAME_PRODUCT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Candidate (BR image being audited):' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${candidateB64}`, detail: 'low' } },
            { type: 'text', text: 'Reference (supplier canonical):' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${referenceB64}`, detail: 'low' } },
          ],
        },
      ],
    });
    // ...parse + fallback identical to verifyGarmentTypeMatch
  } catch (err) {
    logger.warn(`[verify-same-product] failed: ${err}`);
    return { match: true, reason: 'verifier api error fallback' };
  }
}
```

**Critical:** Same false-accept-on-error policy as Phase 15. Cost of a false-accept = one wrong image stays one more cycle. Cost of a false-reject = spending Tier 1 budget on something already correct.

### Verifier-after-fix prompt (D-17)

The verifier-after-fix step uses the SAME `verifySameProduct` prompt:

- If replacing FrontImage: candidate = new image from supplier, reference = supplier canonical → trivially match (same source). **Worth NOT calling verify here — it's a tautology and wastes API budget. Just trust the supplier API response.**
- If replacing Back/Side/Model: candidate = new image, reference = current FrontImage (assumed correct unless Tier 1 fixed Front earlier in this pid's run — in which case use newly-fixed Front).
- If Tier 2 AI regen produced Back/Side: Phase 15's `generateGarmentView` ALREADY runs `verifyGarmentTypeMatch` internally (strict AND filter, line 392) — the output is verifier-passing by construction. **No second verifier call needed for Tier 2.**

**Recommendation:** Only invoke `verifySameProduct` as the verifier-after-fix when:

- Tier 1 replaces a Back/Side/Model column (the supplier canonical for these may not match the front exactly; e.g., a model image is a different angle).
- Tier 3 manual CLI receives a new fileId/URL from operator (always — operator might paste the wrong link).

## Manual CLI UX Pattern (readline scaffold + commit timing)

No interactive CLI library exists in `package.json`. Use Node built-in `readline`. The pattern:

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

async function handleManualRow(row: ManualQueueRow): Promise<void> {
  console.log(`\n--- pid: ${row.pid} (${row.pollution_class}) ---`);
  console.log(`  Affected columns: ${row.affected_columns}`);
  row.affected_drive_urls.split(',').forEach(url => console.log(`  ${url}`));
  if (row.expected_supplier_url) console.log(`  Supplier canonical: ${row.expected_supplier_url}`);

  const choice = await promptForChoice(
    '[r]eplace | [s]kip | [a]ccept-as-is | [d]elete | [v]iew | [q]uit: ',
    ['r', 's', 'a', 'd', 'v', 'q'],
  );

  if (choice === 'r') {
    const newUrl = (await rl.question('New URL or fileId: ')).trim();
    const newFileId = extractFileId(newUrl) ?? newUrl;
    // Download candidate; download SoT front; run verifier-after-fix
    const candidateBuf = await downloadFromDrive(drive, newFileId);
    const sotBuf = await downloadFromDrive(drive, extractFileId(row.current_front_url)!);
    const verifierResult = await verifySameProduct(openai, candidateBuf, sotBuf);
    if (!verifierResult.match) {
      const retry = await promptForChoice(
        `Verifier rejected: ${verifierResult.reason}. [r]etry | [s]kip | [f]orce (requires typing FORCE): `,
        ['r', 's', 'f'],
      );
      if (retry === 'f') {
        const forceConfirm = await rl.question('Type FORCE to confirm: ');
        if (forceConfirm.trim() !== 'FORCE') return; // abort
      } else {
        // log MANUAL_SKIP, do not commit
        await appendTrailRow({...row, operation: 'MANUAL_SKIP', notes: 'verifier rejected and operator skipped'});
        return;
      }
    }
    // commit: BR cell write + trail row (VERIFIER_PASS first, then BR_WRITE)
    await appendTrailRow({pid: row.pid, operation: 'VERIFIER_PASS', column_or_path: row.affected_columns, old_value: row.current_url, new_value: newUrl, tier: 3, ...});
    await writeUpdates(sheets, spreadsheetId, [{range: row.cell_range, values: [[newUrl]]}]);
    await appendTrailRow({pid: row.pid, operation: 'BR_WRITE', column_or_path: row.affected_columns, old_value: row.current_url, new_value: newUrl, tier: 3, ...});
  } else if (choice === 'd') {
    const confirm = await rl.question('Type DELETE to confirm: ');
    if (confirm.trim() !== 'DELETE') return; // abort
    // blank the BR cell + trash Drive file
    await writeUpdates(sheets, spreadsheetId, [{range: row.cell_range, values: [['']]}]);
    await appendTrailRow({pid: row.pid, operation: 'BR_WRITE', old_value: row.current_url, new_value: '', tier: 3, ...});
    await trashDriveFile(drive, extractFileId(row.current_url)!);
    await appendTrailRow({pid: row.pid, operation: 'DRIVE_DELETE', column_or_path: extractFileId(row.current_url)!, tier: 3, ...});
  } else if (choice === 's') {
    await appendTrailRow({pid: row.pid, operation: 'MANUAL_SKIP', tier: 3, ...});
  } else if (choice === 'a') {
    await appendTrailRow({pid: row.pid, operation: 'MANUAL_ACCEPT', tier: 3, ...});
  } else if (choice === 'v') {
    // Print full pid context (all 6 columns, all colors)
    // then re-prompt this row
    return handleManualRow(row);
  } else if (choice === 'q') {
    rl.close();
    process.exit(0);
  }
}
```

### Trail-row commit timing

**Strict ordering invariant** (per D-15 idempotent re-runs):

1. Operator confirms action (e.g., `r` + new URL + verifier passes).
2. Append `VERIFIER_PASS` row to trail TSV. **fsync.**
3. Mutate Drive / BR.
4. Append `BR_WRITE` row to trail TSV. **fsync.**
5. (Optional) Append `DRIVE_DELETE` row if old file trashed.

If the script crashes between steps 2 and 3, the trail will show a `VERIFIER_PASS` without a follow-up `BR_WRITE`. On resume, the trail-reader sees pid in `verified-but-not-written` state and re-presents the pid (the operator manually re-enters their choice).

If the script crashes between steps 3 and 4, BR/Drive is mutated but trail doesn't record it. The next audit re-run will see the corrected cell and **not** flag pollution — so resume is safe; the pid is silently considered resolved.

**Per D-15:** "Each operation row is written + fsync'd before continuing to the next, so a mid-pid crash loses at most one in-flight operation." Match this by ensuring `appendTrailRow` uses `fs.fsyncSync(fd)` after `appendFileSync`. (Current `appendRejectRow` uses `appendFileSync` only — no fsync. Phase 16's trail writer SHOULD upgrade to explicit fsync per D-15.)

## Resume-from-Trail Design (data structures + invariants)

### Startup procedure

```typescript
async function loadProcessedPids(trailPath: string): Promise<Set<string>> {
  if (!existsSync(trailPath)) return new Set();
  const content = readFileSync(trailPath, 'utf8');
  const lines = content.split('\n').slice(1); // drop header
  const processed = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const pid = cols[1]; // pid is column 1 in trail schema
    const operation = cols[2];
    // Only "terminal" operations mark a pid as fully processed.
    // BR_WRITE = success. MANUAL_SKIP, MANUAL_ACCEPT = explicit operator decision.
    if (['BR_WRITE', 'MANUAL_SKIP', 'MANUAL_ACCEPT'].includes(operation)) {
      processed.add(pid);
    }
  }
  return processed;
}
```

### Invariants

| Invariant | How enforced |
|-----------|--------------|
| Trail file is append-only | Use `fs.appendFileSync` exclusively; never `writeFileSync` after the header. The audit script writes the header on file-creation; all other writers `appendFileSync`. |
| Trail row is written before next BR mutation | Strict sequencing in code; per-row helper `appendTrailRow` returns Promise<void> and callers `await` it before next BR/Drive call. |
| Trail row sync'd to disk | After `appendFileSync`, call `fs.openSync(path, 'a')` + `fs.fsyncSync(fd)` + `fs.closeSync(fd)`. |
| Idempotent re-run | At startup, load `processedPids`; skip any pid in the set. New rows for already-processed pids never write. |
| Per-pid concurrency-safe | D-20 says "sequential per-pid within each tier; parallel across tiers". Since tier-internal sequencing is preserved AND tiers don't overlap (D-21), trail writes from different tiers never collide on the same pid. If D-20's optional 3-5 parallel requests within Tier 1 is used, wrap `appendFileSync` in a process-local mutex (e.g., a single Promise chain). |

### Reading order

The trail is processed by:

1. The audit script (only to populate `processed_pids` at startup).
2. The fix scripts (Tier 1, 2, 3) — each loads `processed_pids` and skips them.
3. The re-audit `--re-audit` step (loads trail to verify every original-pid has at least one `BR_WRITE`).

## Validation Architecture (Nyquist Dim 8 evidence map)

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (verified — see Phase 15 test files in `tests/lib/`, `tests/scripts/`) |
| Config file | `vitest.config.*` (not opened; assumed standard) |
| Quick run command | `npx vitest run tests/lib/{file}.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| R1 | Audit produces TSV with all 3 pollution classes (4 with invalid_format extension) | unit + integration | `npx vitest run tests/scripts/audit-image-pollution.test.ts` | ❌ Wave 0 |
| R2 | Audit reads all 6 image columns | unit | `npx vitest run tests/scripts/audit-image-pollution.test.ts -t "6 columns"` | ❌ Wave 0 |
| R3 | Tier 1 supplier-fetch + verifier-after-fix | unit (mocked openai + mocked supplier API) | `npx vitest run tests/scripts/fix-image-pollution-tier1.test.ts` | ❌ Wave 0 |
| R4 | Tier 2 AI regen invokes generateGarmentView with strict AND filter | unit (mocked openai) | `npx vitest run tests/scripts/fix-image-pollution-tier2.test.ts` | ❌ Wave 0 |
| R5 | Manual CLI prompts r/s/a/d/v/q correctly | unit (mocked readline) | `npx vitest run tests/scripts/fix-image-pollution-manual.test.ts` | ❌ Wave 0 |
| R6 | Phase BLOCKS when manual_queue_size > 20 | unit | `npx vitest run tests/scripts/audit-image-pollution.test.ts -t "queue overflow"` | ❌ Wave 0 |
| R7 | Trail TSV row schema correct | unit | `npx vitest run tests/lib/image-pollution-trail.test.ts` | ❌ Wave 0 |
| R8 | Safety rail: no Drive delete without verifier-confirmed pollution | unit | `npx vitest run tests/scripts/fix-image-pollution-manual.test.ts -t "safety rail R8"` | ❌ Wave 0 |
| R9 | Safety rail: verifier-fail cascades, no BR write | unit | `npx vitest run tests/scripts/fix-image-pollution-tier1.test.ts -t "safety rail R9"` | ❌ Wave 0 |
| R10 | Re-audit returns 0 polluted pids after fix | manual-only (E2E real-API) | `npx tsx scripts/audit-image-pollution.ts --re-audit` | ❌ Wave 0 |
| R11 | Resolution = BR_WRITE with new!=old | unit | `npx vitest run tests/lib/image-pollution-trail.test.ts -t "R11 resolution"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/{lib|scripts}/<modified>.test.ts`
- **Per wave merge:** `npx vitest run tests/lib/ tests/scripts/`
- **Phase gate:** Full suite green (`npx vitest run`) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/lib/image-pollution-trail.test.ts` — covers R7, R11
- [ ] `tests/lib/supplier-canonical.test.ts` — verifies S* → S&S resolution, L* → CSW resolution, allowlist → KNOWN_SUPPLIER_PREFIXES, unknown → no_canonical_available
- [ ] `tests/lib/verify-same-product.test.ts` — mocked OpenAI; covers happy path, mismatch path, error fallback (returns match=true)
- [ ] `tests/scripts/audit-image-pollution.test.ts` — covers R1, R2, R6 (DI seam pattern from `audit-garment-types.test.ts`)
- [ ] `tests/scripts/fix-image-pollution-tier1.test.ts` — covers R3, R9
- [ ] `tests/scripts/fix-image-pollution-tier2.test.ts` — covers R4
- [ ] `tests/scripts/fix-image-pollution-manual.test.ts` — covers R5, R8 (mock `readline` via DI)
- [ ] No framework install needed — vitest already in `package.json` (per Phase 15 work).

## Empirical Audit Data Summary (from `tmp/full-audit-2026-05-12.log`)

**Audit status at research time:** STILL RUNNING. Process PID 22984 (npx tsx audit-garment-types.ts --all against `Bestsellers-Ready`). Log was 81 lines at last check.

**Mismatch counts so far:**

- **30 MISMATCH lines** (Pass 3 shape-drift on already-uploaded back/side)
- **48 "unsupported image format" Vision API 400 errors** — these are `verifyGarmentTypeMatch` failures, NOT mismatches. They get the false-accept fallback (`match: true`), so they're NOT in the rejects-tsv. They DO represent a 4th pollution class Phase 16 should detect structurally.
- **3 "invalid FrontImage" skips** (L00870, H08355, L01210 — empty front cells)

**Class breakdown of the 30 MISMATCHes (from rejects-tsv):**

| pid | view | class observed | notes |
|-----|------|----------------|-------|
| CE520L | side | front=polo, candidate=hoodie/jacket | repeats — likely shape drift class |
| NE220 | side | front=polo, candidate=jacket | |
| H08010, H08012, H08050, H08200, H08205 | side or back | beanie vs garment | **HEADWEAR — exempted by D-22** |
| L00693 | side | front=jacket, candidate=crewneck | discontinued color (documented in Phase 15 SUMMARY) |
| 6110 | back/side | front=apron, candidate=t-shirt | **content-mismatch** (image is an apron, but 6110 is a Bella 6110 t-shirt) — this is the case mentioned in CONTEXT.md |
| 1510 | back/side | front=apron, candidate=t-shirt | similar to 6110 — Front column IS the polluted column |
| A231 | back/side | front=hoodie, candidate=pants/polo | content+shape mismatch |
| A267 | back | front=jacket, candidate=crewneck | shape drift |
| 6014161 | back | different views of a hat | edge case — likely headwear-like |

**Clusters:**

1. **Headwear cluster** (H08010, H08012, H08050, H08200, H08205) — ~5 pids × ~6 mismatches = 30% of all mismatches. SCOPED OUT per D-22.
2. **CE520L + NE220** (polo↔jacket/hoodie) — same pollution pattern across two pids. Likely fileId collision (D-01 Pass 1 candidate) or both products mis-imaged independently.
3. **6110 + 1510** (apron in t-shirt slot) — content-mismatch on the FrontImage itself. Both are Bella + Canvas / Next Level numeric pids — covered by `KNOWN_SUPPLIER_PREFIXES` but NEED a scraper to fetch the canonical t-shirt image.
4. **L00693** — discontinued-color cluster documented in Phase 15.
5. **A231 + A267** — Adidas A-prefix; no scraper currently exists for Adidas.

**Mismatch rate:** 30 shape-drift hits across ~25 unique pids (some pids repeat) out of ~430 non-headwear pids scanned so far ≈ **~5.8% shape-drift base rate on Pass 3**.

**Expected manual queue size (R6 cap = 20):**

- Pass 1 shared_url hits: ~5-10 pids (the 8882=5200=CE520L=NE220 fileId collisions per CONTEXT specifics)
- Pass 1 invalid_image_format hits: ~5-15 pids (48 Vision 400 errors but likely concentrated in <15 distinct pids)
- Pass 2 content_mismatch hits: ~5-10 pids (6110, 1510, the wrong-product cluster)
- Pass 2 model_pollution hits: ~3-5 pids (8882 ModelImage being A2009 + similar)
- Pass 3 shape_drift hits: ~15-20 pids (from current audit run; ~25 unique pids minus headwear)

**Total before tier resolution:** ~35-60 polluted pids.

**Tier coverage estimate:**

- Tier 1 (supplier fetch) resolves: S* + L* covered (~50% of polluted pids likely). Without D-12 expansion, BELLA + Gildan + Next Level numeric pids cannot be resolved by Tier 1 → cascade to manual.
- Tier 2 (AI regen) resolves: shape_drift only (~15-20 pids). Highly likely to resolve since the regen pipeline already has the verifier in line.
- Tier 3 (manual): residual.

**Risk:** Tier 3 size before D-12 expansion may be 15-25 pids — borderline on R6 cap (≤20). Operator/planner should expect Phase 16's first audit to potentially hit R6 BLOCKED-QUEUE-OVERFLOW, triggering a Tier 1 scraper expansion sub-plan.

**Mitigation in plan:** Build the audit + Tier 2 first (deterministic). Run audit + Tier 2. Then count manual_queue_size. If > 20, add Bella scraper before Tier 1 — verified path per D-12.

## Recommended Extension: invalid_image_format as 4th Pass 1 class

The live audit log shows 48 "You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp']" warnings from OpenAI Vision. Each represents a BR image cell whose Drive file is in a format Vision cannot ingest — most likely PDF (size-charts mis-uploaded into an image cell) or some other binary masquerading as an image.

**Detection:** Call `drive.files.get({fileId, fields: 'mimeType, size, name'})` and check `mimeType ∉ {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}`. **Zero cost** (Drive metadata is free) and **structurally detectable** (no AI needed).

**Recommendation:** Add to Pass 1 as the fourth class:

```typescript
type PollutionClass =
  | 'shared_url'           // D-01
  | 'invalid_image_format' // NEW — recommended Phase 16 extension
  | 'content_mismatch'     // D-03 (Pass 2)
  | 'shape_drift'          // D-06 (Pass 3)
  | 'model_pollution';     // D-05 (Pass 2)
```

**Tier routing:** `invalid_image_format` always lands in Tier 1 (supplier re-fetch) for supplier-mapped pids, or Tier 3 manual for unmapped. The fix is the same: replace the broken file with a valid image.

This finding is empirical (counted in the live log), not speculative.

## Architecture Patterns

### System Architecture Diagram

```
Operator command
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ scripts/audit-image-pollution.ts                          │
│                                                           │
│  1. Read Bestsellers-Ready raw (sheets.values.get)        │
│  2. Resume: load processed_pids from existing trail TSV   │
│  3. Pass 1 (structural):                                  │
│     - Build fileId→Set<pid> map → shared_url flags        │
│     - Drive metadata HEAD → invalid_image_format flags    │
│  4. Pass 2 (AI content):                                  │
│     - supplier-canonical.resolve(pid) →                   │
│       S* → fetch-ss-images-fixed code (S&S REST)          │
│       L* → scrape-csw-product code (CSW Shopify CDN)      │
│       other → KNOWN_SUPPLIER_PREFIXES → no_canonical      │
│     - verify-same-product (gpt-4o-mini, color-blind)      │
│  5. Pass 3 (AI shape): verifyGarmentTypeMatch (Phase 15)  │
│  6. Write tmp/image-pollution-audit-{date}.tsv            │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────┐
│ scripts/fix-image-pollution-tier1.ts    │
│                                         │
│ For each pid with Tier 1 recommendation:│
│   1. Fetch supplier canonical           │
│   2. Verifier-after-fix (if back/side)  │
│   3. uploadToDrive (update-in-place)    │
│   4. writeUpdates (BR cell)             │
│   5. trail.append(VERIFIER_PASS,        │
│                   DRIVE_UPLOAD,         │
│                   BR_WRITE)             │
└─────────────────┬───────────────────────┘
                  │ (sequential — D-21)
                  ▼
┌─────────────────────────────────────────┐
│ scripts/fix-image-pollution-tier2.ts    │
│                                         │
│ For each pid with Tier 2 recommendation:│
│   1. Download current front             │
│   2. generateGarmentView (Phase 10 +    │
│      Phase 15 verifier in-line)         │
│   3. standardizeImage (Phase 11)        │
│   4. uploadToDrive (NEW filename)       │
│   5. writeUpdates (BR cell)             │
│   6. trail.append(AI_REGEN, DRIVE_UPLOAD│
│                   BR_WRITE)             │
└─────────────────┬───────────────────────┘
                  │ (sequential — D-21)
                  ▼
            ┌─────────────┐
            │ Check R6:   │
            │ count Tier3 │
            │ ≤ 20?       │
            └──┬───────┬──┘
        yes ◀──┘       └──▶ no → BLOCKED-QUEUE-OVERFLOW
        │                       (re-plan: add scrapers per D-12)
        ▼
┌─────────────────────────────────────────┐
│ scripts/fix-image-pollution-manual.ts   │
│                                         │
│ Interactive readline loop:              │
│   For each row in manual queue:         │
│     prompt r/s/a/d/v/q                  │
│     on r: verifier-after-fix + BR write │
│     on d: DELETE confirm + trash Drive  │
│     on s/a: trail.append(MANUAL_*)      │
│     on q: persist progress; exit        │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ scripts/audit-image-pollution.ts        │
│   --re-audit                            │
│                                         │
│ Re-run Passes 1-3 over post-fix BR.     │
│ R10 check: 0 polluted pids?             │
│   yes → phase closes                    │
│   no  → reset to manual queue           │
└─────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/lib/
├── image-pollution-trail.ts    # NEW — generalized appendTrailRow
├── supplier-canonical.ts       # NEW — pid → canonical URL resolver
├── verify-same-product.ts      # NEW — Pass 2 verifier (sibling to verifyGarmentTypeMatch)
├── ai-image-generator.ts       # existing — Phase 15 verifyGarmentTypeMatch + Phase 10 generateGarmentView
├── rejects-tsv.ts              # existing — keep untouched
└── ...

src/sheets/
├── drive.ts                    # MODIFIED — add downloadFromDrive, trashDriveFile, getDriveFileMetadata, extractFileId helpers
└── ...

scripts/
├── audit-image-pollution.ts    # NEW — 3-pass audit with --re-audit, --pid, --dry-run, --post-mortem flags
├── fix-image-pollution-tier1.ts # NEW
├── fix-image-pollution-tier2.ts # NEW
├── fix-image-pollution-manual.ts # NEW
└── ...
```

### Pattern: DI seam for testability (verbatim from Phase 15)

Mirror `RunGarmentTypeAuditDeps` exactly. Add new deps:

```typescript
export interface RunImagePollutionAuditDeps {
  args: RunImagePollutionAuditArgs;
  sheetsClient: unknown;
  driveClient: drive_v3.Drive;
  openai: OpenAI;
  // readers
  readRawRowsFn: (range: string) => Promise<string[][]>;
  // network
  downloadImageFn: typeof downloadImage;
  downloadFromDriveFn: typeof downloadFromDrive;
  getDriveFileMetadataFn: typeof getDriveFileMetadata;
  // verifiers
  verifyShapeFn: typeof verifyGarmentTypeMatch;
  verifySameProductFn: typeof verifySameProduct;
  // resolvers
  supplierCanonicalFn: typeof resolveSupplierCanonical;
  // trail
  appendTrailRowFn: typeof appendTrailRow;
  // constants
  spreadsheetId: string;
  sheetName: string;
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAI Vision client | Custom HTTP | `OpenAI` SDK + `chat.completions.create` (pattern in `ai-image-generator.ts:138-154`) | Auth + retries + streaming all handled |
| Drive auth + scopes | Custom service-account flow | `createDriveClient()` in `src/sheets/drive.ts` | Existing |
| Sheet batch update | Custom REST calls | `writeUpdates()` in `src/sheets/writer.ts` | Chunks + RAW input + auth all handled |
| S&S API rate limiting | Custom queue | The 1.1s sleep pattern in `fetch-ss-images-fixed.ts:RATE_LIMIT_MS` | Already proven against 60-req/min limit |
| CSW scraping | Custom HTML parsing | `scrapeCSW()` in `scripts/scrape-csw-product.ts` | Already returns `images: CSWImage[]` with CDN URLs |
| Interactive prompts | Use `inquirer` / `prompts` | Node built-in `readline.createInterface()` + `rl.question()` | Zero deps; sufficient for ≤20 rows |
| TSV append + sanitize | Custom string ops | Pattern from `rejects-tsv.ts:79-93` | Header-on-first-write + sanitize collapse + non-throwing all handled |
| Verifier prompt structure | Multi-turn / agents | Single-turn `response_format: {type:'json_object'}` (verifyGarmentTypeMatch pattern) | gpt-4o-mini JSON mode works only with single-turn |
| Cell address conversion | Manual base-26 | `columnToLetter()` in `src/sheets/column-map.ts:11-19` | Existing |

## Common Pitfalls

### Pitfall 1: SheetRow type is missing Model* columns

**What goes wrong:** Code that uses `readAllRows` and accesses `row.ModelFrontImage` silently returns undefined — the row object has only the 38 typed fields, none of which are model images. Audit produces zero model_pollution hits because the columns are never read.

**Why:** `src/sheets/types.ts:5-45` (SheetRow) and `:51-91` (SHEET_COLUMNS) don't list model columns. The BR sheet has them as columns AN/AO/AP, but the typed reader doesn't know about them.

**How to avoid:** Use raw sheet reads (`sheets.spreadsheets.values.get`) and index by header position — verified pattern in `scripts/fetch-ss-images-fixed.ts:77-86`. Do NOT use `readAllRows` for Phase 16's audit script.

**Warning sign:** If `tmp/image-pollution-audit-*.tsv` has zero `model_pollution` rows on a fresh full-audit run, the model columns are being skipped.

### Pitfall 2: Drive update-in-place destroys the old fileId

**What goes wrong:** Operator (or fix script) attempts to "delete and re-upload" a Drive file by trashing `oldFileId` and uploading with the same filename. `uploadToDrive` returns the SAME fileId via `drive.files.update` — the trashed file is the only copy.

**Why:** `src/sheets/drive.ts:104-125` — when a file with the same filename exists in the target folder, it does `drive.files.update` and returns the existing fileId, NOT a new one. Trashing the original = trashing your output.

**How to avoid (CRITICAL, per user memory):** Before `uploadToDrive` + trash sequence, compare `origFileId` vs the returned `newFileId`. If they're equal, do NOT trash. If different (new filename), only THEN trash the old.

**Warning sign:** Drive folder appears empty after a tier-1 fix run.

### Pitfall 3: Phase 15 verifier's family-coarse semantics miss content mismatch

**What goes wrong:** `verifyGarmentTypeMatch` returns `match=true` for "both are t-shirts" — even if one is a Bella 6110 t-shirt and the other is a baby onesie t-shirt. The content_mismatch class (D-03's "same SPECIFIC product?") is NOT detectable by Phase 15's verifier.

**Why:** Phase 15's prompt explicitly defines family as `tops | hoodies | polos | crewnecks | jackets`. "T-shirt" and "onesie" both map to `tops`.

**How to avoid:** Build `verifySameProduct` (Phase 16 new) with a stricter prompt as designed above. Use it for Pass 2; reuse Phase 15's `verifyGarmentTypeMatch` ONLY for Pass 3.

**Warning sign:** 6110 case (apron in FrontImage slot for a t-shirt pid) doesn't surface as content_mismatch in Pass 2 audit output.

### Pitfall 4: Color drift causing false content_mismatch positives

**What goes wrong:** BR FrontImage is "Heather Forest" of pid 6110; supplier canonical is "White". Verifier reports `match=false` because colors differ. Phase 16 spuriously flags 200+ pids.

**How to avoid:** Color-blind verifier prompt (Claude's Discretion item) — explicit in the system prompt with `same Bella+Canvas 6110 t-shirt, different color → match=true` example. Verify on the bad fixtures from Phase 15 (`5200`, `8882`, `6110`) before doing full audit.

**Warning sign:** Audit reports `content_mismatch` rate >40%.

### Pitfall 5: Tier-1 supplier API rate limits cause cascading retries

**What goes wrong:** S&S Canada at 60 req/min × ~150 S* pids × 2 calls each (resolve + fetch) = ~5 min minimum. If the script retries on 503 without backoff, the rate window never recovers.

**How to avoid:** Reuse the existing `RATE_LIMIT_MS = 1100` pattern from `fetch-ss-images-fixed.ts:20` (1.1s between calls). On 503, sleep 10s and retry once (pattern in `fetch-model-images.ts:46-56`).

**Warning sign:** SS API returns 429/503 mid-run; trail TSV shows hundreds of SUPPLIER_FETCH failures.

### Pitfall 6: Vision API 400 on non-image Drive files

**What goes wrong:** A BR image cell points to a PDF (size-chart mis-uploaded) or some other binary. Both Pass 2 and Pass 3 call Vision; both fail with HTTP 400. The fallback returns `{match: true}` — so the pollution is silently accepted and the pid passes audit clean.

**How to avoid:** Pass 1's `invalid_image_format` detection (recommended extension). MIME-check via Drive metadata BEFORE any Vision call. If mimeType is non-image, flag and skip both Pass 2 and Pass 3 for that image (route to Tier 1 or Tier 3).

**Warning sign:** `tmp/full-audit-*.log` contains "unsupported image" warnings but the rejects-tsv has zero rows for those pids.

### Pitfall 7: Headwear pids (H08*) still appear in audit

**What goes wrong:** D-22 says H08* skipped silently. If Pass 1's shared-URL scan doesn't filter H08* first, headwear pids can appear in shared_url collisions (e.g., H08200 sharing a Drive file with another headwear pid).

**How to avoid:** Apply the H08* filter at the START of every pass, before any class detection. Increment `headwear_skipped_count` once per pid (not once per pass).

**Warning sign:** Audit TSV has H08* rows.

### Pitfall 8: Resume-from-trail re-presents a row the operator already handled

**What goes wrong:** Operator presses `s` (skip) on a row. Trail logs `MANUAL_SKIP`. Operator quits. Resume happens later. The skip operation IS in the trail, so the pid should be in `processed_pids`. But if `processed_pids` only counts `BR_WRITE` (treating skip as not-processed), the row is presented again.

**How to avoid:** `loadProcessedPids` MUST include `MANUAL_SKIP` and `MANUAL_ACCEPT` as terminal-for-this-run operations (an operator deferred = explicit decision). To re-process a deferred pid, the operator restarts the script with a fresh trail file or `--reset-deferred`.

**Warning sign:** Operator complains the same pid keeps showing up.

## Runtime State Inventory

Phase 16 is a tooling addition + audit + fix run; no rename/refactor/migration. Skip this section (no runtime state to migrate).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (project default) | All scripts | ✓ (existing) | v24.x (per Phase 14 notes about TLS) | — |
| `OPENAI_API_KEY` env | Pass 2, Pass 3, verifier-after | (operator-provided) | — | Cannot proceed without — Phase 16 is fundamentally AI-driven |
| `SS_ACCOUNT_NUMBER` + `SS_API_KEY` | Tier 1 S&S supplier fetch | (operator-provided per Phase 9 setup) | — | Skip S* tier-1; route to Tier 3 manual |
| `GOOGLE_SPREADSHEET_ID` / SERVICE_ACCOUNT_EMAIL / PRIVATE_KEY | All sheet + Drive ops | (operator-provided) | — | Cannot proceed |
| OpenAI SDK (`openai`) | Verifiers | ✓ (package.json — verified via Phase 15 imports) | (whatever Phase 15 pinned) | — |
| `googleapis` | Sheets + Drive | ✓ (verified — used throughout `src/sheets/`) | — | — |
| `sharp` | Image standardization in Tier 2 | ✓ (verified) | — | — |
| `cheerio` | CSW scraper | ✓ (verified — `scripts/scrape-csw-product.ts:11`) | — | — |
| `NODE_OPTIONS=--use-system-ca` | Google OAuth on Node v24 (Phase 14 issue) | (operator must set per invocation) | — | Wrap scripts to detect + warn if absent |

**Critical:** `NODE_OPTIONS=--use-system-ca` is mandatory on Node v24 to avoid `UNABLE_TO_VERIFY_LEAF_SIGNATURE` against `oauth2.googleapis.com`. Phase 16 plan should bake this into the operator runbook (just like Phase 14 did).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (Google service account, S&S Basic auth, OpenAI bearer) | env vars only; verified — no hardcoded creds |
| V3 Session Management | no | (no user sessions; CLI script) |
| V4 Access Control | yes | Service account scope `drive` (read+write); BR sheet edit scope (existing); operator runs the CLI from a controlled machine |
| V5 Input Validation | yes | TSV-injection via reason field (already handled by `sanitize` in `rejects-tsv.ts:63-65` — collapse `[\t\n\r]+` to single space); URL injection on manual CLI input (validate via `extractFileId` + URL parser before any Drive call) |
| V6 Cryptography | no | (no new crypto; relies on Google + OpenAI TLS) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Operator pastes a malicious URL into the CLI replace prompt → script downloads attacker payload | Tampering | Validate URL is `drive.google.com/uc?id=...` OR `drive.google.com/file/d/...` (use `extractFileId`); reject all other schemes |
| LLM response injects tab/newline into reason field → corrupts TSV | Tampering | `sanitize()` already collapses `[\t\n\r]+` (existing in `rejects-tsv.ts`) |
| Drive service account credentials leaked via debug log | Information Disclosure | Logger MUST NOT log env var values; verified `src/lib/logger.ts` behavior (no creds in any project log) |
| Force-confirm bypass (operator types `FORCE` accidentally) | Repudiation | Require typing the literal `FORCE` (not `force` lowercase); show a `[y/N]` style preview of intended action before commit |
| Resume-from-trail reads a tampered trail TSV that omits a real BR_WRITE row | Tampering | Trail is local file; if compromised, operator can clean re-audit. Out of scope for this phase — physical-machine threat model. |

## Code Examples

### Pattern: Read raw BR with header-position indexing

```typescript
// Source: scripts/fetch-ss-images-fixed.ts:72-86 (verified)
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

for (let i = 1; i < rows.length; i++) {
  const pid = String(rows[i][pidIdx] ?? '').trim();
  const front = String(rows[i][frontIdx] ?? '').trim();
  // ... etc
}
```

### Pattern: Atomic single-cell update

```typescript
// Source: scripts/fetch-ss-images-fixed.ts:167-170 (verified)
const updates: Array<{ range: string; values: string[][] }> = [];
const rn = i + 1; // 1-indexed row number
updates.push({
  range: `'Bestsellers-Ready'!${columnToLetter(idx)}${rn}`,
  values: [[newUrl]],
});

await writeUpdates(sheets, spreadsheetId, updates);
```

### Pattern: Extract fileId from Drive URL

```typescript
// Source: scripts/fetch-fixture-binaries.ts:42-49 (verified)
function extractFileId(url: string): string | null {
  if (!url) return null;
  const ucMatch = url.match(/[?&]id=([\w-]{20,})/);
  if (ucMatch) return ucMatch[1];
  const fileMatch = url.match(/\/file\/d\/([\w-]{20,})/);
  if (fileMatch) return fileMatch[1];
  return null;
}
```

### Pattern: Download Drive file by fileId to Buffer

```typescript
// Source: scripts/fetch-fixture-binaries.ts:51-58 (verified)
async function downloadFromDrive(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(response.data as ArrayBuffer);
}
```

### Pattern: Get Drive metadata (mimeType for Pass 1)

```typescript
async function getDriveFileMetadata(drive: drive_v3.Drive, fileId: string) {
  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size',
    supportsAllDrives: true,
  });
  return response.data;
}
```

### Pattern: Trash a Drive file (soft delete)

```typescript
// Source: scripts/dedupe-drive-duplicates.ts (verified pattern)
async function trashDriveFile(drive: drive_v3.Drive, fileId: string): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}
```

### Pattern: gpt-4o-mini Vision verifier (template for verifySameProduct)

```typescript
// Source: src/lib/ai-image-generator.ts:129-181 (verified — Phase 15 verifier)
const response = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  max_tokens: 100,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Candidate:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64A}`, detail: 'low' } },
        { type: 'text', text: 'Reference:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64B}`, detail: 'low' } },
      ],
    },
  ],
});
// Parse + fallback: JSON.parse(raw) inside try/catch; on parse fail, regex-extract {...};
// on outer catch, return { match: true, reason: 'verifier api error fallback' }.
```

### Pattern: Resumable trail with fsync

```typescript
// Source: pattern derived from src/lib/rejects-tsv.ts:79-93 (with D-15 fsync upgrade)
import { existsSync, appendFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'fs';

const TRAIL_HEADER = 'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\tnotes\n';

function sanitize(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ');
}

export async function appendTrailRow(row: TrailRow, trailPath: string): Promise<void> {
  const line = [
    row.timestamp_iso,
    row.pid,
    row.operation,
    sanitize(row.column_or_path ?? ''),
    sanitize(row.old_value ?? ''),
    sanitize(row.new_value ?? ''),
    String(row.tier),
    sanitize(row.notes ?? ''),
  ].join('\t') + '\n';

  try {
    if (!existsSync(trailPath)) {
      writeFileSync(trailPath, TRAIL_HEADER + line);
    } else {
      appendFileSync(trailPath, line);
    }
    // D-15 fsync upgrade — guarantee row hits disk before next operation
    const fd = openSync(trailPath, 'a');
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    logger.warn(`[image-pollution-trail] Failed to write row: ${err}`);
    // Non-throwing — trail is side-channel
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 15: family-coarse (`tops/hoodies/polos/crewnecks/jackets`) shape verifier | Phase 16: dual-mode — Phase 15 verifier reused for shape (Pass 3) + new `verifySameProduct` for content (Pass 2) | This phase | Two verifier prompts; same model; same cost profile |
| Phase 14: structural fileId collision check between Drive folder and pid prefix | Phase 16: identity collision check across BR rows (same fileId on different pids) | This phase | Catches a different bug class — same Drive file URL pasted into multiple BR rows |
| Phase 10: AI regen with strict AND (passesHue AND passesType) filter | Phase 16: invokes Phase 10 unchanged from Tier 2 | (already shipped Phase 15) | Phase 16 Tier 2 inherits all Phase 15 safety properties for free |
| `fetch-ss-images-fixed.ts` writes BR directly (single-script flow) | Phase 16 wraps it via `src/lib/supplier-canonical.ts` (re-callable from audit + fix) | This phase | Same underlying code, but accessible from new audit pipeline |

**Deprecated/outdated:**

- None. All Phase 14 + 15 patterns are current as of 2026-05-12.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Vitest is the project test framework | Validation Architecture | LOW — verified indirectly via Phase 15 test files; if wrong, plan needs to update commands |
| A2 | BR sheet has columns `ModelFrontImage`, `ModelSideImage`, `ModelBackImage` (raw header names) | R2, Pitfall 1 | LOW — verified via `scripts/fetch-ss-images-fixed.ts:83-85` reading these header names |
| A3 | Coverage estimate: ~50% of polluted pids are Tier-1-resolvable via S&S/CSW | Empirical Audit Data Summary | MEDIUM — depends on full audit outcome; if lower, Phase 16 hits R6 BLOCKED-QUEUE-OVERFLOW on first run, triggering D-12 scraper expansion. This is the EXPECTED replan path. |
| A4 | The 48 "unsupported image format" Vision 400s in `tmp/full-audit-2026-05-12.log` correspond to <15 unique BR pids | Empirical Audit Data Summary | MEDIUM — concentration likely (same broken file referenced by many size rows of one pid); even if distinct, all are Pass 1 detectable structurally |
| A5 | Tier 1 supplier API can resolve any pid in BR where the prefix matches `S*`, `L*`, or `KNOWN_SUPPLIER_PREFIXES` | Supplier Scraper Inventory | MEDIUM — verified for SS+CSW; the BELLA/Gildan/Next-Level allowlist is just for AUDIT filename matching, NOT scraping. A Bella scraper does NOT yet exist; pids `1010`, `3001`, `8882`, `6110`, etc. cannot be Tier-1-fixed without D-12 expansion. |
| A6 | OpenAI Vision JSON-mode (response_format json_object) works in single-turn with `detail: 'low'` images | Content-Mismatch Verifier Prompt Design | HIGH-CONFIDENCE-NOT-LISTED — Phase 15 verifier uses this exact pattern in production (verified `ai-image-generator.ts:140-142`) |
| A7 | `KNOWN_SUPPLIER_PREFIXES` mapping in `scripts/audit-product-imagery.ts` covers all current high-volume non-S/L pids in BR | Supplier Scraper Inventory | MEDIUM — likely accurate but unverified against full BR pid list at research time |
| A8 | Operator runs on a single machine (no concurrent fix script invocations) | Resume-from-Trail Design | LOW — Phase 16 is operator-driven; trail file's append-only design is robust to single-machine concurrency only |

**Verifier prompt design (Content-Mismatch Verifier section)** is `[ASSUMED]` in the sense that no Phase 16 fixture set has been built yet — the prompt is designed based on the empirical Phase 15 fixture results (6/6 good fixtures pass strict; 7/7 bad fixtures pass shape but are content-polluted). The plan's first task should curate a 3-5 pid Phase 16 fixture set (e.g., 6110, 8882, S05610-good, L00550-good) and validate the prompt's pass-rate BEFORE running the full audit.

## Open Questions

1. **Should Pass 2's verifier-after for FrontImage replacement compare new against supplier canonical (a tautology) or skip the verifier entirely?**
   - What we know: D-17 says verifier-after-fix is mandatory; for FrontImage SoT = supplier canonical.
   - What's unclear: If new = supplier canonical (which is the case when Tier 1 fetches from supplier), the comparison is supplier-vs-supplier-of-itself = trivially match. Wastes ~$0.0003 per pid.
   - Recommendation: Skip verifier-after when new came directly from supplier (semantically guaranteed). Document as a plan-time decision.

2. **What's the operator workflow if Tier 1 fetches a supplier canonical that the operator thinks is wrong?**
   - What we know: Tier 1 trusts the supplier API; the verifier-after is only meaningful for Back/Side/Model.
   - What's unclear: If the supplier API itself returns a wrong image (e.g., S&S has the wrong product mapped to a styleID), the fix overwrites BR with the wrong image. The audit doesn't catch this because the verifier-after is supplier-vs-supplier.
   - Recommendation: Tier 1 always writes a trail row with the supplier URL; operator can inspect the trail post-run to spot-check. Defer auto-detection of supplier-side errors.

3. **Should `invalid_image_format` be its own pollution class or folded into `content_mismatch`?**
   - What we know: It's structurally detectable (Drive mime check), free to detect, and represents ~48 Vision errors in the live audit.
   - What's unclear: D-08 specifies 4 classes (`shared_url | content_mismatch | shape_drift | model_pollution`). Adding `invalid_image_format` is a SPEC extension.
   - Recommendation: Surface to operator at plan-phase review. If accepted, becomes 5th class; otherwise fold into `content_mismatch` with notes='invalid_format'.

4. **Concurrency within Tier 1 — D-20 allows 3-5 parallel supplier calls. Worth the complexity?**
   - What we know: S&S rate limit is 60 req/min; sequential at 1.1s/call ≈ 55 req/min — already near saturation. CSW has no documented rate limit but throttled to 1s/call. Total Tier 1 runtime ~15 min for ~150 pids sequential.
   - What's unclear: If 3 parallel S&S calls, the 1.1s spacing must be per-process-not-per-worker, otherwise rate limit explodes.
   - Recommendation: Start with SEQUENTIAL Tier 1. Add parallelism only if a runtime budget review post-Phase 16 demands it.

5. **Manual queue persistence between runs — does the script re-read the manual queue TSV or rely solely on the trail?**
   - What we know: D-15 specifies resume-from-trail; manual queue is a TSV file.
   - What's unclear: If operator processes 10/20 rows then quits, on resume should the manual CLI re-read the queue TSV and skip already-processed (via trail) — or re-read the trail and recompute the queue?
   - Recommendation: Re-read the queue TSV from disk; cross-reference against `processed_pids` from trail; present unprocessed rows. Simple, predictable.

6. **Test fixture strategy for Phase 16 verifySameProduct**
   - What we know: Phase 15 has 13-pid fixture set in `tests/fixtures/garment-type/`.
   - What's unclear: Should Phase 16 reuse the Phase 15 fixtures (specifically the 7 bad ones — 6110, 8882, etc.) or curate a new set?
   - Recommendation: Reuse. The 7 bad fixtures are exactly the content-mismatch class Phase 16 must catch; verify `verifySameProduct` returns `match=false` on them and `match=true` on the 6 good ones.

## Sources

### Primary (HIGH confidence)
- `src/lib/ai-image-generator.ts` (lines 1-534) — Phase 15 verifier + Phase 10 generator, both used directly by Phase 16
- `src/lib/rejects-tsv.ts` (lines 1-93) — TSV writer pattern reused
- `src/sheets/drive.ts` (lines 1-155) — Drive client, uploadToDrive update-in-place semantics
- `src/sheets/writer.ts` (lines 1-84) — Atomic BR cell updates
- `src/sheets/reader.ts` (lines 1-80) — SheetRow typing limitations
- `src/sheets/types.ts` (lines 1-107) — SheetRow lacks Model* fields (verified)
- `src/sheets/column-map.ts` (lines 1-54) — Cell address conversion
- `src/shopify/resolve-store-product.ts` (lines 1-122) — Throws-on-multi pattern (informational; not used in Phase 16)
- `src/shopify/image-standardizer.ts:244+` — downloadImage helper (URL fetcher)
- `scripts/audit-garment-types.ts` (lines 1-307) — DI seam pattern for Phase 16 audit script
- `scripts/audit-product-imagery.ts:51-77` — KNOWN_SUPPLIER_PREFIXES allowlist
- `scripts/fetch-ss-images-fixed.ts` (lines 1-241) — S&S complete 6-column resolver
- `scripts/fetch-ss-rest-sizes.ts` (lines 1-287) — S&S styleID resolution pattern
- `scripts/fetch-model-images.ts` (lines 1-233) — Model image S&S fetcher
- `scripts/scrape-csw-product.ts` (lines 1-172) — CSW scraper
- `scripts/generate-cross-pollution-tsv.ts` (lines 1-100) — Phase 14 TSV classifier
- `scripts/fetch-fixture-binaries.ts` (lines 1-100) — Drive download + extractFileId
- `.planning/phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/14-VERIFICATION.md` — Phase 14 outcomes
- `.planning/phases/15-garment-type-verification/15-PHASE-SUMMARY.md` — Phase 15 reusable surface
- `tmp/full-audit-2026-05-12.log` (live) — empirical mismatch + Vision 400 evidence
- `tmp/garment-type-rejects.tsv` (51 rows) — empirical Phase 15 shape-drift hits

### Secondary (MEDIUM confidence)
- Phase 14 cross-pollution TSV schema in `scripts/generate-cross-pollution-tsv.ts:188-209` — schema design pattern (Phase 16 won't reuse but informs choices)
- `KNOWN_SUPPLIER_PREFIXES` coverage estimate against BR — based on counting brand prefixes; the actual pid-by-pid coverage requires running the audit

### Tertiary (LOW confidence)
- Manual queue size estimate (~15-25 pids before D-12 scraper expansion) — extrapolation from partial audit data + Phase 14 +15 patterns; will be empirically determined by first Phase 16 audit run

## Metadata

**Confidence breakdown:**
- Reuse mapping (Phase 14/15 components): HIGH — all source files read directly
- Drive/Sheet API patterns: HIGH — verified via existing scripts
- Verifier prompt design: MEDIUM — Phase 15 prompt verbatim is HIGH; new same-product prompt is best-effort design, needs fixture validation
- Manual CLI scaffold: HIGH — Node's `readline/promises` is stable API
- Resume-from-trail design: HIGH — pattern derived from Phase 15's appendRejectRow + D-14/D-15 explicit semantics
- Empirical mismatch counts: MEDIUM — live audit running at research time; counts may shift
- Tier 1 coverage estimate: MEDIUM — depends on actual BR pid distribution
- invalid_image_format recommendation: HIGH — 48 Vision 400 errors observed in live log

**Research date:** 2026-05-12
**Valid until:** 2026-06-11 (30 days for the stack; sooner if S&S or CSW APIs change)

## RESEARCH COMPLETE
