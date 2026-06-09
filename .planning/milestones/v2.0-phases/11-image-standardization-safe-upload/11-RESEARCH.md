# Phase 11: Image Standardization & Safe Upload - Research

**Researched:** 2026-03-26
**Domain:** sharp image processing, Google Sheets batchUpdate, standardizeImage refactor
**Confidence:** HIGH — all findings sourced directly from codebase inspection

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Replace per-category `REFERENCE_RATIOS` (73% tops, 78% hoodies) with a single universal target: 85% max height. Every garment, regardless of type, occupies the same vertical space (1700px on 2000x2000 canvas).
- **D-02:** Canvas size remains 2000x2000px. Output format is PNG (lossless, matching existing pipeline).
- **D-03:** Do NOT upload to Shopify in this phase. Only update image URLs in Google Sheets with standardized images. The user's existing store images must not be changed.
- **D-04:** Standardized images should be hosted somewhere accessible by URL (e.g., uploaded to Shopify's staged uploads for URL generation, but NOT attached to products). Or stored locally and referenced by path.
- **D-05:** Output as PNG (lossless). Matches existing pipeline. No format change needed.

### Claude's Discretion
- How to update `standardizeImage()` to use fixed 85% target instead of per-category ratios (refactor approach)
- Whether to keep `REFERENCE_RATIOS` for backward compatibility or remove entirely
- Storage/hosting mechanism for standardized images (local files, staged uploads for URLs, etc.)
- How to update Google Sheets with new image URLs
- Error handling for images that fail standardization

### Deferred Ideas (OUT OF SCOPE)
- **Shopify GID-based media replacement** — When the user is ready to update Shopify product images, implement with position-based view matching (1st=front, 2nd=back, 3rd=side).
- **Contextual on-model photos** — Still deferred.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| STD-01 | All final images standardized to 2000x2000px with garment at fixed target proportion (85% max height) | `standardizeImage()` already does trim→place pipeline; needs ratio swap + topOffset recalculation |
| STD-02 | Standardized images uploaded to Shopify via staged uploads, replacing existing media | Scope-reduced per CONTEXT.md: this phase updates Google Sheets only, not Shopify |
| OUT-02 | Existing Shopify product image GIDs fetched before replacement to avoid accidental deletion | Deferred to future phase per CONTEXT.md; not implemented here |
</phase_requirements>

---

## Summary

Phase 11 makes two targeted changes to the image pipeline: (1) replace per-category `REFERENCE_RATIOS` in `standardizeImage()` with a single fixed 85% height target, and (2) replace the Shopify staged-upload output in `processProductImages()` with Google Sheets URL writes.

The existing sharp pipeline (trim → extract garment → place on 2000x2000 canvas) is sound and does not change. The only algorithmic change is computing `targetHeightPx = 2000 * 0.85 = 1700` and `targetTopOffsetPx` from a fixed top-padding constant, rather than looking them up in `REFERENCE_RATIOS[categoryGroup]`.

The Google Sheets write path already exists (`writeUpdates()`, `buildUpdates()`). The new function needs to call `writeUpdates()` with `EnrichmentUpdate` objects targeting the `FrontImage` (col index 10), `BackImage` (col index 11), and `DirectSideImage` (col index 12) columns. The current `buildUpdates()` skips non-empty cells — the standardization writer must OVERWRITE (not skip) because it is replacing raw supplier URLs with standardized image URLs.

**Primary recommendation:** Create a new `standardizeAndWriteToSheets()` function that reuses `standardizeImage()` (refactored), saves outputs locally or via staged uploads for URL generation, then calls `writeUpdates()` with explicit column targeting (bypassing the skip-empty logic in `buildUpdates()`).

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| sharp | ^0.34.5 | Image resize, trim, composite | Already used throughout pipeline |
| googleapis | ^171.4.0 | Google Sheets batchUpdate | Already used in enrich.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @shopify/admin-api-client | ^1.1.1 | stagedUploadsCreate for hosted URLs | If D-04 chooses staged upload for URL hosting |
| node:fs | built-in | Write standardized PNGs to local disk | If D-04 chooses local file storage |

**No new dependencies required.** All libraries already in `package.json`.

---

## Architecture Patterns

### Existing Function: standardizeImage()

Current signature:
```typescript
// src/shopify/image-standardizer.ts
export async function standardizeImage(
  imageBuffer: Buffer,
  categoryGroup: CategoryGroup = 'tops',  // THIS MUST CHANGE
  canvasSize = 2000,
): Promise<{ buffer: Buffer; garmentPlacement: { left: number; top: number; width: number; height: number } }>
```

Current behavior — reads from REFERENCE_RATIOS:
```typescript
const ratios = REFERENCE_RATIOS[categoryGroup];
const targetHeightPx = Math.round(canvasSize * ratios.targetHeightFrac);    // 73% or 78%
const targetTopOffsetPx = Math.round(canvasSize * ratios.topOffsetFrac);    // 6% or 5%
```

Required change — fixed constants:
```typescript
const FIXED_GARMENT_HEIGHT_FRAC = 0.85;    // 1700px on 2000px canvas
const FIXED_TOP_OFFSET_FRAC = 0.075;       // 150px — centers remaining 300px whitespace
// or keep 0.06 (120px top) which matches existing tops behavior and leaves 180px bottom margin

const targetHeightPx = Math.round(canvasSize * FIXED_GARMENT_HEIGHT_FRAC);
const targetTopOffsetPx = Math.round(canvasSize * FIXED_TOP_OFFSET_FRAC);
// categoryGroup parameter can be removed or left for derivePrintAreaCoords compatibility
```

**Top offset decision (Claude's discretion):** With 1700px garment height, remaining canvas whitespace is 300px. Two defensible choices:
- `topOffsetFrac = 0.075` (150px top, 150px bottom) — visually centered
- `topOffsetFrac = 0.06` (120px top, 180px bottom) — matches existing tops top-padding, small bottom skirt

The centered approach (0.075) is visually cleaner and aligns with the "uniform scale" mandate.

### Critical: image-scorer.ts imports REFERENCE_RATIOS

```typescript
// src/shopify/image-scorer.ts line 4
import { detectGarmentBounds, REFERENCE_RATIOS } from './image-standardizer.js';

// Used in checkProportion() lines 229-234:
const minFrac =
  Math.min(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) -
  PROPORTION_TOLERANCE;  // 0.73 - 0.25 = 0.48
const maxFrac =
  Math.max(REFERENCE_RATIOS.tops.targetHeightFrac, REFERENCE_RATIOS.hoodies.targetHeightFrac) +
  PROPORTION_TOLERANCE;  // 0.78 + 0.25 = 1.03
```

If `REFERENCE_RATIOS` is removed, `image-scorer.ts` breaks. Options:
1. **Keep REFERENCE_RATIOS as a deprecated export** (low churn, no breaking change to scorer tests)
2. **Update checkProportion() to use FIXED_GARMENT_HEIGHT_FRAC** (cleaner, but touches scorer + scorer tests)
3. **Update checkProportion() to accept an explicit target frac** (cleanest API, most churn)

Option 1 is the safest — keep `REFERENCE_RATIOS` exported but stop using it in `standardizeImage()`. The scorer will still work and tests will still pass. Remove it in a future cleanup.

### Existing Sheets Write Pattern

```typescript
// src/sheets/writer.ts — existing batchUpdate pattern
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId,
  requestBody: {
    valueInputOption: 'RAW',
    data: updates,  // EnrichmentUpdate[]
  },
});

// EnrichmentUpdate shape:
interface EnrichmentUpdate {
  range: string;    // e.g., "Sheet1!K2"
  values: string[][];
}
```

Column positions for image columns (0-based indices from SHEET_COLUMNS):
```
FrontImage      → index 10 → column K
BackImage       → index 11 → column L
DirectSideImage → index 12 → column M
```

Computing the A1 range for row i (0-based data row, row 2 = first data row):
```typescript
const sheetRowNumber = rowIndex + 2;  // matches buildUpdates() convention
// FrontImage: `${sheetName}!K${sheetRowNumber}`
// BackImage:  `${sheetName}!L${sheetRowNumber}`
// DirectSideImage: `${sheetName}!M${sheetRowNumber}`
```

**CRITICAL:** The existing `buildUpdates()` function skips cells where `currentValue.trim() !== ''`. Standardization must OVERWRITE existing raw supplier URLs with new standardized image URLs. Therefore, the new write function must NOT call `buildUpdates()` — it must build `EnrichmentUpdate` objects directly with no skip-if-nonempty guard.

### URL Hosting Options (D-04, Claude's Discretion)

The standardized PNG buffers need a publicly accessible URL to write into the sheet. Two viable approaches:

**Option A: Local file storage (path as URL)**
- Write PNGs to `tmp/standardized/{styleID}-{color}-{view}.png`
- Write local file path as the sheet value (e.g., `file:///...` or absolute path)
- Problem: local paths are not accessible by Shopify or external tools
- Good for: offline development/testing only

**Option B: Shopify staged uploads (URL without product attachment)**
- Call `stagedUploadsCreate` as currently done in `uploadStagedImage()`
- Returns `resourceUrl` — a CDN URL (e.g., `https://cdn.shopify.com/...`)
- Do NOT call `productCreateMedia` — just use the `resourceUrl` as the sheet value
- The CDN URL is publicly accessible and suitable for Shopify media later
- This is the correct production approach per CONTEXT.md D-04

**Recommendation: Use Shopify staged uploads (Option B)** — it produces real CDN URLs that the future Shopify upload phase can use directly. The `uploadStagedImage()` function already implements this; it just needs to be called without the subsequent `productCreateMedia` step (which doesn't happen in `processProductImages()` anyway — `uploadStagedImage()` only returns the `resourceUrl`, it does not attach to a product).

### New Function: processAndWriteToSheets()

New function signature to replace/extend `processProductImages()`:

```typescript
export async function standardizeImagesToSheets(
  client: ShopifyClient,
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  imageUrls: { front?: string; back?: string; side?: string },
  rowIndex: number,          // 0-based data row index
  productName: string,
  colorName: string,
  categoryGroup: CategoryGroup,  // still needed for derivePrintAreaCoords
): Promise<{ cellsWritten: number; printAreaCoords: PrintAreaCoords | null }>
```

Internal flow:
1. For each view: `downloadImage()` → `standardizeImage()` → `uploadStagedImage()` → get `resourceUrl`
2. Build `EnrichmentUpdate[]` for the columns that have new URLs (overwrite regardless of existing value)
3. Call `writeUpdates(sheets, spreadsheetId, updates)`
4. Return count + printAreaCoords (from front image garment placement)

### Recommended Project Structure (no new directories)

```
src/shopify/
├── image-standardizer.ts    # MODIFY: replace REFERENCE_RATIOS usage, add FIXED_* constants
├── image-scorer.ts          # MODIFY only if removing REFERENCE_RATIOS (Option 2/3 above)
src/sheets/
├── writer.ts                # UNCHANGED — writeUpdates() reused as-is
├── column-map.ts            # UNCHANGED — column indices sufficient
tests/shopify/
├── image-standardizer.test.ts  # MODIFY: update tests referencing REFERENCE_RATIOS
scripts/
├── standardize-images.ts    # NEW: CLI entry point for Phase 11
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image resize + canvas placement | Custom resize logic | `sharp` already in `placeGarmentOnCanvas()` | sharp handles aspect ratio, compositing, PNG encoding correctly |
| Garment boundary detection | Manual pixel scanning | `detectGarmentBounds()` with sharp trim() | Already calibrated with `Math.abs()` fix for trim offset negatives |
| Google Sheets batchUpdate | Direct `sheets.spreadsheets.values.update()` calls | `writeUpdates()` in `src/sheets/writer.ts` | Already chunked for 50K cell limit |
| Staged upload HTTP PUT | Custom fetch with headers | `uploadStagedImage()` in `image-standardizer.ts` | Already handles user errors, PUT failures, timeout |
| Column index to A1 notation | Hard-coded column letters | `columnToLetter()` in `src/sheets/column-map.ts` | Already handles AA, AB... multi-letter columns |

---

## Common Pitfalls

### Pitfall 1: categoryGroup Parameter Removal Breaks image-scorer.ts

**What goes wrong:** Removing `categoryGroup` from `standardizeImage()` or removing `REFERENCE_RATIOS` without updating `image-scorer.ts` causes a TypeScript compilation error and breaks proportion checking.

**Why it happens:** `image-scorer.ts` line 4 imports `REFERENCE_RATIOS` directly from `image-standardizer.ts`. It uses both `.tops.targetHeightFrac` and `.hoodies.targetHeightFrac` in `checkProportion()`.

**How to avoid:** Keep `REFERENCE_RATIOS` as a deprecated-but-exported constant in `image-standardizer.ts` (safest), OR update `checkProportion()` to use `FIXED_GARMENT_HEIGHT_FRAC` and update its tests. Do not silently delete the export.

**Warning signs:** TypeScript error `Module '"./image-standardizer.js"' has no exported member 'REFERENCE_RATIOS'`.

### Pitfall 2: buildUpdates() Silently Skips Non-Empty Image Cells

**What goes wrong:** Calling `buildUpdates()` for image URL updates causes rows that already have a raw supplier URL in `FrontImage`/`BackImage` to be silently skipped. The standardized URL never gets written.

**Why it happens:** `buildUpdates()` line 90: `if (currentValue.trim() !== '') continue;` — it was designed to never overwrite.

**How to avoid:** Build `EnrichmentUpdate[]` directly without the skip guard. Target columns K, L, M explicitly. Do not route through `buildUpdates()` for standardization writes.

### Pitfall 3: sharp.trim() Negative Offset Values

**What goes wrong:** `info.trimOffsetLeft` and `info.trimOffsetTop` can be negative (sharp issue #4085). Using them directly causes garment extraction at incorrect position.

**Why it happens:** sharp's internal trim offset calculation can produce negative values for certain image edge cases.

**How to avoid:** `detectGarmentBounds()` already applies `Math.abs()` on both offsets. Do not bypass `detectGarmentBounds()` — always use it as the entry point.

**Warning signs:** garment is placed in wrong position or `sharp extract` throws `Extract region exceeds dimensions of image`.

### Pitfall 4: sharp .extract().stats() Chaining Does Not Work

**What goes wrong:** Calling `sharp(buffer).extract({...}).stats()` returns stats for the original buffer, not the extracted region.

**Why it happens:** Known sharp behavior — `.stats()` evaluates the pipeline lazily and in some chaining paths returns stats for the original input.

**How to avoid:** Always `.toBuffer()` after extract, then create a new `sharp(extractedBuffer).stats()` call. This is already done in `image-scorer.ts` with explicit comments. Follow the same pattern anywhere new sharp operations are added.

### Pitfall 5: Top Offset Causes Garment to Overflow Bottom of Canvas

**What goes wrong:** With `targetHeightPx = 1700` and `targetTopOffsetPx = 150`, the bottom of the garment lands at pixel 1850, well within the 2000px canvas. BUT if `targetTopOffsetPx` is set larger than 300 (e.g., by mistake using the full 6% = 120px with extra padding), it can push garment bottom past 2000px.

**Why it happens:** `placeGarmentOnCanvas()` does not guard against out-of-bounds placement. sharp will throw or silently clip.

**How to avoid:** Assert `targetTopOffsetPx + targetHeightPx <= canvasSize` before calling `placeGarmentOnCanvas()`. With fixed values (150 + 1700 = 1850 ≤ 2000), this is fine — but add the assertion so future changes are caught.

### Pitfall 6: Sheets Row Index Off-By-One

**What goes wrong:** Writing standardized URLs to wrong rows in Google Sheets.

**Why it happens:** The sheet uses 1-based row numbers; row 1 is headers; data starts at row 2. `buildUpdates()` uses `rowIndex + 2` where `rowIndex` is 0-based. Any new sheet writer must use the same convention.

**How to avoid:** Follow the existing convention: `sheetRowNumber = dataRowIndex + 2`. Validate in tests by checking that a `rowIndex=0` update targets row 2 in the A1 range string.

---

## Code Examples

### Fixed Constants to Replace REFERENCE_RATIOS in standardizeImage()

```typescript
// Source: direct codebase analysis of REFERENCE_RATIOS values
// Replaces: REFERENCE_RATIOS.tops.targetHeightFrac=0.73, REFERENCE_RATIOS.hoodies.targetHeightFrac=0.78
export const FIXED_GARMENT_HEIGHT_FRAC = 0.85;    // 1700px on 2000px canvas (D-01)
export const FIXED_TOP_OFFSET_FRAC = 0.075;       // 150px top, 150px bottom — visually centered

// In standardizeImage():
const targetHeightPx = Math.round(canvasSize * FIXED_GARMENT_HEIGHT_FRAC);    // 1700
const targetTopOffsetPx = Math.round(canvasSize * FIXED_TOP_OFFSET_FRAC);     // 150
// categoryGroup param retained only for derivePrintAreaCoords (not used for sizing)
```

### Direct EnrichmentUpdate Construction for Overwrite

```typescript
// Source: analysis of src/sheets/types.ts and src/sheets/merge.ts
// Bypass buildUpdates() skip-if-nonempty logic for standardization writes
function buildStandardizationUpdates(
  sheetName: string,
  rowIndex: number,  // 0-based data row
  urls: { front?: string; back?: string; side?: string },
): EnrichmentUpdate[] {
  const sheetRowNumber = rowIndex + 2;  // row 1 = headers, data starts at row 2
  const updates: EnrichmentUpdate[] = [];
  if (urls.front) updates.push({ range: `${sheetName}!K${sheetRowNumber}`, values: [[urls.front]] });
  if (urls.back)  updates.push({ range: `${sheetName}!L${sheetRowNumber}`, values: [[urls.back]] });
  if (urls.side)  updates.push({ range: `${sheetName}!M${sheetRowNumber}`, values: [[urls.side]] });
  return updates;
}
```

### Preserving REFERENCE_RATIOS for scorer backward compatibility

```typescript
// Keep exported but add deprecation comment — do NOT remove in Phase 11
/** @deprecated Use FIXED_GARMENT_HEIGHT_FRAC instead. Kept for image-scorer.ts backward compatibility. */
export const REFERENCE_RATIOS = {
  tops: { targetHeightFrac: 0.73, topOffsetFrac: 0.06 },
  hoodies: { targetHeightFrac: 0.78, topOffsetFrac: 0.05 },
} as const;
```

### Test: verify 85% garment height on output canvas

```typescript
// Pattern for updating standardizeImage tests (replacing category-specific assertions)
it('places garment at 85% height on 2000x2000 canvas', async () => {
  const result = await standardizeImage(garmentPng);  // no categoryGroup needed
  // garmentPlacement.height should be 1700 (85% of 2000)
  expect(result.garmentPlacement.height).toBe(1700);
  expect(result.garmentPlacement.top).toBe(150);  // 7.5% of 2000
});
```

---

## Tests Requiring Updates

The following tests in `tests/shopify/image-standardizer.test.ts` reference `REFERENCE_RATIOS` or assume category-specific behavior:

| Test | Line | What Changes |
|------|------|-------------|
| `'returns 2000x2000 PNG for hoodies'` | 45-57 | Still passes (output size unchanged); may need garmentPlacement assertion update if added |
| `'REFERENCE_RATIOS has tops and hoodies keys'` | 189-194 | Should be updated/removed — REFERENCE_RATIOS becomes deprecated. Keep if backwards compat retained. |
| `derivePrintAreaCoords` tests using hardcoded placement `(87, 120, 1826, 1460, 'tops')` | 154-178 | These use the tops ratio (1460 = 73% of 2000). After STD-01, standardized garments will have height 1700. Update test inputs to match new dimensions. |
| `placeGarmentOnCanvas(garmentBuffer, 1460, 120)` | 125 | `1460` is the old tops height. Update to `1700` (85%) and `150` (new top offset) in tests that verify placement behavior. |

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Per-category REFERENCE_RATIOS (73%/78%) | Single 85% fixed target | All garments uniformly sized; proportion scoring needs recalibration |
| Shopify staged upload → product attachment | Staged upload for URL only → Google Sheets write | Store images not touched; safe incremental approach |

---

## Open Questions

1. **Top offset value: 0.075 (centered) vs 0.06 (match existing tops)?**
   - What we know: 0.075 = 150px top, visually centered; 0.06 = 120px top (current tops behavior)
   - What's unclear: visual preference — both are valid
   - Recommendation: use 0.075 (centered) as the cleaner choice for a uniform standard

2. **Should REFERENCE_RATIOS be removed or kept deprecated?**
   - What we know: `image-scorer.ts` imports it; removing it requires updating scorer + scorer tests
   - What's unclear: whether the scorer's proportion check should also move to 85% target
   - Recommendation: keep deprecated in Phase 11, clean up in Phase 12 or separate refactor

3. **Does `checkProportion()` in image-scorer need updating for 85% target?**
   - What we know: currently passes if garment height frac is within [0.48, 1.03] of canvas — a very wide band
   - What's unclear: whether pre-standardized source images should be scored against 85% or the old range
   - Recommendation: no change in Phase 11 — proportion check is a pre-standardization quality gate; the wide range (±25%) is intentional

4. **What identifier is used to match sheet rows for overwrite?**
   - What we know: `readAllRows()` returns rows in order; `buildUpdates()` uses `rowIndex` (0-based position in dataRows array)
   - What's unclear: the CLI entry point must iterate rows and know which rowIndex maps to which product
   - Recommendation: the new `standardize-images.ts` script should iterate `rows` from `readAllRows()`, match by `styleID` or process all rows sequentially using their array index

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Assumed present (existing project) | — | — |
| sharp | Image processing | Already in package.json | ^0.34.5 | — |
| googleapis | Sheets write | Already in package.json | ^171.4.0 | — |
| GOOGLE_SERVICE_ACCOUNT_EMAIL | Sheets auth | Required env var | — | Fail with descriptive error (already implemented in client.ts) |
| GOOGLE_PRIVATE_KEY | Sheets auth | Required env var | — | Fail with descriptive error |
| GOOGLE_SPREADSHEET_ID | Sheets target | Required env var | — | Fail with descriptive error |
| SHOPIFY_ADMIN_ACCESS_TOKEN | Staged uploads (if Option B) | Required env var for upload | — | Fall back to local file storage |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.x |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npm test -- tests/shopify/image-standardizer.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STD-01 | `standardizeImage()` places garment at 1700px height on 2000x2000 canvas | unit | `npm test -- tests/shopify/image-standardizer.test.ts` | Partial (tests exist; need 85% assertion) |
| STD-01 | `standardizeImage()` does NOT use REFERENCE_RATIOS[categoryGroup] for sizing | unit | `npm test -- tests/shopify/image-standardizer.test.ts` | No — Wave 0 gap |
| STD-02 (scoped) | `standardizeImagesToSheets()` writes standardized URLs to FrontImage/BackImage/DirectSideImage columns | unit | `npm test -- tests/shopify/image-standardizer.test.ts` | No — Wave 0 gap |
| STD-02 (scoped) | Sheets write targets correct row number (rowIndex + 2) | unit | `npm test -- tests/shopify/image-standardizer.test.ts` | No — Wave 0 gap |

### Sampling Rate
- **Per task commit:** `npm test -- tests/shopify/image-standardizer.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Update existing `standardizeImage` tests for 85% height assertion (garmentPlacement.height = 1700)
- [ ] Update existing `placeGarmentOnCanvas` test inputs from 1460→1700, 120→150
- [ ] New test: `standardizeImage()` produces garmentPlacement.top = 150 (or chosen fixed offset)
- [ ] New test: `standardizeImagesToSheets()` builds correct EnrichmentUpdate with range `K{rowNum}`
- [ ] New test: sheet write does NOT skip rows with existing image URLs (overwrite behavior)
- [ ] `REFERENCE_RATIOS has tops and hoodies keys` test — keep passing (export retained as deprecated)

---

## Sources

### Primary (HIGH confidence)
- `src/shopify/image-standardizer.ts` — direct inspection; full function signatures, REFERENCE_RATIOS values, placeGarmentOnCanvas internals
- `src/shopify/image-scorer.ts` — direct inspection; confirmed REFERENCE_RATIOS import at line 4, checkProportion() usage at lines 229-234
- `src/sheets/writer.ts` — direct inspection; writeUpdates() batchUpdate pattern, BATCH_SIZE=50000
- `src/sheets/merge.ts` — direct inspection; buildUpdates() skip-if-nonempty guard at line 90
- `src/sheets/types.ts` — direct inspection; SHEET_COLUMNS order confirmed (FrontImage=10, BackImage=11, DirectSideImage=12)
- `tests/shopify/image-standardizer.test.ts` — direct inspection; all tests referencing REFERENCE_RATIOS and category-specific values identified

### Secondary (MEDIUM confidence)
- `src/sheets/column-map.ts` — FIELD_MAPPING confirms FrontImage/BackImage/DirectSideImage as image column names
- `.planning/phases/11-image-standardization-safe-upload/11-CONTEXT.md` — locked decisions D-01 through D-05

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; all existing
- Architecture: HIGH — based on direct codebase inspection, not assumptions
- Pitfalls: HIGH — identified from actual code patterns (sharp chaining bug documented in comments, negative offset workaround with Math.abs already present)

**Research date:** 2026-03-26
**Valid until:** 2026-04-25 (stable codebase; only changes if Phase 09/10 alter image pipeline interfaces)
