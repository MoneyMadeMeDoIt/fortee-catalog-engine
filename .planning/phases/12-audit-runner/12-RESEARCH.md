# Phase 12: Audit Runner - Research

**Researched:** 2026-03-27
**Domain:** TypeScript orchestration — wiring Phase 08-11 functions into a single per-product pipeline
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Linear pipeline: Score → Source all missing/failed → Generate remaining → Standardize → Write to sheets. Not per-view, not batch — one product flows through the full pipeline sequentially.
- **D-02:** Always re-standardize to 85% uniform scale, even if all views pass quality scoring. Existing images may not be at the correct scale. The runner ensures every product ends up standardized in sheets.
- **D-03:** For views that pass quality scoring AND already have an image, still standardize but don't source or generate. Only source/generate for missing or failing views.
- **D-04:** Write to Google Sheets only (no Shopify uploads). Inherits D-03 from Phase 11 — the user's store images must not be changed.

### Claude's Discretion
- Logging format and structure (structured JSON recommended per product)
- How to fetch existing product images for scoring (from current sheet URLs or from Shopify media query)
- Error handling when individual pipeline steps fail (skip view, skip product, or abort)
- Whether to return a summary object from auditProductImages()
- How to wire the CostTracker ($200 budget) across multiple product audits
- Internal function decomposition

### Deferred Ideas (OUT OF SCOPE)
- Shopify GID-based media replacement (from Phase 11) — still deferred
- Contextual on-model photos (from Phase 08) — still deferred
</user_constraints>

---

## Summary

Phase 12 wires four existing modules into a single `auditProductImages(styleId, rowIndex, row, costTracker, deps)` function. No new image processing logic is required. The research task is to map exact function signatures, understand data shapes, and identify where buffers, URLs, and scores are passed between pipeline steps.

The most important finding is that `standardizeImagesToSheets()` accepts URLs (not buffers), so the runner needs to supply image URLs at the standardization step. Images acquired as raw buffers during sourcing/generation must be uploaded to Shopify staged uploads first to produce CDN URLs — or the runner can call `standardizeImage()` + `uploadStagedImage()` directly and then `buildStandardizationUpdates()` + `writeUpdates()` rather than calling `standardizeImagesToSheets()` which internally re-downloads. The buffer-first path avoids redundant network round-trips.

The second key finding is that existing product images come from the Google Sheet columns (`FrontImage`, `BackImage`, `DirectSideImage` at row indices 10, 11, 12) — NOT from a Shopify media query. The sheet is the source of truth for current image URLs. The runner reads a `SheetRow` from the caller and downloads those URLs for scoring.

**Primary recommendation:** The runner accepts a `SheetRow` (already read by the CLI) plus a `rowIndex` and `CostTracker`. It scores sheet images, sources/generates only what's missing or failing, then standardizes all acquired buffers directly through `standardizeImage()` + `uploadStagedImage()` + `buildStandardizationUpdates()` + `writeUpdates()` — bypassing the re-download inside `standardizeImagesToSheets()`.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.0.18 | Test framework | Already installed; used by all existing tests |
| sharp | (project dep) | Image buffer operations | Used throughout Phases 08-11 |
| winston | (project dep) | Structured logging | `src/lib/logger.ts` singleton |

### No New Dependencies
Phase 12 is pure integration. All required imports already exist:

```typescript
import { scoreImageQuality } from '../shopify/image-scorer.js';
import { sourceImages } from '../lib/image-sourcer.js';
import { generateGarmentView, enhanceFrontImage } from '../lib/ai-image-generator.js';
import { standardizeImage, uploadStagedImage, buildStandardizationUpdates, downloadImage } from '../shopify/image-standardizer.js';
import { CostTracker } from '../lib/cost-tracker.js';
import { writeUpdates } from '../sheets/writer.js';
import { logger } from '../lib/logger.js';
import { getCategoryGroup } from '../shopify/variants.js';
import type { SheetRow } from '../sheets/types.js';
import type { CategoryGroup } from '../shopify/types.js';
```

---

## Architecture Patterns

### Exact Function Signatures (verified from source)

