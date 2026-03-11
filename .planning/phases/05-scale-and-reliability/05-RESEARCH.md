# Phase 5: Scale and Reliability - Research

**Researched:** 2026-03-10
**Domain:** Batch CLI orchestration, Shopify GraphQL rate limiting, dry-run pattern, per-item error isolation
**Confidence:** HIGH

---

## Summary

Phase 5 wraps the already-working `pushProduct` function in three operational capabilities: dry-run preview, batch processing with progress reporting, and per-product error isolation. The core product push logic does not change — the work is entirely at the orchestration layer: a new CLI script and a thin batch runner module.

The project already uses p-queue in its decisions log (noted as "p-queue v9 used (ESM-only, compatible with project ESM setup)"), but it is not yet installed. The primary complexity is Shopify's GraphQL rate limiting: the API uses a leaky-bucket cost model with 100 points/second restore rate (Standard plan) and a 1,000-point bucket. Each mutation costs roughly 10 points baseline. With 8 sequential API calls per product, naive batching will hit the bucket quickly. The right approach is sequential processing of products (one at a time), not parallel, with retry logic for THROTTLED responses.

Progress output uses process.stdout.write with \r overwrite — no external library needed for a simple "X/Y done (Z%)" indicator. cli-progress is a viable option if richer formatting is desired, but adds a dependency for minimal gain.

**Primary recommendation:** Build a `src/shopify/batch-push.ts` module that iterates products sequentially, catches per-product errors, prints progress inline, and supports a `--dry-run` flag that previews the push plan without making any Shopify API calls.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OPS-01 | Dry-run mode showing exactly what would be created/updated before pushing | Dry-run pattern: inspect sheet rows + buildProductSetInput + derive preview object; return without calling any Shopify mutations |
| OPS-02 | Batch-process 100+ products with progress reporting | Sequential iteration with inline stdout progress; p-queue (concurrency: 1) for clean control flow; retry on THROTTLED |
| OPS-03 | Per-product success/failure with actionable error messages, failures don't halt batch | try/catch per product, accumulate results array, continue on failure, print summary at end |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| p-queue | ^9.0.0 | Sequential queue with pause/resume/event hooks | Already decided (STATE.md); ESM-native, matches project `"type":"module"`; enables clean THROTTLED-based pausing |
| vitest | ^4.0.18 | Unit tests | Already in project; matches existing test suite |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| cli-progress | ^3.12.0 | Rich terminal progress bar | Only if stdout/\r approach is deemed too plain; adds 0 external dependencies of its own |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| p-queue | Manual for loop | For loop is simpler for sequential-only; p-queue adds pause/resume and event hooks that make retry + rate limit handling cleaner |
| p-queue | p-limit | p-limit controls concurrency count only; no interval or pause/resume — insufficient for THROTTLED retry |
| cli-progress | process.stdout.write + \r | \r approach has zero deps and is sufficient for "X/100 (Z%)" display |

**Installation:**
```bash
npm install p-queue
```
(cli-progress is optional — only add if richer progress display is requested)

---

## Architecture Patterns

### Recommended Project Structure
```
scripts/
└── push-batch.ts          # CLI entry point: parse args, call batchPush
src/shopify/
├── batch-push.ts          # Batch orchestrator: reads sheet, iterates products
├── product-push.ts        # Existing: pushProduct() — unchanged
└── dry-run.ts             # Dry-run preview builder: buildDryRunPreview()
```

### Pattern 1: Dry-Run Preview (OPS-01)

**What:** Before making any API calls, build a structured preview object per product using only the sheet data and pure functions. No Shopify mutations are called.

**When to use:** When `--dry-run` flag is present.

**Implementation approach:**
- Reuse `readAllRows` to load sheet data
- Group rows by `styleID` (same pattern as current `pushProduct`)
- For each styleID group: call `buildProductSetInput` (pure, no API calls) and derive color/size/variant counts from rows
- Print a table: styleID, product name, category, color count, size count, variant count, estimated Shopify action (CREATE or UPDATE based on handle lookup — or skip the handle check in dry-run to avoid any API calls)
- Return the preview array without touching Shopify

```typescript
// Source: derived from existing buildProductSetInput pattern in src/shopify/product-push.ts
export interface DryRunProduct {
  styleID: string;
  productName: string;
  baseCategory: string;
  handle: string;
  colorCount: number;
  sizeCount: number;
  variantCount: number;  // colorCount * sizeCount * 2 (print areas)
  supported: boolean;
  skipReason?: string;
}

export function buildDryRunPreview(allRows: SheetRow[]): DryRunProduct[] {
  const byStyle = groupByStyleID(allRows);
  return [...byStyle.entries()].map(([styleID, rows]) => {
    const result = buildProductSetInput(rows, []);
    if (!result) {
      return { styleID, productName: rows[0].productName, baseCategory: rows[0].baseCategory,
               handle: '', colorCount: 0, sizeCount: 0, variantCount: 0,
               supported: false, skipReason: `Unsupported category: ${rows[0].baseCategory}` };
    }
    const colors = new Set(rows.map(r => r.colorName)).size;
    const sizes  = new Set(rows.map(r => r.sizeName)).size;
    return { styleID, productName: rows[0].productName, baseCategory: rows[0].baseCategory,
             handle: result.identifier.handle, colorCount: colors, sizeCount: sizes,
             variantCount: colors * sizes * 2, supported: true };
  });
}
```

