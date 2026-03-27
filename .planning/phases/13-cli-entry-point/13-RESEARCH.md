# Phase 13: CLI Entry Point - Research

**Researched:** 2026-03-26
**Domain:** TypeScript CLI scripting, Google Sheets iteration, Shopify client, dry-run patterns
**Confidence:** HIGH

## Summary

Phase 13 wires the completed `auditProductImages()` orchestrator (Phase 12) to a user-facing CLI script. The project has two established patterns for CLI scripts: one using `node:util parseArgs` (push-product.ts) and one using hand-rolled `process.argv` parsing (enrich.ts, enrich-decoration.ts). Both are acceptable, but `parseArgs` is the newer Node.js built-in approach and avoids custom parsing loops.

The Shopify and Google Sheets clients are already factored into thin, async factory functions (`createShopifyClient()` and `createSheetsClient()`). The sheet reader (`readAllRows()`) returns typed `SheetRow[]` with 0-based data row indices matching what `auditProductImages()` expects. The `CostTracker` must be constructed once and passed into every `auditProductImages()` call — it is never instantiated internally.

Dry-run for this phase means skipping the `uploadStagedImage()` / `writeUpdates()` calls — the score/source/generate pipeline still runs. Since `auditProductImages()` does not accept a `dryRun` flag itself, the CLI cannot inject dry-run behavior through a parameter. The correct approach is to not pass `--dry-run` down but instead intercept results and skip writes — or, more practically (given the requirements note that dry-run is a deferred future requirement from OPS-01), implement a lightweight version that simply logs what would happen without the full pipeline.

**Primary recommendation:** Use `node:util parseArgs` for argument parsing. Initialize Shopify and Sheets clients before the loop. Construct one `CostTracker` instance before the loop. For `--dry-run`, skip the actual `auditProductImages()` call and instead log that it would be processed — since `auditProductImages()` does writes internally and there is no dry-run seam in that function.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OUT-01 | Running the image pipeline produces e-commerce-ready front/back/side images for each product, uploaded to Shopify | `auditProductImages()` in audit-runner.ts handles the full pipeline. CLI wires `--style-id`, `--all`, and `--dry-run` flags to call it; prints per-product results to console. |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:util` parseArgs | Node.js 18+ built-in | CLI argument parsing | Already used in push-product.ts; no extra dependency |
| `dotenv/config` | ^17.3.1 (installed) | Load .env before any other code | Used by every existing script |
| `createShopifyClient` | internal | Shopify Admin API client | Used by push-product.ts, calibrate-scorer.ts |
| `createSheetsClient` | internal | Google Sheets API client | Used by enrich.ts, enrich-decoration.ts |
| `readAllRows` | internal | Fetch and parse all sheet rows | Used by enrich.ts; returns typed SheetRow[] |
| `auditProductImages` | internal (Phase 12) | Per-product image pipeline | The main unit of work for this CLI |
| `CostTracker` | internal (Phase 10) | AI budget enforcement across all products | Must be injected; never constructed inside auditProductImages |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `winston logger` | internal | Structured logging | Already used throughout pipeline; avoid raw console.log in lib code but console.log is correct in CLI scripts |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:util parseArgs` | hand-rolled `process.argv` loop | enrich.ts uses hand-rolled; parseArgs is cleaner for boolean flags with multiple options |
| `node:util parseArgs` | `commander`, `yargs` | No additional dependency needed; parseArgs handles this CLI's simple flag set |

**Installation:** No new packages required. All dependencies are already installed.

## Architecture Patterns

### Recommended Project Structure

```
scripts/
└── audit-images.ts       # New CLI entry point (this phase)

src/
├── lib/
│   ├── audit-runner.ts   # auditProductImages() — no changes needed
│   └── cost-tracker.ts   # CostTracker — no changes needed
└── sheets/
    └── reader.ts         # readAllRows() — no changes needed
```