**scoreImageQuality** (`src/shopify/image-scorer.ts`):
```typescript
scoreImageQuality(buffer: Buffer, categoryGroup?: CategoryGroup): Promise<ImageQualityResult>
// ImageQualityResult: { score: number; verdict: 'pass' | 'fail'; reasons: string[]; dimensions: { blur, resolution, proportion, content } }
```

**sourceImages** (`src/lib/image-sourcer.ts`):
```typescript
sourceImages(styleId: string, colorName?: string): Promise<SourcedImages>
// SourcedImages: { front: SourcedView | null; back: SourcedView | null; side: SourcedView | null }
// SourcedView: { url: string; score: number; verdict: 'pass' | 'fail' }
```

**generateGarmentView** (`src/lib/ai-image-generator.ts`):
```typescript
generateGarmentView(
  frontBuffer: Buffer,
  view: AIView,            // 'back' | 'side'
  garmentType: CategoryGroup,
  colorName: string,
  costTracker: CostTracker,
  client?: OpenAI,         // optional, for testing
): Promise<GenerateViewResult | null>
// Returns null if budget exhausted or all API calls failed with content policy
// GenerateViewResult: { buffer: Buffer; score: number; verdict: 'pass' | 'fail'; totalCost, callCount, usedRetry, hueDrift }
```

**enhanceFrontImage** (`src/lib/ai-image-generator.ts`):
```typescript
enhanceFrontImage(
  frontBuffer: Buffer,
  costTracker: CostTracker,
  garmentType?: CategoryGroup,
  client?: OpenAI,
): Promise<EnhanceFrontResult | null>
// Returns null if budget exhausted or content policy block
// EnhanceFrontResult: { buffer: Buffer; score: number; verdict: 'pass' | 'fail'; cost: number }
```

**standardizeImage** (`src/shopify/image-standardizer.ts`):
```typescript
standardizeImage(
  imageBuffer: Buffer,
  categoryGroup: CategoryGroup = 'tops',
  canvasSize = 2000,
): Promise<{ buffer: Buffer; garmentPlacement: { left, top, width, height } }>
// Always returns a buffer — falls back to fit:contain with a warning on trim failure
```

**uploadStagedImage** (`src/shopify/image-standardizer.ts`):
```typescript
uploadStagedImage(client: ShopifyClient, buffer: Buffer, filename: string): Promise<string>
// Returns CDN resourceUrl. Throws on Shopify API errors.
```

**buildStandardizationUpdates** (`src/shopify/image-standardizer.ts`):
```typescript
buildStandardizationUpdates(
  sheetName: string,
  rowIndex: number,  // 0-based data row index
  urls: { front?: string; back?: string; side?: string },
): EnrichmentUpdate[]
// Writes to columns K (FrontImage, index 10), L (BackImage, 11), M (DirectSideImage, 12)
// Row 2 = rowIndex 0 (row 1 is headers)
```

**downloadImage** (`src/shopify/image-standardizer.ts`):
```typescript
downloadImage(url: string): Promise<Buffer>
// 30-second timeout. Throws on HTTP error or timeout.
```

**getCategoryGroup** (`src/shopify/variants.ts`):
```typescript
getCategoryGroup(category: string): CategoryGroup | null
// Returns 'hoodies' | 'tops' | null
// null for unsupported categories (caps, pants, bags)
```

**writeUpdates** (`src/sheets/writer.ts`):
```typescript
writeUpdates(sheets: sheets_v4.Sheets, spreadsheetId: string, updates: EnrichmentUpdate[]): Promise<number>
// Returns cells updated count. Handles chunking at 50k cells.
```

**standardizeImagesToSheets** (`src/shopify/image-standardizer.ts`) — NOT the preferred path:
```typescript
standardizeImagesToSheets(
  client: ShopifyClient,
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  imageUrls: { front?: string; back?: string; side?: string },
  rowIndex: number,
  productName: string,
  colorName: string,
  categoryGroup: CategoryGroup,
): Promise<{ cellsWritten: number; printAreaCoords: PrintAreaCoords | null }>
// Accepts URLs — re-downloads them internally. Use only when no buffer is available.
```