### Pattern 2: Sequential Batch with Per-Product Error Isolation (OPS-02, OPS-03)

**What:** Push products one at a time, catch errors per product, never halt the run on individual failure, print live progress, print summary at end.

**When to use:** Always in batch mode.

```typescript
// Source: p-queue docs + Shopify rate limit pattern
import PQueue from 'p-queue';

export interface BatchResult {
  styleID: string;
  status: 'success' | 'skipped' | 'failed';
  productGid?: string;
  variantCount?: number;
  skipReason?: string;
  error?: string;
}

export async function batchPush(styleIDs: string[]): Promise<BatchResult[]> {
  const queue = new PQueue({ concurrency: 1 });
  const results: BatchResult[] = [];
  const total = styleIDs.length;
  let done = 0;

  const tasks = styleIDs.map((styleID) =>
    queue.add(async () => {
      try {
        const result = await pushProduct(styleID);
        results.push({ styleID, status: 'success', ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes('Unsupported category') ? 'skipped' : 'failed';
        results.push({ styleID, status, error: message,
                       ...(status === 'skipped' ? { skipReason: message } : {}) });
      } finally {
        done++;
        printProgress(done, total, styleID);
      }
    })
  );

  await Promise.all(tasks);
  return results;
}
```

### Pattern 3: Shopify THROTTLED Retry

**What:** When Shopify returns a THROTTLED error (HTTP 200 with `errors[].extensions.code === 'THROTTLED'`), wait and retry the single product push, not the entire batch.

**Why needed:** 8 sequential mutations per product × 10 points each = ~80 points per product. Standard plan bucket = 1,000 points at 100/sec restore. With rapid iteration, consecutive products will exhaust the bucket.

**Implementation:** Wrap `pushProduct` in a retry helper within the batch runner.

```typescript
// Source: Shopify rate limit docs (shopify.dev/docs/api/usage/limits)
async function pushWithRetry(styleID: string, maxRetries = 3): Promise<BatchResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await pushProduct(styleID);
      return { styleID, status: 'success', ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isThrottled = message.toLowerCase().includes('throttl');
      if (isThrottled && attempt < maxRetries) {
        const waitMs = attempt * 2000; // 2s, 4s, 6s
        logger.warn(`THROTTLED on ${styleID}, retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      const status = message.includes('Unsupported category') ? 'skipped' : 'failed';
      return { styleID, status, error: message };
    }
  }
  return { styleID, status: 'failed', error: 'Max retries exceeded' };
}
```

### Pattern 4: Progress Output (OPS-02)

**What:** A single line that updates in place showing current product and completion percentage.

```typescript
// Source: Node.js process.stdout — no library needed
function printProgress(done: number, total: number, current: string): void {
  const pct = Math.round((done / total) * 100);
  process.stdout.write(`\r[${done}/${total}] ${pct}% — ${current}`.padEnd(80));
  if (done === total) process.stdout.write('\n');
}
```

### Pattern 5: Batch CLI Entry Point

```typescript
// scripts/push-batch.ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readAllRows } from '../src/sheets/reader.js';
import { createSheetsClient } from '../src/sheets/client.js';
import { batchPush } from '../src/shopify/batch-push.js';
import { buildDryRunPreview } from '../src/shopify/dry-run.js';

const { values, positionals } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true, // optional list of styleIDs to filter
});