### Pattern 1: Script File Layout

**What:** Every CLI script in this project follows the same structure.
**When to use:** Always — this is the project convention.

```typescript
// Source: scripts/push-product.ts, scripts/enrich.ts (verified by direct read)
import 'dotenv/config';                      // FIRST import — loads env before anything else
import { parseArgs } from 'node:util';
import { createShopifyClient } from '../src/shopify/client.js';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { auditProductImages } from '../src/lib/audit-runner.js';
import { CostTracker } from '../src/lib/cost-tracker.js';

async function main(): Promise<void> {
  // 1. Parse args
  // 2. Show help or validate args, exit 0/1
  // 3. Initialize clients
  // 4. Do work
  // 5. Print summary
}

main().catch((error: Error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exit(1);
});
```

### Pattern 2: Argument Parsing with `node:util parseArgs`

**What:** The Node.js 18+ built-in for structured argument parsing.
**When to use:** Preferred for boolean flags and string options.

```typescript
// Source: scripts/push-product.ts (verified by direct read)
const { values, positionals } = parseArgs({
  options: {
    'style-id': { type: 'string' },
    all:        { type: 'boolean', default: false },
    'dry-run':  { type: 'boolean', default: false },
    help:       { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

const styleId  = values['style-id'];
const runAll   = values.all ?? false;
const dryRun   = values['dry-run'] ?? false;

if (!styleId && !runAll) {
  console.error('Error: provide --style-id <ID> or --all');
  process.exit(1);
}
```

### Pattern 3: Client Initialization

**What:** Both Shopify and Sheets clients are initialized before the loop.
**When to use:** Always — initialize once, pass everywhere.

```typescript
// Source: scripts/calibrate-scorer.ts, src/sheets/client.ts (verified by direct read)
const shopifyClient = await createShopifyClient();   // async — fetches OAuth token
const sheetsClient  = createSheetsClient();           // sync — builds auth from env vars

const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? '';
const sheetName     = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

if (!spreadsheetId) {
  console.error('Error: GOOGLE_SPREADSHEET_ID not set');
  process.exit(1);
}
```

### Pattern 4: Reading Sheet Rows and Matching by styleID

**What:** `readAllRows()` returns `{ headers, rows }` where `rows` is `SheetRow[]`. The 0-based `rowIndex` passed to `auditProductImages()` matches the data array index.
**When to use:** For both `--all` and `--style-id` modes.

```typescript
// Source: src/sheets/reader.ts (verified by direct read)
const { rows } = await readAllRows(sheetsClient, spreadsheetId, sheetName);

if (styleId) {
  // Single product mode
  const rowIndex = rows.findIndex(r => r.styleID === styleId);
  if (rowIndex === -1) {
    console.error(`Error: style ID ${styleId} not found in sheet`);
    process.exit(1);
  }
  const row = rows[rowIndex];
  // rowIndex here is correct — it is the 0-based data row index
  await auditProductImages(row, rowIndex, shopifyClient, sheetsClient, spreadsheetId, sheetName, costTracker);
} else {
  // --all mode
  for (let i = 0; i < rows.length; i++) {
    await auditProductImages(rows[i], i, shopifyClient, sheetsClient, spreadsheetId, sheetName, costTracker);
  }
}
```

### Pattern 5: CostTracker Initialization and Budget Reporting

**What:** One `CostTracker` is constructed before the loop. After all products, print total spend.
**When to use:** Always — per Phase 12 decision: CostTracker always injected into auditProductImages, never created internally.

```typescript
// Source: src/lib/cost-tracker.ts (verified by direct read)
const costTracker = new CostTracker();  // uses DEFAULT_BUDGET = $200

// After processing:
console.log(`AI cost incurred: $${costTracker.total.toFixed(4)}`);
console.log(`Budget remaining: $${costTracker.remaining.toFixed(4)}`);
```

### Pattern 6: Dry-Run Implementation