---

### Recommended Project Structure

```
src/
├── lib/
│   └── audit-runner.ts    # auditProductImages() — the only new file
└── [all existing files unchanged]
```

### Pattern 1: Buffer-First Standardization (avoid re-download)

The runner holds buffers for sourced and generated images. Call `standardizeImage()` + `uploadStagedImage()` directly to get CDN URLs, then use `buildStandardizationUpdates()` + `writeUpdates()` to write them. This avoids the re-download inside `standardizeImagesToSheets()`.

```typescript
// For an image acquired as a Buffer (from generation or sourcing):
const { buffer: stdBuf } = await standardizeImage(rawBuffer, categoryGroup);
const cdnUrl = await uploadStagedImage(shopifyClient, stdBuf, filename);
// Collect cdnUrl, then call buildStandardizationUpdates + writeUpdates once.

// For an image that was only ever a URL (existing sheet image that passed scoring):
const rawBuffer = await downloadImage(existingUrl);
const { buffer: stdBuf } = await standardizeImage(rawBuffer, categoryGroup);
const cdnUrl = await uploadStagedImage(shopifyClient, stdBuf, filename);
```

### Pattern 2: Existing Image Source

Existing product images come from `SheetRow` fields. Download them for scoring:

```typescript
const views: Array<{ key: 'FrontImage' | 'BackImage' | 'DirectSideImage'; view: 'front' | 'back' | 'side' }> = [
  { key: 'FrontImage', view: 'front' },
  { key: 'BackImage', view: 'back' },
  { key: 'DirectSideImage', view: 'side' },
];

for (const { key, view } of views) {
  const url = row[key];
  if (!url) { /* mark as missing */ continue; }
  try {
    const buffer = await downloadImage(url);
    const result = await scoreImageQuality(buffer, categoryGroup);
    // result.verdict === 'pass' | 'fail'
  } catch (err) {
    logger.warn(`Failed to score ${view} for ${row.styleID}: ${err}`);
    // treat as missing — proceed to sourcing
  }
}
```

### Pattern 3: CostTracker Passed In (never created internally)

```typescript
// CORRECT: Runner receives tracker from caller (CLI or test)
export async function auditProductImages(
  row: SheetRow,
  rowIndex: number,
  shopifyClient: ShopifyClient,
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  costTracker: CostTracker,
): Promise<AuditResult>

// WRONG: Never do this inside the runner:
// const costTracker = new CostTracker(); // breaks shared budget across products
```

### Pattern 4: Structured Audit Result

Return a typed result so the CLI can log and accumulate summaries:

```typescript
export interface ViewAuditResult {
  view: 'front' | 'back' | 'side';
  status: 'pass-existing' | 'sourced' | 'generated' | 'enhanced' | 'failed' | 'skipped';
  score: number | null;
  cdnUrl: string | null;
  reason?: string;  // why skipped/failed
}

export interface AuditResult {
  styleId: string;
  colorName: string;
  views: ViewAuditResult[];
  cellsWritten: number;
  aiCostIncurred: number;
  error?: string;  // set if the whole product failed
}
```

### Pattern 5: categoryGroup Fallback

`getCategoryGroup` returns `null` for unsupported categories. The runner must handle this:

```typescript
const rawCategory = row.baseCategory;
const categoryGroup: CategoryGroup = getCategoryGroup(rawCategory) ?? 'tops';
// Default to 'tops' — affects standardization dimensions and AI prompts.
// Log a warning if category was unknown so it can be investigated.
if (!getCategoryGroup(rawCategory)) {
  logger.warn(`Unknown category '${rawCategory}' for ${row.styleID} — defaulting to tops`);
}
```

### Pattern 6: AI Generation Only for Back and Side

`generateGarmentView` accepts `AIView = 'back' | 'side'`. Front images are sourced or enhanced — never generated from scratch. `enhanceFrontImage` takes a failing front buffer and applies the cleanup prompt.

