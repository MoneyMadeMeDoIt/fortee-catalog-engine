# Phase 2: Google Sheets Integration - Research

**Researched:** 2026-03-05
**Domain:** Google Sheets API v4, Node.js/TypeScript, service account auth
**Confidence:** HIGH

## Summary

Phase 2 requires reading product variant rows from a Google Sheets spreadsheet, matching them to supplier data from Phase 1 extractors, and writing enriched data back to empty cells only. The Google Sheets API v4 is mature and well-documented, with clear batch read/write operations that fit this use case perfectly.

The `googleapis` npm package (official Google client) is the standard choice. While it is CJS-only, the project already uses `tsx` for execution which handles CJS/ESM interop transparently (same pattern as the existing `winston` import). Service account authentication is straightforward -- store the service account email and private key in `.env`, share the sheet with the service account email, and authenticate via `google.auth.GoogleAuth`.

**Primary recommendation:** Use `googleapis` with `spreadsheets.values.get` to read all rows in one call, diff against supplier data to find empty cells, then use `spreadsheets.values.batchUpdate` to write all changes in a single API call per enrichment run.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Each row = one product variant, identified by **PartID** (unique key)
- Multiple rows share the same styleID (one product = many variants across size/color)
- Sheet already exists with populated data -- this is enrichment, not creation
- System scans the entire sheet, not a subset of rows
- 35 columns in the master sheet (Identity, Product, Images, Color, Size, Pricing, Logistics, Classification, Details)
- **Fill gaps only** -- only write to cells that are currently empty
- Never overwrite existing data, even if supplier data is newer/different
- Existing images from the spreadsheet are higher quality and take priority
- OneSource API images should ONLY fill missing image cells
- Size charts stored as **structured text** (not image URLs)
- Service account authentication
- Credentials stored in `.env` (never committed)

### Claude's Discretion
- Google Sheets library choice (googleapis vs simpler wrapper)
- Batch write strategy (row-by-row vs batch update)
- How to handle variants that don't match any supplier data
- Rate limiting approach for Sheets API
- Logging format for enrichment results

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SHEET-01 | System can read product rows from Google Sheets via API (service account auth) | googleapis + GoogleAuth with service account credentials; spreadsheets.values.get for full sheet read |
| SHEET-02 | System can write enriched data back to Google Sheets | spreadsheets.values.batchUpdate with RAW valueInputOption; fill-gaps-only merge logic |
| SHEET-03 | System automatically merges supplier data into the correct sheet columns per product | Column mapping config + SupplierProduct-to-sheet-column mapper; match by styleID/PartID |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| googleapis | ^171.0.0 | Google Sheets API v4 client | Official Google client, includes full TypeScript types, built-in auth helpers |
| google-auth-library | (bundled) | Service account JWT auth | Comes with googleapis, handles token refresh automatically |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| dotenv | ^17.3.1 | Load .env credentials | Already in project -- load GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SPREADSHEET_ID |
| winston | ^3.19.0 | Logging | Already in project -- log enrichment progress and results |
| zod | ^4.3.6 | Schema validation | Already in project -- validate sheet row data and column mapping |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| googleapis | google-spreadsheet (npm) | Simpler row-based API but adds another dependency; googleapis is official, already typed, handles auth natively |
| googleapis | @googleapis/sheets | Standalone sheets-only package but same CJS situation, less community examples |

**Decision: Use `googleapis`.** It is the official Google package, has the most documentation and examples, includes auth helpers, and the CJS limitation is a non-issue because the project runs via `tsx` (which already handles CJS interop for winston, dotenv, etc.).

**Installation:**
```bash
npm install googleapis
```

No additional auth library needed -- `google-auth-library` is bundled with `googleapis`.

## Architecture Patterns

### Recommended Project Structure
```
src/
  sheets/
    client.ts          # Google Sheets API client singleton (auth + connection)
    reader.ts          # Read all rows, parse into typed SheetRow[]
    writer.ts          # Build batchUpdate payload, write enriched cells
    column-map.ts      # Maps supplier fields to sheet column letters/indices
    types.ts           # SheetRow interface, column definitions, enrichment types
    merge.ts           # Core merge logic: supplier data + sheet row -> changes
  suppliers/           # (Phase 1 - exists)
  lib/                 # (exists - logger, onesource-client)
```

### Pattern 1: Sheets Client Singleton
**What:** Create and export a configured Sheets API client, authenticated with service account credentials from .env.
**When to use:** Every sheets operation needs an authenticated client.
**Example:**
```typescript
// Source: Google Sheets API Node.js quickstart + official googleapis docs
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export function createSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: SCOPES,
  });

  return google.sheets({ version: 'v4', auth });
}
```