// If no styleIDs given: process all supported products from sheet
// If styleIDs given: only those products
```

### Anti-Patterns to Avoid

- **Parallel product pushes:** Each product makes 8 serial API calls. Even `concurrency: 2` doubles rate limit pressure. Keep `concurrency: 1`.
- **Re-reading the sheet per product:** `readAllRows` reads 49,000 rows from Google Sheets — do it once per batch run, then filter per styleID in memory.
- **Throwing on first failure:** The whole point of OPS-03 is fault isolation. Every `pushProduct` call must be wrapped in try/catch.
- **Calling Shopify in dry-run:** Dry-run must use only pure functions (`buildProductSetInput`, `buildLinkedVariants`). No client.request calls.
- **Over-engineering retry:** Simple linear backoff (2s, 4s, 6s) is sufficient. No need for jitter or exponential for a 100-product run.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrency / queue management | Custom Promise pool | p-queue | Handles pause/resume, error isolation, event hooks correctly |
| Reading all sheet rows | Re-reading per product | Call `readAllRows` once, filter in memory | 49K rows × 100 products = 4.9M row reads; API quota issue |
| Grouping rows by styleID | Ad hoc array scans | `Map<string, SheetRow[]>` built once at start | O(n) scan once vs O(n²) repeated scans |

**Key insight:** The sheet reading optimization is the most important "don't hand-roll" item. The existing `pushProduct` calls `readAllRows` internally every invocation. The batch runner must hoist this call out and pass pre-filtered rows — or refactor `pushProduct` to accept pre-loaded rows as an argument.

---

## Common Pitfalls

### Pitfall 1: Sheet Re-Read Per Product
**What goes wrong:** Calling `batchPush` naively reuses `pushProduct` as-is. Each `pushProduct` call internally calls `readAllRows`, fetching all 49K rows from Google Sheets 100+ times.
**Why it happens:** `pushProduct` was designed for single-product use and owns its own data fetching.
**How to avoid:** Refactor `pushProduct` to accept a `rows: SheetRow[]` parameter (pre-filtered rows for that styleID), or create a `pushProductFromRows(rows: SheetRow[])` variant. Load sheet once in `batchPush`, filter per styleID, pass filtered rows.
**Warning signs:** First product push takes 1-2 seconds but the sheet quota error appears after product ~50.

### Pitfall 2: Shopify THROTTLED Breaks Entire Batch
**What goes wrong:** `pushProduct` throws on THROTTLED; if uncaught at the product level, the queue stops.
**Why it happens:** The `@shopify/admin-api-client` throws on HTTP-level errors. THROTTLED responses come back as HTTP 200 with error in body — the client may surface this differently than a network error.
**How to avoid:** Inspect error message text for "THROTTLED" or "throttl" (case-insensitive). Add retry in the batch runner's per-product wrapper, not inside `pushProduct` itself (keeps `pushProduct` clean).
**Warning signs:** Batch stops at product 8-12 on first run with a THROTTLED error in the log.

### Pitfall 3: Dry-Run Accidentally Calls Shopify
**What goes wrong:** Dry-run implementation calls `checkExistingProduct` (a Shopify query) to show CREATE vs UPDATE status.
**Why it happens:** Temptation to make dry-run "more accurate" by checking live state.
**How to avoid:** Skip the CREATE/UPDATE distinction in dry-run entirely. Only show: styleID, product name, category, variant count, supported/skip. The "what would happen" question is answered by the variant count and support status.
**Warning signs:** Dry-run requires SHOPIFY_* environment variables to run.

### Pitfall 4: Progress Output Breaks Winston Logs
**What goes wrong:** `logger.info(...)` (via Winston) and `process.stdout.write('\r...')` interleave — the \r progress line gets broken by logger output.
**Why it happens:** Winston writes to the same stdout with its own newlines.
**How to avoid:** During batch run, suppress per-product `logger.info` calls (set LOG_LEVEL=warn for batch runs, or pass a `verbose: false` option to `pushProduct`). Print only the progress line during the run; print detailed errors after the summary.
**Warning signs:** Terminal output looks garbled mid-batch.

### Pitfall 5: Counting Products vs Sheet Rows
**What goes wrong:** `allRows.length` returns 49K rows, not product count. Progress shows "1/49000".
**Why it happens:** Each product has multiple rows (one per color × size combination).
**How to avoid:** After loading sheet, group by `styleID` to get unique product count. Progress is over the `styleIDs.length` (number of distinct products), not row count.
**Warning signs:** `total` in progress output is 49,000.

---

## Code Examples

Verified patterns from the existing codebase:

### Reading Sheet Once and Grouping by StyleID
```typescript
// Pattern derived from pushProduct (src/shopify/product-push.ts lines 86-98)
const sheets = createSheetsClient();
const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!;
const { rows: allRows } = await readAllRows(sheets, spreadsheetId);

const byStyleID = new Map<string, SheetRow[]>();
for (const row of allRows) {
  if (!byStyleID.has(row.styleID)) byStyleID.set(row.styleID, []);
  byStyleID.get(row.styleID)!.push(row);
}
```

### Refactored pushProduct Signature (Required for Batch)
```typescript
// Current: pushProduct(styleID: string) — reads sheet internally
// Required for batch: accept pre-loaded rows