```typescript
// For front view failing scoring: try enhancement first
if (frontVerdict === 'fail' && frontBuffer) {
  const enhanced = await enhanceFrontImage(frontBuffer, costTracker, categoryGroup);
  if (enhanced) {
    // use enhanced.buffer, enhanced.verdict
  }
}

// For back/side missing or failing: generate from front buffer
const generated = await generateGarmentView(frontBuffer, 'back', categoryGroup, row.colorName, costTracker);
// Returns null if budget exhausted — treat as 'skipped'
```

### Pattern 7: Vitest Mock Pattern for Integration Tests

Phase 12's integration test should mock all four external modules and verify the orchestration logic:

```typescript
vi.mock('../../src/shopify/image-scorer.js', () => ({ scoreImageQuality: vi.fn() }));
vi.mock('../../src/lib/image-sourcer.js', () => ({ sourceImages: vi.fn() }));
vi.mock('../../src/lib/ai-image-generator.js', () => ({
  generateGarmentView: vi.fn(),
  enhanceFrontImage: vi.fn(),
}));
vi.mock('../../src/shopify/image-standardizer.js', () => ({
  standardizeImage: vi.fn(),
  uploadStagedImage: vi.fn(),
  buildStandardizationUpdates: vi.fn(),
  downloadImage: vi.fn(),
}));
vi.mock('../../src/sheets/writer.js', () => ({ writeUpdates: vi.fn() }));
```

### Anti-Patterns to Avoid

- **Calling `standardizeImagesToSheets()` when you hold a buffer:** That function re-downloads from URL. Use `standardizeImage()` + `uploadStagedImage()` + `buildStandardizationUpdates()` + `writeUpdates()` directly to avoid the extra network round-trip.
- **Creating a `CostTracker` inside the runner:** Breaks shared $200 budget across a batch of products. The tracker is always injected.
- **Blocking the pipeline on a failing step:** Individual view failures must be non-fatal. Log with `logger.warn` and continue to remaining views. Only abort if the front image is completely unavailable and needed for AI generation of back/side.
- **Calling `generateGarmentView` for front view:** Not supported — `AIView = 'back' | 'side'`. Use `enhanceFrontImage` for front cleanup.
- **Assuming categoryGroup is never null:** `getCategoryGroup` returns null for unsupported categories. Always apply a default.
- **Passing `rowIndex + 2` to `buildStandardizationUpdates`:** That function already adds 2 internally (`sheetRowNumber = rowIndex + 2`). Pass the 0-based data row index directly.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image download from URL | Custom fetch wrapper | `downloadImage(url)` | Has 30s timeout, error handling, already tested |
| Quality scoring | Manual blur/size checks | `scoreImageQuality(buffer, categoryGroup)` | Calibrated against 243 real images; thresholds are production-validated |
| Multi-supplier image sourcing | Custom OMG/CSW/S&S fetchers | `sourceImages(styleId, colorName)` | Parallel fetch, quality-scored merge, graceful fallback per D-04 |
| AI generation + retry | Manual OpenAI API calls | `generateGarmentView(...)` | Implements candidate ranking, hue drift check, retry logic, budget check |
| Front image cleanup | Separate generation path | `enhanceFrontImage(buffer, costTracker)` | Dedicated cleanup prompt, single candidate, budget-aware |
| Garment standardization | Custom sharp resize | `standardizeImage(buffer, categoryGroup)` | FIXED_GARMENT_HEIGHT_FRAC=0.85 uniform standard, trim-place-composite pipeline |
| CDN URL generation | Direct Shopify product update | `uploadStagedImage(client, buffer, filename)` | Staged uploads are intentionally URL-only per D-04; no product mutation |
| Sheet column updates | Manual range assembly | `buildStandardizationUpdates(sheetName, rowIndex, urls)` | Handles row offset arithmetic, targets correct K/L/M columns |
| Batch sheet writes | Individual cell updates | `writeUpdates(sheets, spreadsheetId, updates)` | Handles chunking at 50k cells |

**Key insight:** Every image processing operation has a tested, calibrated implementation. Phase 12 is a sequencing layer — no image math, no new API calls, no custom column addressing.

---

## Common Pitfalls

### Pitfall 1: sourceImages Returns URL Not Buffer