### Pattern 2: Full Sheet Read with Header Mapping
**What:** Read the entire sheet with `spreadsheets.values.get`, use row 1 as headers to build a column index map, then parse remaining rows into typed objects.
**When to use:** For the initial read of all product rows.
**Example:**
```typescript
// Source: Google Sheets API values guide
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: 'Sheet1', // reads entire sheet
});

const rows = response.data.values;
if (!rows || rows.length === 0) throw new Error('Sheet is empty');

const headers = rows[0]; // Row 1 = column headers
const dataRows = rows.slice(1); // Remaining rows = data

// Build header->index map
const columnIndex = new Map<string, number>();
headers.forEach((header, idx) => columnIndex.set(header, idx));
```

### Pattern 3: Fill-Gaps-Only Merge
**What:** Compare each sheet cell against supplier data. Only produce a write if the cell is empty/blank.
**When to use:** Core enrichment logic -- never overwrite existing data.
**Example:**
```typescript
interface CellUpdate {
  range: string;  // e.g., "Sheet1!J15" (column J, row 15)
  values: string[][];
}

function buildUpdates(
  sheetRow: (string | null)[],
  supplierData: Record<string, string>,
  columnMap: Map<string, number>,
  rowIndex: number // 1-based sheet row number
): CellUpdate[] {
  const updates: CellUpdate[] = [];

  for (const [sheetCol, supplierField] of Object.entries(FIELD_MAPPING)) {
    const colIdx = columnMap.get(sheetCol);
    if (colIdx === undefined) continue;

    const currentValue = sheetRow[colIdx]?.trim();
    const newValue = supplierData[supplierField];

    // Fill gaps only -- skip if cell already has data
    if (currentValue) continue;
    if (!newValue) continue;

    const colLetter = columnToLetter(colIdx);
    updates.push({
      range: `Sheet1!${colLetter}${rowIndex}`,
      values: [[newValue]],
    });
  }

  return updates;
}
```

### Pattern 4: Batch Write All Changes
**What:** Collect all cell updates, then write them in a single `batchUpdate` call.
**When to use:** After computing all enrichment changes across all rows.
**Example:**
```typescript
// Source: Google Sheets API batchUpdate docs
if (updates.length === 0) {
  logger.info('No empty cells to fill -- sheet is already complete');
  return;
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  requestBody: {
    valueInputOption: 'RAW', // Don't interpret as formulas
    data: updates,
  },
});

logger.info(`Wrote ${updates.length} cells across enrichment`);
```

### Anti-Patterns to Avoid
- **Writing cell-by-cell:** Each `update` call is one API request. With 100+ rows x multiple columns, you hit rate limits fast. Always batch.
- **Reading row-by-row:** Same issue. Read the entire sheet in one `get` call.
- **Using USER_ENTERED for data writes:** This causes the API to interpret values as formulas/dates. Use `RAW` for supplier data to prevent accidental formula injection (e.g., a description starting with `=`).
- **Overwriting existing data:** The merge logic MUST check if a cell is empty before writing. This is a locked user requirement.
- **Storing credentials in code:** Service account email and private key go in `.env` only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Google Sheets auth | Custom OAuth flow | `google.auth.GoogleAuth` with service account | Handles token refresh, JWT signing, scope management |
| Column letter conversion | Manual A-Z/AA-AZ logic | Simple utility function (26-base conversion) | Easy to get wrong with multi-letter columns (AA, AB...) |
| Rate limiting | Custom timer/queue | Simple delay between batch calls if needed | With batch operations, typically only 1-2 API calls total -- rate limiting is rarely needed |
| Sheet data parsing | Custom CSV-like parser | `spreadsheets.values.get` returns clean 2D arrays | API handles all escaping, empty cells, etc. |

**Key insight:** The Google Sheets API is designed for batch operations. A well-structured enrichment run should use exactly 1 read call + 1 write call, staying well within rate limits without needing any throttling.

## Common Pitfalls

### Pitfall 1: Sheet Not Shared with Service Account
**What goes wrong:** 403 "The caller does not have permission" or 404 "Spreadsheet not found"
**Why it happens:** Service accounts have their own Google identity. The spreadsheet must be explicitly shared (Editor access) with the service account's email address.
**How to avoid:** Document setup step: share the Google Sheet with the service account email (found in the JSON credentials file as `client_email`). The bounce-back email when sharing is normal and can be ignored.
**Warning signs:** Any 403/404 error on first connection attempt.