**What:** `auditProductImages()` has no dry-run parameter — it always scores, sources, generates, standardizes, and writes. The correct CLI-level dry-run skips the call entirely and logs what would happen.
**When to use:** When `--dry-run` flag is set.

```typescript
// Dry-run approach (verified by reading audit-runner.ts signature)
// auditProductImages() signature:
//   (row, rowIndex, shopifyClient, sheetsClient, spreadsheetId, sheetName, costTracker)
// No dryRun parameter exists.
//
// Since OPS-01 (dry-run) is listed as a DEFERRED future requirement,
// the CLI should implement a minimal version: log which rows would be processed,
// then exit without calling auditProductImages().

if (dryRun) {
  console.log('[DRY RUN] Would process:');
  for (const row of targetRows) {
    console.log(`  ${row.styleID} — ${row.colorName} — ${row.baseCategory}`);
  }
  console.log(`[DRY RUN] ${targetRows.length} product(s) would be audited. No changes made.`);
  process.exit(0);
}
```

### Pattern 7: Result Logging per Product

**What:** Print one line per product showing status of each view.
**When to use:** Always — matches the console-first UX established in enrich.ts and push-product.ts.

```typescript
// Source: AuditResult interface in src/lib/audit-runner.ts (verified by direct read)
// AuditResult: { styleId, colorName, views: ViewAuditResult[], cellsWritten, aiCostIncurred, error? }
// ViewAuditResult: { view, status, score, cdnUrl, reason? }

function printResult(result: AuditResult): void {
  const prefix = result.error ? 'ERROR' : 'OK';
  console.log(`[${prefix}] ${result.styleId} (${result.colorName})`);
  for (const v of result.views) {
    const score = v.score !== null ? `score=${v.score}` : 'no-score';
    console.log(`  ${v.view}: ${v.status} | ${score} | ${v.cdnUrl ?? 'no-url'}${v.reason ? ` (${v.reason})` : ''}`);
  }
  if (result.error) {
    console.error(`  Error: ${result.error}`);
  }
  console.log(`  cells written: ${result.cellsWritten}, AI cost: $${result.aiCostIncurred.toFixed(4)}`);
}
```

### Anti-Patterns to Avoid

- **Constructing CostTracker inside the loop:** Each product would get an independent $200 budget. Budget is shared across the full batch.
- **Calling `createSheetsClient()` async:** It is synchronous — no `await` needed.
- **Calling `createShopifyClient()` without await:** It is async (fetches OAuth token).
- **Passing `rowIndex + 1` as the row index:** `readAllRows()` strips the header row. `rows[0]` is data row 1 (sheet row 2). `auditProductImages()` expects the 0-based data array index, not the sheet row number. Do not add 1.
- **Using `process.argv.slice(2)` with manual string matching when parseArgs is simpler:** enrich.ts does this but push-product.ts shows the cleaner approach.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Arg parsing | Manual loop over `process.argv` | `node:util parseArgs` | Built-in, handles short flags, defaults, type validation |
| Sheet row reading | Custom Sheets API calls | `readAllRows()` | Already handles header parsing, padding, HEADER_ALIASES, supplierCode normalization |
| Shopify auth | Custom token management | `createShopifyClient()` | Already handles token caching, expiry, OAuth flow |
| Google auth | Custom credential handling | `createSheetsClient()` | Already handles private key unescaping, scopes |
| Image pipeline | Any part of score/source/generate/standardize/upload | `auditProductImages()` | Phase 12 — fully implemented and tested |
| Budget tracking | Custom cost accumulator | `CostTracker` | Handles canAfford(), record(), total, remaining |

**Key insight:** This phase is pure wiring. Every non-trivial operation is already implemented. The CLI is ~100 lines of setup, argument handling, iteration, and console output.

## Common Pitfalls