**What goes wrong:** The runner calls `sourceImages()` then tries to use `SourcedView.url` as a buffer in `scoreImageQuality()` or `generateGarmentView()`.

**Why it happens:** `SourcedImages` returns `SourcedView { url, score, verdict }` — the URL was already scored inside `sourceImages`. No buffer is returned.

**How to avoid:** After sourcing, call `downloadImage(sourcedView.url)` to get the buffer when needed for AI generation. The score and verdict are already populated in the `SourcedView` — no need to re-score.

**Warning signs:** TypeScript error `Argument of type 'string' is not assignable to parameter of type 'Buffer'` on calls after sourceImages.

### Pitfall 2: generateGarmentView Returns null on Budget Exhaustion

**What goes wrong:** The runner treats `null` return from `generateGarmentView` as a hard error and aborts the pipeline.

**Why it happens:** `generateGarmentView` returns `null` when `!costTracker.canAfford(callCost)` — this is a graceful no-op, not an exception.

**How to avoid:** Check for null explicitly and mark the view as `status: 'skipped'` in the audit result. Continue to the next view.

**Warning signs:** Unhandled null reference errors in `generated.buffer` without explicit null check.

### Pitfall 3: Sharp extract().stats() Chaining Bug (Already Known)

**What goes wrong:** Calling `.extract().stats()` on a sharp pipeline returns stats for the original un-extracted image.

**Why it happens:** This is a documented sharp behavior — stats() evaluates the pipeline input, not the transformed output.

**How to avoid:** Already handled in Phase 08/09/11 code via `.toBuffer()` then fresh `sharp(buf).stats()`. The runner does not call sharp directly — no action needed. But if any new sharp calls are needed in tests, follow the same pattern.

### Pitfall 4: Unsupported Category Returns null from getCategoryGroup

**What goes wrong:** Passing `null` as `categoryGroup` to `scoreImageQuality`, `standardizeImage`, or `generateGarmentView` causes runtime errors or incorrect behavior (wrong AI prompt, wrong proportion check).

**Why it happens:** `getCategoryGroup` returns `null` for caps, pants, bags — categories outside the print-area pipeline.

**How to avoid:** Default to `'tops'` when `getCategoryGroup` returns null. Log a warning. The sheet's `baseCategory` column may contain unsupported values for products that haven't been filtered.

### Pitfall 5: rowIndex Is 0-Based Data Index (not sheet row number)

**What goes wrong:** Passing `rowIndex + 2` to `buildStandardizationUpdates` causes writes to skip a row.

**Why it happens:** `buildStandardizationUpdates` internally computes `sheetRowNumber = rowIndex + 2`. The caller must pass the raw 0-based data index.

**How to avoid:** Pass `rowIndex` as-is. The function handles the offset. Row 0 = sheet row 2 (first data row after headers).

### Pitfall 6: vitest 4.x clearAllMocks Does Not Clear mockResolvedValueOnce Queue

**What goes wrong:** Test setup calls `vi.clearAllMocks()` in `beforeEach` but the `mockResolvedValueOnce` queue from a previous test bleeds into the next.

**Why it happens:** Documented vitest 4.x behavior — `clearAllMocks` clears call history but not queued `.once()` return values.

**How to avoid:** Use `vi.resetAllMocks()` (not `clearAllMocks`) in `beforeEach` for tests that queue `mockResolvedValueOnce` values. Or use `mockResolvedValue` (not `Once`) for default returns.

---

## Code Examples

### Full Pipeline Skeleton