### Pitfall 2: Private Key Newline Escaping
**What goes wrong:** "error:1E08010C:DECODER routines::unsupported" or similar JWT signing failure
**Why it happens:** When storing the private key in `.env`, the literal `\n` characters in the PEM key need to be converted to actual newlines at runtime.
**How to avoid:** Always apply `.replace(/\\n/g, '\n')` when reading the private key from env.
**Warning signs:** Auth failures that work in one environment but not another.

### Pitfall 3: Empty Cells in Ragged Rows
**What goes wrong:** `undefined` when accessing columns at the end of a row that has trailing empty cells.
**Why it happens:** The Sheets API does NOT pad rows to full width. If the last 5 columns of a row are empty, the returned array is shorter.
**How to avoid:** Always check array bounds or pad rows to the expected column count before processing.
**Warning signs:** `TypeError: Cannot read properties of undefined` when accessing row values.

### Pitfall 4: Formula Injection via USER_ENTERED
**What goes wrong:** A product description starting with `=` gets interpreted as a formula.
**Why it happens:** `USER_ENTERED` valueInputOption parses input like the Google Sheets UI.
**How to avoid:** Use `RAW` valueInputOption for all data writes. Values are stored exactly as provided.
**Warning signs:** Strange values or `#REF!` errors appearing in the sheet.

### Pitfall 5: Off-by-One Row Indexing
**What goes wrong:** Data written to wrong rows, or header row overwritten.
**Why it happens:** Sheet rows are 1-indexed (row 1 = headers), but the values array is 0-indexed.
**How to avoid:** Sheet row number = array index + 2 (skip header at index 0, convert to 1-based).
**Warning signs:** Header row contains data values, or data appears shifted by one row.

### Pitfall 6: Matching Variants to Supplier Data
**What goes wrong:** Variants don't get enriched because the matching logic can't find corresponding supplier data.
**Why it happens:** The sheet uses `supplierCode` values like "CANADASPORTSWEAR" but Phase 1 adapters use "canada-sportswear". Also, matching by styleID needs exact case-insensitive comparison.
**How to avoid:** Build a supplier code mapping (sheet value -> adapter name) and normalize IDs for comparison.
**Warning signs:** Enrichment report shows 0 matches for a supplier with known products.

## Code Examples

### Service Account Authentication Setup
```typescript
// Source: googleapis official docs + Google Sheets quickstart
import { google, sheets_v4 } from 'googleapis';

export function createSheetsClient(): sheets_v4.Sheets {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !key) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY in .env'
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: key },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}
```

### Reading All Rows
```typescript
// Source: Google Sheets API values guide
export async function readAllRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName = 'Sheet1'
): Promise<{ headers: string[]; rows: string[][]; }> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
  });

  const values = response.data.values;
  if (!values || values.length < 2) {
    throw new Error('Sheet has no data rows');
  }

  const headers = values[0].map(h => String(h).trim());
  // Pad each row to full width to avoid ragged array issues
  const rows = values.slice(1).map(row => {
    const padded = new Array(headers.length).fill('');
    row.forEach((cell, i) => { padded[i] = String(cell ?? ''); });
    return padded;
  });

  return { headers, rows };
}
```

### Column Letter Conversion Utility
```typescript
// Convert 0-based column index to sheet column letter (0=A, 25=Z, 26=AA)
export function columnToLetter(colIndex: number): string {
  let letter = '';
  let idx = colIndex;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}
```

### Batch Write Updates
```typescript
// Source: Google Sheets API batchUpdate reference
export async function writeUpdates(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  updates: Array<{ range: string; values: string[][] }>
): Promise<number> {
  if (updates.length === 0) return 0;

  const result = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });

  return result.data.totalUpdatedCells ?? 0;
}
```

### Supplier Code Mapping
```typescript
// Map sheet supplierCode values to Phase 1 adapter names
const SUPPLIER_CODE_MAP: Record<string, 'canada-sportswear' | 'ss-canada'> = {
  CANADASPORTSWEAR: 'canada-sportswear',
  SSCANADA: 'ss-canada',
};
```