### Pitfall 1: Wrong Row Index
**What goes wrong:** Sheet row numbers (1-indexed, including header) don't match `rowIndex` expected by `auditProductImages()`.
**Why it happens:** `readAllRows()` returns data rows starting at index 0, where index 0 = sheet row 2. If you pass `i + 1` or use raw sheet row numbers, standardization writes to wrong cells.
**How to avoid:** Use the array index `i` directly from `rows.forEach((row, i) => ...)` — this is the correct 0-based data row index.
**Warning signs:** Sheet writes appear one row off in the spreadsheet.

### Pitfall 2: CostTracker Created Per Product
**What goes wrong:** Each product gets its own $200 budget instead of sharing one budget across the batch.
**Why it happens:** Constructing `new CostTracker()` inside the loop or inside `auditProductImages()` (which is forbidden by design).
**How to avoid:** Construct one `CostTracker` before any loop, pass it into every `auditProductImages()` call.
**Warning signs:** AI cost per batch exceeds budget expectation significantly.

### Pitfall 3: Missing `dotenv/config` as First Import
**What goes wrong:** Environment variables are undefined when clients try to read them.
**Why it happens:** `createShopifyClient()` and `createSheetsClient()` read env vars at call time, not at module load. If `dotenv/config` isn't first, env vars won't be loaded.
**How to avoid:** `import 'dotenv/config';` must be the first import in the script.
**Warning signs:** "Missing SHOPIFY_STORE_DOMAIN" errors even when .env is present.

### Pitfall 4: Calling createSheetsClient() with await
**What goes wrong:** TypeScript error or unexpected promise chaining.
**Why it happens:** `createSheetsClient()` is synchronous — it constructs auth credentials from env vars and returns a Sheets client synchronously.
**How to avoid:** `const sheetsClient = createSheetsClient();` (no await).
**Warning signs:** TypeScript complaining about `sheets_v4.Sheets` not being awaitable.

### Pitfall 5: styleID match is case/whitespace sensitive
**What goes wrong:** `rows.findIndex(r => r.styleID === styleId)` returns -1 even when the style exists.
**Why it happens:** `readAllRows()` normalizes `supplierCode` but not `styleID`. Sheet values may have trailing whitespace.
**How to avoid:** Trim the CLI input and compare with trim: `r.styleID.trim() === styleId.trim()`.
**Warning signs:** Style found manually in sheet but CLI reports "not found".

## Code Examples

Verified patterns from source code inspection:

### Complete CLI skeleton

```typescript
// scripts/audit-images.ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createShopifyClient } from '../src/shopify/client.js';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { auditProductImages, type AuditResult } from '../src/lib/audit-runner.js';
import { CostTracker } from '../src/lib/cost-tracker.js';

function showHelp(): void {
  console.log(`
Image Audit CLI

Usage:
  npx tsx scripts/audit-images.ts --style-id <ID>   Audit one product
  npx tsx scripts/audit-images.ts --all              Audit all products in sheet
  npx tsx scripts/audit-images.ts --dry-run --all    Preview without writing
  npx tsx scripts/audit-images.ts --help             Show this help

Environment variables required:
  SHOPIFY_STORE_DOMAIN          Shopify store domain
  SHOPIFY_CLIENT_ID             Shopify app client ID
  SHOPIFY_CLIENT_SECRET         Shopify app client secret
  GOOGLE_SERVICE_ACCOUNT_EMAIL  GCP service account email
  GOOGLE_PRIVATE_KEY            GCP service account private key
  GOOGLE_SPREADSHEET_ID         Google Sheets spreadsheet ID
  GOOGLE_SHEET_NAME             Sheet tab name (default: Sheet1)
