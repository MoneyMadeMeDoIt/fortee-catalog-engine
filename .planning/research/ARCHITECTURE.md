# Architecture Research

**Domain:** Catalog data completion — Drive image linking + AI category/keyword inference on an existing TypeScript ESM script codebase
**Researched:** 2026-06-09
**Confidence:** HIGH — all findings derived from direct codebase inspection

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                    3 new scripts/ entry points                        │
│  link-br-images.ts  |  infer-categories.ts  |  gen-keywords.ts       │
└──────────┬──────────┴──────────┬────────────┴──────────┬─────────────┘
           │                     │                        │
           ▼                     ▼                        ▼
┌──────────────────┐   ┌─────────────────────────────────────────────┐
│  Drive listing   │   │        OpenAI chat.completions              │
│  createDrive     │   │        gpt-4o-mini, per product group       │
│  Client +        │   │        CostTracker budget cap               │
│  withDriveRetry  │   └──────────────────────┬──────────────────────┘
└──────────┬───────┘                          │
           │                                  │
           ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Shared sheet infrastructure                          │
│  createSheetsClient  |  values.get (raw)                             │
│  writeUpdates (batchUpdate 50k-cell chunks)  |  columnToLetter       │
│  appendDimension batchUpdate  |  EnrichmentUpdate[]                  │
└──────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│       Bestsellers-Ready tab  (~24,175 rows, ~291 products)            │
│       8 image columns (3 existing + 5 new)                           │
│       categories  |  baseCategory  |  keywords                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

| Component | Status | Responsibility |
|-----------|--------|---------------|
| `scripts/link-br-images.ts` | NEW | Drive→BR image linker. Lists pid folders, parses canonical filenames, maps to BR rows by (pid, color), OVERWRITEs all image columns |
| `scripts/infer-categories.ts` | NEW | Per-product category inference. One API call per pid, writes `categories` + `baseCategory` to all color rows |
| `scripts/gen-keywords.ts` | NEW | Per-product keyword generation. Same pipeline shape as category script |
| `src/sheets/client.ts` | REUSED unchanged | Sheets auth |
| `src/sheets/drive.ts` | REUSED unchanged | Drive auth + `withDriveRetry` + `extractFileId` |
| `src/sheets/writer.ts` | REUSED unchanged | `writeUpdates` (50k-cell chunked batchUpdate) |
| `src/sheets/column-map.ts` | REUSED unchanged | `columnToLetter` |
| `src/lib/cost-tracker.ts` | REUSED unchanged | Budget enforcement for AI scripts |

---

## Recommended Project Structure

No new `src/` modules are needed. All three features are self-contained scripts following the existing pattern of `scripts/*.ts` + shared `src/` helpers.

```
scripts/
├── link-br-images.ts            # NEW — Drive→BR deterministic image linker
├── infer-categories.ts          # NEW — AI category inference per product
├── gen-keywords.ts              # NEW — AI keyword generation per product
└── (all existing scripts unchanged)

src/
└── (all existing modules unchanged — no new shared lib needed)

tmp/
├── link-br-images-plan-<ts>.tsv    # dry-run output: every planned cell update
├── infer-categories-checkpoint.json # resume state: { [pid]: "done" | "error" }
└── gen-keywords-checkpoint.json    # resume state: { [pid]: "done" | "error" }
```

---

## Architectural Patterns

### Pattern 1: Canonical Filename Parsing

**What:** After the v2.0 finalize run (452/452, plan=0), every Drive file follows the exact template `{Brand}-{pid}-{Color}-{Role}.png` where Brand and Color use Title_Case_With_Underscores. For `link-br-images.ts`, only the canonical form needs to be parsed — no legacy fallback required.

**When to use:** `link-br-images.ts` only. The folder name is the authoritative pid; the pid segment in the filename is a redundant sanity-check, not the join key.