### Size Chart Structured Text Formatter
```typescript
import type { SizeSpec } from '../suppliers/types.js';

// Convert SizeSpec[] from supplier to structured text for sheet
export function formatSizeChart(specs: SizeSpec[]): string {
  // Group by size
  const bySize = new Map<string, string[]>();
  for (const spec of specs) {
    const entries = bySize.get(spec.sizeName) ?? [];
    entries.push(`${spec.specName} ${spec.value}`);
    bySize.set(spec.sizeName, entries);
  }

  return Array.from(bySize.entries())
    .map(([size, measurements]) => `${size}: ${measurements.join(', ')}`)
    .join(' | ');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| google-spreadsheet v3 (row-based) | googleapis direct (values API) | 2023+ | More control, fewer abstractions, better TypeScript types |
| OAuth2 for automation | Service account (JWT) | Always preferred for server-to-server | No user interaction needed, automatic token refresh |
| Individual cell writes | batchUpdate | Always available | Dramatically fewer API calls |

**Deprecated/outdated:**
- Sheets API v3 (legacy): Fully deprecated, use v4 only
- API key auth for writes: API keys only work for reading public sheets; service accounts required for writes

## Open Questions

1. **Sheet name**
   - What we know: The file is called `Master_Product_Variants_Media.xlsx` hosted on Google Sheets
   - What's unclear: The actual sheet/tab name within the spreadsheet (could be "Sheet1" or a custom name)
   - Recommendation: Make the sheet name configurable via env var with "Sheet1" as default

2. **Spreadsheet ID**
   - What we know: Needed for all API calls, found in the Google Sheets URL
   - What's unclear: Whether the user already has the spreadsheet ID
   - Recommendation: Store as `GOOGLE_SPREADSHEET_ID` in `.env`

3. **Google Cloud project setup**
   - What we know: Service account requires a GCP project with Sheets API enabled
   - What's unclear: Whether the user already has this configured
   - Recommendation: Include setup verification in the first plan task

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | vitest.config.ts (exists) |
| Quick run command | `npx vitest run tests/sheets/` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SHEET-01 | Auth + read all rows from sheet | unit (mock API) | `npx vitest run tests/sheets/reader.test.ts -t "read"` | No - Wave 0 |
| SHEET-02 | Write enriched data back (fill gaps only) | unit (mock API) | `npx vitest run tests/sheets/writer.test.ts -t "write"` | No - Wave 0 |
| SHEET-03 | Merge supplier data into correct columns | unit | `npx vitest run tests/sheets/merge.test.ts -t "merge"` | No - Wave 0 |
| SHEET-03 | Column mapping accuracy | unit | `npx vitest run tests/sheets/column-map.test.ts` | No - Wave 0 |
| SHEET-02 | Never overwrites existing data | unit | `npx vitest run tests/sheets/merge.test.ts -t "skip non-empty"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/sheets/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/sheets/reader.test.ts` -- covers SHEET-01 (mock sheets API, test row parsing + padding)
- [ ] `tests/sheets/writer.test.ts` -- covers SHEET-02 (mock batchUpdate, verify RAW mode)
- [ ] `tests/sheets/merge.test.ts` -- covers SHEET-03 (fill-gaps logic, skip non-empty cells)
- [ ] `tests/sheets/column-map.test.ts` -- covers column letter conversion and field mapping

## Sources

### Primary (HIGH confidence)
- [Google Sheets API - Read & Write Values](https://developers.google.com/workspace/sheets/api/guides/values) -- API methods, batchGet/batchUpdate, valueInputOption
- [Google Sheets API - Usage Limits](https://developers.google.com/workspace/sheets/api/limits) -- 300 req/min project, 60 req/min user
- [Google Sheets API - batchUpdate Reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate) -- Request/response format
- [googleapis npm](https://www.npmjs.com/package/googleapis) -- v171.x, official Google Node.js client
- [Google Workspace Node.js Samples](https://github.com/googleworkspace/node-samples/blob/main/sheets/snippets/sheets_batch_update_values.js) -- Official batch update example

### Secondary (MEDIUM confidence)
- [googleapis ESM issue #3397](https://github.com/googleapis/google-api-nodejs-client/issues/3397) -- CJS-only confirmed, but tsx handles interop
- [ISD Soft - Service Account Guide](https://isd-soft.com/tech_blog/accessing-google-apis-using-service-account-node-js/) -- Share sheet with service account email
- [Google Sheets API Quickstart](https://developers.google.com/workspace/sheets/api/quickstart/nodejs) -- Auth setup patterns

### Tertiary (LOW confidence)
- None -- all findings verified against official documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- googleapis is the official, well-documented Google client; project already uses tsx which handles CJS interop
- Architecture: HIGH -- read-all/batch-write pattern is the documented best practice from Google's own guides
- Pitfalls: HIGH -- all pitfalls sourced from official docs, GitHub issues, and established community knowledge

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable API, unlikely to change)