```typescript
// Source: direct derivation from Phase 08-11 function signatures
export async function auditProductImages(
  row: SheetRow,
  rowIndex: number,
  shopifyClient: ShopifyClient,
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  costTracker: CostTracker,
): Promise<AuditResult> {
  const styleId = row.styleID;
  const colorName = row.colorName;
  const rawCategory = row.baseCategory;
  const categoryGroup: CategoryGroup = getCategoryGroup(rawCategory) ?? 'tops';

  const cdnUrls: { front?: string; back?: string; side?: string } = {};
  const viewResults: ViewAuditResult[] = [];

  // Step 1: Score existing images from sheet
  const existingUrls = {
    front: row.FrontImage || null,
    back: row.BackImage || null,
    side: row.DirectSideImage || null,
  };
  const scoredExisting: Record<string, { buffer: Buffer; verdict: 'pass' | 'fail'; score: number } | null> = {
    front: null, back: null, side: null,
  };
  for (const view of ['front', 'back', 'side'] as const) {
    const url = existingUrls[view];
    if (!url) continue;
    try {
      const buf = await downloadImage(url);
      const result = await scoreImageQuality(buf, categoryGroup);
      scoredExisting[view] = { buffer: buf, verdict: result.verdict, score: result.score };
    } catch (err) {
      logger.warn(`[audit-runner] Score failed for ${view} of ${styleId}: ${err}`);
    }
  }

  // Step 2: Source missing/failed views
  const needsSourcing = (['front', 'back', 'side'] as const).some(
    v => !scoredExisting[v] || scoredExisting[v]!.verdict === 'fail',
  );
  let sourced: SourcedImages = { front: null, back: null, side: null };
  if (needsSourcing) {
    sourced = await sourceImages(styleId, colorName);
  }

  // Step 3: Resolve best buffer per view
  // (existing pass > sourced > generate/enhance)
  let frontBuffer: Buffer | null = null;
  for (const view of ['front', 'back', 'side'] as const) {
    const existing = scoredExisting[view];
    if (existing?.verdict === 'pass') {
      // D-02: Always standardize, but don't re-source/generate
      if (view === 'front') frontBuffer = existing.buffer;
      // Will be standardized in Step 5
      continue;
    }

    const sourcedView = sourced[view];
    if (sourcedView) {
      // Already scored inside sourceImages — download buffer for standardization/generation
      try {
        const buf = await downloadImage(sourcedView.url);
        if (view === 'front') frontBuffer = buf;
        // Store for standardization
      } catch { /* skip this view */ }
    }
  }

  // Step 4: AI generate remaining gaps
  // (front: enhanceFrontImage if failing; back/side: generateGarmentView)
  // ...

  // Step 5: Standardize all acquired buffers and collect CDN URLs
  // ...

  // Step 6: Write CDN URLs to Google Sheets
  const updates = buildStandardizationUpdates(sheetName, rowIndex, cdnUrls);
  const cellsWritten = await writeUpdates(sheetsClient, spreadsheetId, updates);

  return { styleId, colorName, views: viewResults, cellsWritten, aiCostIncurred: 0 };
}
```

### Filename Convention for Staged Uploads

```typescript
// Consistent with processProductImages() pattern in image-standardizer.ts
const filename = `${row.productName}-${colorName}-${view}-std.png`
  .replace(/\s+/g, '-')
  .toLowerCase();
```

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | (project env) | — |
| vitest | Testing | Yes | 4.0.18 | — |
| sharp | Image processing | Yes | project dep | — |
| googleapis | Sheets writes | Yes | project dep | — |
| openai | AI generation | Yes | project dep | — |
| SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET | uploadStagedImage | Runtime env | — | — |
| GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY | writeUpdates | Runtime env | — | — |
| OPENAI_API_KEY | generateGarmentView | Runtime env | — | Skipped via budget exhaustion |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | none (uses package.json `"test": "vitest run"`) |
| Quick run command | `npx vitest run tests/lib/audit-runner.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

Phase 12 has no new functional requirements (it is the OUT-01 integration phase). Tests should verify orchestration behavior:

| Behavior | Test Type | Automated Command | File Exists? |
|----------|-----------|-------------------|-------------|
| Pass-existing view: standardized but not sourced/generated | unit | `npx vitest run tests/lib/audit-runner.test.ts` | No — Wave 0 |
| Failing view sourced successfully | unit | same | No — Wave 0 |
| Missing view generated by AI | unit | same | No — Wave 0 |
| Failing front enhanced by AI | unit | same | No — Wave 0 |
| Budget exhausted — generation skipped gracefully | unit | same | No — Wave 0 |
| All three CDN URLs written to correct sheet columns | unit | same | No — Wave 0 |
| Category null defaults to tops with warning | unit | same | No — Wave 0 |
| Full product error returns partial result, not throw | unit | same | No — Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/lib/audit-runner.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/lib/audit-runner.test.ts` — covers all orchestration behaviors above