**Example:**
```typescript
// Brand-pid-Color-Role.png
// e.g. American_Apparel-BB001-Navy_Blue-Front.png
function parseCanonicalFilename(name: string): { color: string; role: string } | null {
  const ROLES = 'Front|Back|LeftSide|RightSide|ModelFront|ModelBack|ModelSide';
  const m = name.match(new RegExp(`^.+?-[^-]+-(.+)-(${ROLES})\\.png$`, 'i'));
  if (!m) return null;
  return { color: m[1], role: m[2] };
}
```

---

### Pattern 2: Join Key — Drive {pid, Color} → BR Rows

**The ambiguity:** `styleID` is populated on only ~19,055 of 24,174 rows. `productId` is populated on ~24,174 rows. Drive folder names are pids from the Complete-Bestsellers worklist, which correspond to `productId` in BR — confirmed by the existing `write-model-urls.ts` which joins on `productId.trim().toUpperCase()`.

**Decision: join on `productId`, not `styleID`.** Any row where `productId` is empty is logged and skipped.

**Color join — lowercase-alphanumeric collapse:**
```typescript
function normalizeColor(c: string): string {
  return c.toLowerCase().replace(/[^a-z0-9]/g, '');
}
// "Navy_Blue"   → "navyblue"
// "Navy Blue"   → "navyblue"   ✓ match
// "Heather_Grey"→ "heathergrey"
// "Heather Gray"→ "heathergray" ✗ miss (spelling variant — log, do not guess)
```

This is identical to the `normalizeColor` function already in `scripts/link-drive-images.ts` (line 68). Spelling variants (Grey vs Gray, Htr. vs Heather) will produce misses — correct behavior is to log them and leave those rows blank rather than assign the wrong color's URL.

**No generic/shared image fallback.** The old `link-drive-images.ts` had a fallback to images without a color token. Do not replicate this in v3.0 — canonical naming guarantees every file has a color token; a miss means that color has no Drive image.

**Multi-supplier products:** a pid can appear under more than one supplier folder. Scan all supplier subfolders (as `write-model-urls.ts` does) and collect all files for a pid, then deduplicate by role — first-seen wins, log collisions.

---

### Pattern 3: Adding 5 New Columns to a 24k-Row Sheet Safely

The existing `write-model-urls.ts` solved this for the 3 model columns. The v3.0 image linker follows the exact same pattern:

1. Read header row via `values.get` on range `'Bestsellers-Ready'!1:1`.
2. Check which of the new column names are absent using `headers.indexOf`.
3. If absent, call `spreadsheets.batchUpdate` with `appendDimension` to extend the grid, then write header cells using `writeUpdates`.
4. Update the in-memory header array.
5. Look up column indices by name for all subsequent writes.

**Avoiding the 3 unnamed blank columns:** Check by header name, not position. `appendDimension` appends after the last column and never touches existing columns. Writing headers at `columnToLetter(headers.length + i)` is safe because `headers.length` is read from the live sheet.

**`valueInputOption: 'RAW'`** on all writes — prevents Sheets from interpreting Drive URLs as formulas.

**The 5 new columns are additive.** Do not modify `src/sheets/types.ts` or `SHEET_COLUMNS`. New scripts work directly with raw header arrays, same as `write-model-urls.ts` and `link-drive-images.ts`.

Column mapping for the 5 new image roles:

| Drive Role token | BR column (existing or new) |
|-----------------|------------------------------|
| `Front` | `FrontImage` (existing) — overwrite |
| `Back` | `BackImage` (existing) — overwrite |
| `LeftSide` | `DirectSideImage` (existing) — overwrite; LeftSide IS the canonical direct side |
| `RightSide` | `RightSideImage` (NEW) |
| `ModelFront` | `ModelFrontImage` (may already exist from write-model-urls.ts) |
| `ModelBack` | `ModelBackImage` (may already exist) |
| `ModelSide` | `ModelSideImage` (may already exist) |

At runtime, check which of `RightSideImage`, `ModelFrontImage`, `ModelBackImage`, `ModelSideImage`, `ModelBackImage` are missing and add only the absent ones.