`);
}

function printResult(result: AuditResult): void {
  const prefix = result.error ? 'ERROR' : 'OK';
  console.log(`[${prefix}] ${result.styleId} (${result.colorName})`);
  for (const v of result.views) {
    const score = v.score !== null ? `score=${v.score}` : 'no-score';
    console.log(
      `  ${v.view}: ${v.status} | ${score} | ${v.cdnUrl ?? 'no-url'}` +
      (v.reason ? ` (${v.reason})` : ''),
    );
  }
  console.log(
    `  cells written: ${result.cellsWritten}, AI cost: $${result.aiCostIncurred.toFixed(4)}`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'style-id': { type: 'string' },
      all:        { type: 'boolean', default: false },
      'dry-run':  { type: 'boolean', default: false },
      help:       { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) { showHelp(); process.exit(0); }

  const styleId = values['style-id'];
  const runAll  = values.all ?? false;
  const dryRun  = values['dry-run'] ?? false;

  if (!styleId && !runAll) {
    console.error('Error: provide --style-id <ID> or --all. Run --help for usage.');
    process.exit(1);
  }

  // Client initialization
  const shopifyClient = await createShopifyClient();
  const sheetsClient  = createSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? '';
  const sheetName     = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';

  if (!spreadsheetId) {
    console.error('Error: GOOGLE_SPREADSHEET_ID not set');
    process.exit(1);
  }

  const { rows } = await readAllRows(sheetsClient, spreadsheetId, sheetName);

  // Determine target rows
  let targetRows: Array<{ row: typeof rows[0]; index: number }>;

  if (styleId) {
    const idx = rows.findIndex(r => r.styleID.trim() === styleId.trim());
    if (idx === -1) {
      console.error(`Error: style ID '${styleId}' not found in sheet`);
      process.exit(1);
    }
    targetRows = [{ row: rows[idx], index: idx }];
  } else {
    targetRows = rows.map((row, index) => ({ row, index }));
  }

  // Dry-run: log and exit
  if (dryRun) {
    console.log('[DRY RUN] Would process:');
    for (const { row } of targetRows) {
      console.log(`  ${row.styleID} — ${row.colorName} — ${row.baseCategory}`);
    }
    console.log(`[DRY RUN] ${targetRows.length} product(s). No changes made.`);
    process.exit(0);
  }

  // Shared CostTracker for the entire batch
  const costTracker = new CostTracker();
  let totalCells = 0;
  let errors = 0;

  for (const { row, index } of targetRows) {
    console.log(`\nProcessing ${row.styleID} (${row.colorName})...`);
    const result = await auditProductImages(
      row, index, shopifyClient, sheetsClient, spreadsheetId, sheetName, costTracker,
    );
    printResult(result);
    totalCells += result.cellsWritten;
    if (result.error) errors++;
  }

  console.log('\n=== Audit Summary ===');
  console.log(`  Products processed: ${targetRows.length}`);
  console.log(`  Errors:             ${errors}`);
  console.log(`  Total cells written: ${totalCells}`);
  console.log(`  AI cost incurred:   $${costTracker.total.toFixed(4)}`);
  console.log(`  Budget remaining:   $${costTracker.remaining.toFixed(4)}`);

  if (errors > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exit(1);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `process.argv` manual loop | `node:util parseArgs` | Node.js 18 | Built-in, no extra dep, cleaner flag handling |
| `npx ts-node` | `npx tsx` | Project uses tsx already (in package.json) | tsx is faster for dev, supports ESM natively |

**Deprecated/outdated:**
- `ts-node`: Not installed in this project. All existing scripts use `npx tsx`. The phase description says `npx ts-node` but the project uses `tsx` — use `npx tsx scripts/audit-images.ts`.

## Open Questions

1. **`npx ts-node` vs `npx tsx` in phase description**
   - What we know: Phase description says `npx ts-node scripts/audit-images.ts` but the project exclusively uses `tsx` (package.json devDependencies, package.json scripts, all existing CLI docs).
   - What's unclear: Whether the phase description was intentional or a copy-paste.
   - Recommendation: Use `npx tsx` — consistent with all existing scripts. The plan should document both in the help text but recommend tsx.

2. **Multiple rows with the same styleID**
   - What we know: `findIndex()` returns the first match only. The sheet may have multiple rows per style (one per color/size combination).
   - What's unclear: Whether `--style-id` should process all matching rows or just the first.
   - Recommendation: Process all rows with matching styleID, since `auditProductImages()` takes one row at a time and each color is a separate row.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js `node:util` parseArgs | Arg parsing | ✓ | Built-in (Node 18+) | — |
| tsx | Script execution | ✓ | ^4.21.0 (devDep) | — |
| `auditProductImages` | Pipeline | ✓ | Phase 12 complete | — |
| `readAllRows` | Sheet iteration | ✓ | src/sheets/reader.ts | — |
| `createShopifyClient` | Shopify upload | ✓ | src/shopify/client.ts | — |
| `createSheetsClient` | Sheet writes | ✓ | src/sheets/client.ts | — |
| `CostTracker` | Budget enforcement | ✓ | src/lib/cost-tracker.ts | — |

**Missing dependencies with no fallback:** None.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.x |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run tests/scripts/audit-images.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OUT-01 | `--style-id CSW-12345` calls `auditProductImages` with correct row and index | unit | `npx vitest run tests/scripts/audit-images.test.ts` | ❌ Wave 0 |
| OUT-01 | `--all` calls `auditProductImages` for every row | unit | `npx vitest run tests/scripts/audit-images.test.ts` | ❌ Wave 0 |
| OUT-01 | `--dry-run` logs products and exits 0 without calling `auditProductImages` | unit | `npx vitest run tests/scripts/audit-images.test.ts` | ❌ Wave 0 |
| OUT-01 | Missing `--style-id` and `--all` exits with code 1 | unit | `npx vitest run tests/scripts/audit-images.test.ts` | ❌ Wave 0 |
| OUT-01 | Unknown styleID exits with code 1 | unit | `npx vitest run tests/scripts/audit-images.test.ts` | ❌ Wave 0 |

Note: CLI scripts are difficult to unit test directly (they call `process.exit`). The recommended approach is to extract `main()` logic into a testable function that accepts injected dependencies, or test the behavior by mocking `process.exit` and verifying `auditProductImages` mock call counts — matching the pattern used in audit-runner.test.ts.

### Sampling Rate

- **Per task commit:** `npx vitest run tests/scripts/audit-images.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/scripts/audit-images.test.ts` — covers OUT-01 (all flag combinations)
- [ ] No framework install needed — vitest already configured

## Sources

### Primary (HIGH confidence)

- `scripts/push-product.ts` — `node:util parseArgs` usage pattern, main() structure
- `scripts/enrich.ts` — dry-run flag pattern, summary output format
- `scripts/enrich-decoration.ts` — minimal dry-run implementation pattern
- `scripts/calibrate-scorer.ts` — `createShopifyClient()` usage, stderr vs stdout
- `src/lib/audit-runner.ts` — `auditProductImages()` full signature and AuditResult type
- `src/lib/cost-tracker.ts` — CostTracker API (constructor, total, remaining, canAfford)
- `src/sheets/client.ts` — `createSheetsClient()` is synchronous
- `src/sheets/reader.ts` — `readAllRows()` returns 0-based data row SheetRow[]
- `src/sheets/types.ts` — SheetRow field names (styleID, colorName, baseCategory)
- `package.json` — tsx (not ts-node) is the installed runner
- `vitest.config.ts` — globals: false, no special test setup

### Secondary (MEDIUM confidence)

- Node.js 18+ official docs for `node:util parseArgs` — confirmed as available given tsx ^4.21.0 requires Node.js 18+

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — verified by reading every referenced source file directly
- Architecture: HIGH — derived from existing scripts in same project
- Pitfalls: HIGH — identified from type signatures and data flow of called functions
- Dry-run approach: HIGH — verified by reading audit-runner.ts (no dryRun param exists)

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (stable internal codebase; no external moving parts)