export async function pushProductFromRows(
  rows: SheetRow[],  // pre-filtered to a single styleID
): Promise<{ productGid: string; variantCount: number }> {
  // All existing logic unchanged, just remove the readAllRows call
  // and the rows.filter(...) call at the top
}
```

### Batch Summary Output
```typescript
function printSummary(results: BatchResult[]): void {
  const success = results.filter(r => r.status === 'success');
  const failed  = results.filter(r => r.status === 'failed');
  const skipped = results.filter(r => r.status === 'skipped');

  console.log('\n--- Batch Complete ---');
  console.log(`Success: ${success.length} | Failed: ${failed.length} | Skipped: ${skipped.length}`);

  if (failed.length > 0) {
    console.log('\nFailed products:');
    failed.forEach(r => console.log(`  ${r.styleID}: ${r.error}`));
  }
  if (skipped.length > 0) {
    console.log('\nSkipped products:');
    skipped.forEach(r => console.log(`  ${r.styleID}: ${r.skipReason}`));
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| REST API rate limits (REST calls/minute) | GraphQL cost-point bucket (leaky bucket, per query complexity) | Shopify 2019+ | Must respect throttleStatus in response extensions, not just 429 count |
| Per-product script calls (npx tsx push-product.ts ST100) | Batch orchestrator with single sheet load | This phase | 100x reduction in Google Sheets API calls |

**Deprecated/outdated:**
- Checking HTTP 429 as the sole throttle signal: Shopify GraphQL returns HTTP 200 with THROTTLED in the error body. HTTP 429 is the fallback, not the primary signal.

---

## Open Questions

1. **Does `pushProduct` need a new signature for batch use, or a wrapper?**
   - What we know: `pushProduct(styleID)` reads the entire sheet internally on every call.
   - What's unclear: Whether the planner should add a new `pushProductFromRows(rows)` export (breaking change to existing callers) or add a `batchPush` module that handles the sheet loading and passes rows in.
   - Recommendation: Add `pushProductFromRows(rows: SheetRow[])` as a new export alongside the existing `pushProduct`. The existing single-product CLI continues to work unchanged. Batch uses the new entry point.

2. **Exact THROTTLED error shape from `@shopify/admin-api-client`**
   - What we know: The client is `@shopify/admin-api-client` v1.1.1. Shopify GraphQL returns throttle info in `extensions.cost.throttleStatus`.
   - What's unclear: Whether the client throws an Error object, returns the raw response, or has special handling for THROTTLED. The retry logic must be validated against what the client actually surfaces.
   - Recommendation: In the first batch test, log the raw error object when THROTTLED occurs to confirm the message format before finalizing the retry string check.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run tests/shopify/batch-push.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OPS-01 | `buildDryRunPreview` returns correct product count, variant estimates, skip reasons for unsupported categories | unit | `npx vitest run tests/shopify/dry-run.test.ts` | ❌ Wave 0 |
| OPS-02 | `batchPush` iterates all products, calls pushProduct for each, reports progress | unit (mocked pushProduct) | `npx vitest run tests/shopify/batch-push.test.ts` | ❌ Wave 0 |
| OPS-03 | `batchPush` continues after individual product failure, collects error in result | unit (mock throws on specific styleID) | `npx vitest run tests/shopify/batch-push.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/shopify/`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/shopify/batch-push.test.ts` — covers OPS-02, OPS-03
- [ ] `tests/shopify/dry-run.test.ts` — covers OPS-01

*(No framework gaps — vitest already installed and configured)*

---

## Sources

### Primary (HIGH confidence)
- `src/shopify/product-push.ts` — existing push flow, 8-step API sequence, current signature
- `scripts/push-product.ts` — existing CLI, parseArgs pattern to follow
- `package.json` — current dependencies and dev dependencies
- `.planning/STATE.md` — confirmed decisions: p-queue v9, sequential extraction
- [shopify.dev/docs/api/usage/limits](https://shopify.dev/docs/api/usage/limits) — GraphQL rate limit bucket system, throttleStatus extensions field, 100 points/sec restore rate

### Secondary (MEDIUM confidence)
- [github.com/sindresorhus/p-queue](https://github.com/sindresorhus/p-queue) — v9.0.0 current, ESM-native, `concurrency` + `interval`/`intervalCap` options, events
- [npmjs.com/package/cli-progress](https://www.npmjs.com/package/cli-progress) — v3.12.0, TypeScript types included, optional dependency

### Tertiary (LOW confidence)
- Community reports that productSet costs ~10+ points per call (not officially documented with exact numbers per mutation) — treat as estimate only

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — p-queue was already decided; vitest already installed; no new libraries required
- Architecture: HIGH — dry-run pattern is deterministic from existing pure functions; batch-push pattern is straightforward sequential iteration with try/catch
- Pitfalls: HIGH — sheet re-read per product is observable from code; THROTTLED handling is confirmed by Shopify docs; progress/logger interleave is a known Winston issue
- Shopify mutation cost numbers: LOW — exact cost per productSet/productVariantsBulkCreate call is not officially documented; retry pattern is necessary but wait times are estimates

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (Shopify API limits are stable; p-queue v9 API is stable)