---

### Pattern 4: Per-Product AI Processing Pipeline

The canonical shape is established by `rewrite-descriptions-bestsellers.ts`:

```
1. Read all BR rows once (raw values.get — NOT readAllRows)
2. Group rows by productId; collect first row's productName, brandName,
   baseCategory, gender, description per group
3. Filter: skip products where the target cell is already non-empty (idempotency)
4. For each product group: build prompt → call chat.completions → extract output
5. Accumulate EnrichmentUpdate[] (one per BR row in the group)
6. Periodic flush every ~25 products to limit data loss on crash
7. Final flush
```

One API call per unique `productId` (291 calls total). Write the same output string to all rows sharing that `productId`.

**Fill-gaps semantics (not overwrite):** only process products where the target cell is empty. Preserves manually curated values. `--force` flag overrides for re-processing.

**Idempotency without a checkpoint file:** because already-filled rows are skipped at read time, a re-run after crash is safe by default — written rows will be skipped, unwritten rows will be retried.

---

### Pattern 5: Checkpoint / Resume for AI Scripts

For 291 products the idempotency filter (skip if already filled) is sufficient as a crash-resume mechanism with no additional infrastructure. A TSV or JSON checkpoint in `tmp/` is optional but useful as an audit trail.

If implemented:
```typescript
// tmp/infer-categories-checkpoint.json: Record<pid, "done" | "error">
// On start: read checkpoint, exclude "done" pids from work list
// After each successful batchUpdate flush: write completed pids to checkpoint
```

This is consistent with the `tmp/` TSV pattern used by `finalize-bestsellers-drive.ts`.

---

### Pattern 6: CostTracker Reuse for Text Completions

`CostTracker` was built for image generation costs (dollars per image call). For text completions the budget unit is the same (dollars). Instantiate with a dollar budget and call `canAfford(estimatedCost)` before each product.

Token cost at current pricing (gpt-4o-mini): ~$0.15/1M input + $0.60/1M output. Per product prompt ~300 tokens in + ~150 tokens out ≈ $0.000135. For 291 products total ≈ $0.04. A $1 cap is ample and serves as a circuit breaker if the model charges more than expected.

---

## Data Flow

### Stream 1: Drive → BR Image Linker

```
Drive root folder
    ↓ listSubfolders (supplier level)
    ↓ listSubfolders (pid level) per supplier
    ↓ files.list per pid folder
Map<pid, Map<normColor, Map<role, fileId>>>
    ↓
BR raw rows (values.get once)
    ↓ build Map<pid, rowIndices[]> + Map<rowIdx, normColor>
    ↓ join: for each pid → for each row's normColor → look up role map
EnrichmentUpdate[] (all image cols × all matching rows)
    ↓ dry-run: emit tmp/link-br-images-plan-<ts>.tsv
    ↓ --apply: writeUpdates (batchUpdate RAW 50k-chunk)
```

### Stream 2: AI Category Inference

```
BR raw rows (values.get once)
    ↓ group by productId → skip if categories already filled
    ↓ per product: { productName, brandName, baseCategory, gender, description }
OpenAI chat.completions (gpt-4o-mini)
    ↓ output: { categories: string, baseCategory: string }
EnrichmentUpdate[] (categories col + baseCategory col × all rows for pid)
    ↓ flush every 25 products → writeUpdates
    ↓ optional: tmp/infer-categories-checkpoint.json
```

### Stream 3: AI Keyword Generation