---

## Open Questions

1. **How does the runner get `rowIndex` for a given `styleID`?**
   - What we know: `rowIndex` is required by `buildStandardizationUpdates`. The sheet reader returns `{ headers, rows }` — the rows array index is the 0-based data rowIndex.
   - What's unclear: The CLI (Phase 13) hasn't been designed yet. It may iterate all rows with index or look up a single row by styleID.
   - Recommendation: Accept `rowIndex` as an explicit parameter. The CLI iterates `rows.entries()` and passes both.

2. **Should existing passing images be re-uploaded to staged uploads just to produce "fresh" CDN URLs?**
   - What we know: D-02 requires re-standardizing even passing images. `standardizeImage()` produces a new buffer. `uploadStagedImage()` produces a new CDN URL.
   - What's unclear: Staged upload CDN URLs may eventually expire. Whether this is a concern is not stated.
   - Recommendation: Yes — always upload standardized buffers. The CDN URLs written to sheets should always reflect the 85%-scale standardized versions, not the original supplier URLs.

3. **When sourceImages returns a `SourcedView` with `verdict: 'fail'`, should the runner still use it?**
   - What we know: Per Phase 09 D-03, `pickBest` returns the best-scoring candidate regardless of verdict. A failed sourced image may be better than nothing.
   - What's unclear: The runner's decision tree for "use failing sourced image vs. generate" vs. "generate immediately."
   - Recommendation: If sourced verdict is 'fail' and front buffer exists: attempt AI generation/enhancement. If AI is budget-exhausted or returns null, fall back to the failing sourced image. This follows the Phase 10 D-04 fallback spirit.

---

## Sources

### Primary (HIGH confidence)
- `src/shopify/image-scorer.ts` — exact signature and return type of `scoreImageQuality()`
- `src/lib/image-sourcer.ts` — exact signature and return type of `sourceImages()`, `SourcedImages`, `SourcedView`
- `src/lib/ai-image-generator.ts` — exact signature of `generateGarmentView()`, `enhanceFrontImage()`
- `src/lib/ai-image-types.ts` — `GenerateViewResult`, `EnhanceFrontResult`, `AIView`, cost constants
- `src/lib/cost-tracker.ts` — `CostTracker` class API (`canAfford`, `record`, `remaining`, `estimateCost`)
- `src/shopify/image-standardizer.ts` — `standardizeImage()`, `uploadStagedImage()`, `buildStandardizationUpdates()`, `standardizeImagesToSheets()`, `downloadImage()`
- `src/sheets/types.ts` — `SheetRow` field names, `EnrichmentUpdate`
- `src/sheets/writer.ts` — `writeUpdates()` signature
- `src/sheets/column-map.ts` — `FrontImage=K`, `BackImage=L`, `DirectSideImage=M` column positions
- `src/shopify/variants.ts` — `getCategoryGroup()` return type including `null`
- `src/shopify/types.ts` — `CategoryGroup`, `ImageQualityResult`
- `.planning/STATE.md` — recorded decisions including Phase 11 D-03 (sheets-only output)
- `.planning/phases/12-audit-runner/12-CONTEXT.md` — locked decisions D-01 through D-04

### Secondary (MEDIUM confidence)
- `tests/lib/ai-image-generator.test.ts` — vitest mock patterns, `vi.resetAllMocks` vs `clearAllMocks` behavior
- `tests/shopify/image-standardizer.test.ts` — test structure patterns for this codebase

---

## Metadata

**Confidence breakdown:**
- Function signatures: HIGH — read directly from source files
- Pipeline decision logic: HIGH — locked in CONTEXT.md D-01 through D-04
- Test patterns: HIGH — observed in existing test files; vitest 4.0.18 confirmed installed
- Open questions 1-3: MEDIUM — design decisions left to Claude's discretion per CONTEXT.md

**Research date:** 2026-03-27
**Valid until:** 2026-04-27 (stable — no external library changes expected)