```
BR raw rows (values.get once) — run AFTER infer-categories so categories is populated
    ↓ group by productId → skip if keywords already filled
    ↓ per product: { productName, brandName, baseCategory, gender, description, categories }
OpenAI chat.completions (gpt-4o-mini)
    ↓ output: comma-separated keyword string
EnrichmentUpdate[] (keywords col × all rows for pid)
    ↓ flush every 25 products → writeUpdates
```

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Google Drive | `createDriveClient()` + Drive v3 `files.list` with `supportsAllDrives: true` + `includeItemsFromAllDrives: true` | `withDriveRetry` is internal to `drive.ts`; new scripts call public helpers. Use `createDriveClient` not a bare `google.drive()` call |
| Google Sheets | `createSheetsClient()` + raw `values.get` | Do NOT use `readAllRows` — it filters to `SHEET_COLUMNS` only |
| OpenAI | `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` | Prefix all invocations with `NODE_OPTIONS=--use-system-ca` on this machine (AV TLS interception) |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `link-br-images.ts` ↔ `src/sheets/drive.ts` | Direct import of `createDriveClient`; call `drive.files.list` directly for folder traversal | `withDriveRetry` is not exported; wrap list calls yourself or use `findOrCreateFolder` pattern as reference |
| `link-br-images.ts` ↔ `src/sheets/writer.ts` | Direct import of `writeUpdates` | Handles 50k-cell chunking automatically |
| AI scripts ↔ `src/lib/cost-tracker.ts` | Direct import of `CostTracker`; instantiate with dollar budget | `canAfford(cost)` before each API call; `record(cost)` after |
| All new scripts ↔ BR sheet | Raw `sheets.spreadsheets.values.get` | Header-index map built at runtime from actual headers, not from `SHEET_COLUMNS` |

---

## New vs Modified Components

| Component | Status | Reason |
|-----------|--------|--------|
| `scripts/link-br-images.ts` | NEW | Drive→BR image linker, deterministic |
| `scripts/infer-categories.ts` | NEW | AI category + baseCategory per product |
| `scripts/gen-keywords.ts` | NEW | AI keywords per product |
| `src/sheets/types.ts` | NOT modified | New scripts access BR columns directly by header name |
| `src/sheets/column-map.ts` | NOT modified | `columnToLetter` reused as-is |
| `src/sheets/writer.ts` | NOT modified | `writeUpdates` reused as-is |
| `src/sheets/drive.ts` | NOT modified | All needed helpers already exist |
| `src/lib/cost-tracker.ts` | NOT modified | Reused as-is |

---

## Anti-Patterns

### Anti-Pattern 1: Using `readAllRows` for Bestsellers-Ready

**What people do:** call `readAllRows(sheets, spreadsheetId, 'Bestsellers-Ready')` for convenience.

**Why it's wrong:** `readAllRows` maps only columns in the `SHEET_COLUMNS` constant. Any column absent from that array — including the 5 new image columns being added in this milestone — is silently ignored. The returned `SheetRow` objects return empty strings for those fields even when the sheet has data.

**Do this instead:** call `sheets.spreadsheets.values.get({ spreadsheetId, range: "'Bestsellers-Ready'" })` directly and build a header-index map from `rows[0]`. All existing BR-targeting scripts (`link-drive-images.ts`, `rewrite-descriptions-bestsellers.ts`, `fill-missing-info.ts`) use this direct approach.

---

### Anti-Pattern 2: Hard-coding Column Letter Addresses

**What people do:** hard-code `BK` or similar as the column letter for a new column.

**Why it's wrong:** BR column count changes as columns are added. Hard-coding breaks the next script that runs.

**Do this instead:** read the header row at runtime, find the column by name with `headers.indexOf('ColumnName')`, convert to a letter with `columnToLetter(idx)`. Add new columns only if `headers.indexOf` returns -1.

---

### Anti-Pattern 3: Joining on `styleID` Instead of `productId`

**What people do:** use `styleID` as the pid join key because it looks like the canonical product identifier.

**Why it's wrong:** `styleID` is empty on ~5,100 rows (~21%). Those rows would be silently skipped, leaving image cells blank. Drive folder names correspond to `productId`.

**Do this instead:** join on `productId`. Log and skip rows where `productId` is also empty (rare).

---

### Anti-Pattern 4: Calling the AI Per Variant Row

**What people do:** loop over all 24k rows and call the AI for each one.

**Why it's wrong:** categories and keywords are product-level attributes. 24,175 API calls instead of 291 — ~83x more expensive. Also risks rate limits.

**Do this instead:** group rows by `productId` first. One API call per unique product. Write the same output string to all rows in the group.

---

### Anti-Pattern 5: Blocking the Image Linker on the OpenAI Cap

**What people do:** wait until all three features are unblocked before starting any work.

**Why it's wrong:** the image linker is deterministic, requires no AI, and can ship independently. Blocking it delays filling the 8 image columns unnecessarily.

**Do this instead:** build and ship `link-br-images.ts` first. Start AI scripts only after the OpenAI usage cap is raised.

---

### Anti-Pattern 6: Color Fallback to Generic Images

**What people do:** if no color-specific Drive image is found for a row, fall back to any image in the pid folder (the approach in the old `link-drive-images.ts`).

**Why it's wrong:** after the v2.0 finalize pass, every file in Drive has a color token in its name. A missing match means that color genuinely has no image — not that the image is generic. Falling back would assign the wrong color's image to a row.

**Do this instead:** log the miss (`pid=X color=Y: no Drive file found`), leave the cell blank, move on.

---

## Build Order

**Phase 1 — Unblocked, no AI: `link-br-images.ts`**

Dependencies: none. Drive finalize is complete (452/452, plan=0).

Steps:
1. Read BR header row; add absent columns via `appendDimension` + header write
2. Scan all Drive supplier subfolders; build `Map<pid, Map<normColor, Map<role, fileId>>>`
3. Read all BR rows; build `Map<pid, number[]>` (rowIndices)
4. Dry-run: write `tmp/link-br-images-plan-<ts>.tsv` — one line per planned cell update
5. `--apply`: call `writeUpdates` to overwrite all 8 image columns

**Phase 2 — Requires OpenAI cap raised: `infer-categories.ts`**

Dependencies: OpenAI usage cap raised. Does not depend on Phase 1 output (though running after Phase 1 means `categories` context is independent — fine).

Steps:
1. Read all BR rows once
2. Group by `productId`; filter out products where `categories` already filled
3. Per product: call `gpt-4o-mini`; extract `{ categories, baseCategory }`
4. Accumulate updates; flush every 25 products
5. `--dry-run`: estimate token cost, no API calls

**Phase 3 — After Phase 2: `gen-keywords.ts`**

Dependencies: Phase 2 complete so `categories` is available as prompt context.

Steps same as Phase 2 but targets `keywords` column. Skip products where `keywords` already filled.

---

## Scaling Considerations

| Concern | At current scale (291 products, 24k rows) |
|---------|-------------------------------------------|
| Drive listing latency | ~291 folder listings × ~20 files each ≈ 5,820 API calls; at ~10 req/s ≈ 10 min; use `withDriveRetry` |
| Sheets write volume | 8 cols × 24k rows = ~192k cell updates; `writeUpdates` chunks at 50k = 4 batches; fine |
| OpenAI throughput | 291 calls × gpt-4o-mini ≈ $0.04 total; rate limits not a concern |
| Memory | 24k rows × ~200 bytes/row ≈ 5 MB; no streaming needed |

---

## Sources

- Direct inspection: `src/sheets/client.ts`, `src/sheets/drive.ts`, `src/sheets/writer.ts`, `src/sheets/reader.ts`, `src/sheets/types.ts`, `src/sheets/column-map.ts`, `src/lib/cost-tracker.ts`
- Direct inspection: `scripts/write-model-urls.ts`, `scripts/link-drive-images.ts`, `scripts/rewrite-descriptions-bestsellers.ts`, `scripts/fill-missing-info.ts`, `scripts/finalize-bestsellers-drive.ts`
- `.planning/PROJECT.md` for milestone context and constraint history

---
*Architecture research for: v3.0 Catalog Data Completion — Drive image linking + AI category/keyword inference*
*Researched: 2026-06-09*
