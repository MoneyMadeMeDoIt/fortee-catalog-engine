# Phase 15: Garment Type Verification — Pattern Map

**Mapped:** 2026-05-11
**Files analyzed:** 7 (5 new, 2 modified)
**Analogs found:** 7 / 7 (every new/modified file has a strong in-repo analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/ai-image-generator.ts` (modify) | retry-loop modification + per-candidate filter | request-response (Vision API) | `src/lib/ai-image-generator.ts` — self, `describeGarment()` + `scoreCandidates()` | exact (same file) |
| `verifyGarmentTypeMatch()` (new export, same file) | verifier helper | request-response (Vision API) | `describeGarment()` at `src/lib/ai-image-generator.ts:35-64` | exact role + data flow |
| `src/lib/rejects-tsv.ts` (new) | TSV-writer utility (append-across-runs, header-once) | file-I/O | `scripts/audit-product-imagery.ts:544-547` (one-shot write) + `scripts/fix-all-store-side-pairs.ts:31, 434` (append idiom) | role-match (incremental append) |
| `scripts/audit-garment-types.ts` (new) | retro audit CLI | batch / file-I/O / Vision request-response | `scripts/audit-images.ts` (full file) | exact (same role, same CLI conventions) |
| `tests/lib/ai-image-generator.test.ts` (modify) | unit test, mocked OpenAI | test | `tests/lib/ai-image-generator.test.ts` — self, existing `vi.mock('openai', ...)` factory | exact (same file) |
| `tests/lib/garment-type-verifier.test.ts` (new) | fixture-gated real-API test | test | `tests/lib/prompt-templates.test.ts` (structure) + `tests/lib/ai-image-generator.test.ts` (suite shape) | role-match (no existing `skipIf`-gated fixture test in repo — pattern is new but mechanics mirror existing tests) |
| `tests/fixtures/garment-type/labels.json` + `*.png` (new) | test fixture | data | None (no existing `tests/fixtures/` directory) | no analog |

> Note: No existing test in the repo uses `describe.skipIf(!process.env.OPENAI_API_KEY)` — the pattern is documented in `15-RESEARCH.md` (`Don't Hand-Roll` table) but does not have a prior in-tree usage. Planner should treat the Vitest `skipIf` API as a new (but standard) idiom for this repo.

## Pattern Assignments

### `verifyGarmentTypeMatch()` — new export in `src/lib/ai-image-generator.ts` (verifier helper, request-response)

**Analog:** `src/lib/ai-image-generator.ts:35-64` (`describeGarment`)

**Imports pattern** (already in file, lines 17-29):
```typescript
import OpenAI, { toFile } from 'openai';
import { logger } from './logger.js';
```
No new imports needed for the helper itself; verifier reuses the existing `OpenAI` type.

**Function-signature pattern** (mirror of `describeGarment` at line 35):
```typescript
async function describeGarment(client: OpenAI, imageBuffer: Buffer): Promise<string> {
  try {
    const base64 = imageBuffer.toString('base64');
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '...' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
    });
    const desc = response.choices[0]?.message?.content?.trim() ?? '';
    logger.info(`[ai-image-generator] Garment described as: "${desc}"`);
    return desc;
  } catch (err) {
    logger.warn(`[ai-image-generator] Vision describe failed: ${err}`);
    return '';
  }
}
```

**What to copy:**
- Same `client.chat.completions.create({ model: 'gpt-4o-mini', ... })` shape.
- Same base64 encoding (`buffer.toString('base64')`) and same `image_url.url: 'data:image/png;base64,...'` format.
- Same `try/catch` discipline — on error, log a `[ai-image-generator]` warning and return a safe-fallback value. For `describeGarment` that's `''`; for the verifier it MUST be `{ match: true, reason: 'verifier ... error fallback' }` (per RESEARCH `Pitfall 1` and CONTEXT specifics: never falsely reject when the verifier itself broke).

**What to ADD on top of the analog:**
- Two image content blocks (one for `frontBuffer`, one for `generatedBuffer`) instead of one.
- `response_format: { type: 'json_object' }` (verifier needs structured output; `describeGarment` doesn't).
- `max_tokens: 100` (vs 50 — short JSON answer, not a single-line caption).
- `image_url.detail: 'low'` for both images (per RESEARCH Pitfall 6 — server-side downscale to dodge TPM rate-limits when sending two 1024×1024 PNGs).
- Regex-extract `{...}` fallback if `JSON.parse` of the raw content throws (per RESEARCH Example 1 step 4).

**Return-type pattern:** Match the `GenerateViewResult` style of named fields:
```typescript
// Anchor: src/lib/ai-image-types.ts:53-68 (GenerateViewResult shape)
export interface VerifyGarmentTypeResult {
  match: boolean;
  reason: string;
}
```

---

### `src/lib/ai-image-generator.ts` modifications (retry-loop modification)

**Analog:** itself — current `generateGarmentView()` (lines 211-327) and `scoreCandidates()` (lines 151-184).

**Pattern 1 — Extend `CandidateResult` interface** (current shape at lines 73-80):
```typescript
interface CandidateResult {
  buffer: Buffer;
  score: number;
  verdict: 'pass' | 'fail';
  hue: number;
  drift: number;
  passesHue: boolean;
}
```
Add two fields after `passesHue` (per RESEARCH Integration Map R1 + Example 2):
- `passesType: boolean;`
- `typeMatchReason: string;`

**Pattern 2 — Extend `scoreCandidates()` signature** (current at line 151):
```typescript
async function scoreCandidates(
  buffers: Buffer[],
  frontHue: number,
  frontIsAchromatic: boolean,
  garmentType: CategoryGroup,
): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  for (const buffer of buffers) {
    const qualityResult = await scoreImageQuality(buffer, garmentType);
    // ... hue calc ...
    results.push({ buffer, score, verdict, hue, drift, passesHue });
  }
  return results;
}
```
**Add two parameters:** `openai: OpenAI` and `frontBuffer: Buffer`. Inside the `for` loop, after the existing hue/quality block, add a `verifyGarmentTypeMatch(openai, buffer, frontBuffer)` call and store `passesType` + `typeMatchReason` on the pushed result. The for-loop pattern is already serial; do not refactor to parallel (no precedent in the file).

**Pattern 3 — Strict AND filter predicate** (current at lines 261 and 292):
```typescript
// line 261
const round1Passing = round1Candidates.filter(c => c.passesHue);
// line 292
const round2Passing = round2Candidates.filter(c => c.passesHue);
```
Change to:
```typescript
const round1Passing = round1Candidates.filter(c => c.passesHue && c.passesType);
const round2Passing = round2Candidates.filter(c => c.passesHue && c.passesType);
```
No structural change. Same `.reduce((a, b) => (b.score > a.score ? b : a))` winner selection. Same `usedRetry` flag, same `callCount` accounting.

**Pattern 4 — Replace the D-04 fallback block** (current at lines 307-326):
```typescript
// --- D-04 fallback: all 6 candidates failed — return best-scoring regardless ---
if (allCandidates.length === 0) {
  return null;
}
const bestOfAll = allCandidates.reduce((a, b) => (b.score > a.score ? b : a));
logger.warn(
  `[ai-image-generator] All ${allCandidates.length} candidates failed hue check. Returning best-scoring (score=${bestOfAll.score}) per D-04.`,
);
return {
  buffer: bestOfAll.buffer,
  score: bestOfAll.score,
  verdict: bestOfAll.verdict,
  totalCost,
  callCount,
  usedRetry,
  hueDrift: bestOfAll.drift,
};
```
**New logic (per SPEC R4 + RESEARCH Example 4):**
```typescript
if (allCandidates.length === 0) {
  return null;
}
const typePassing = allCandidates.filter(c => c.passesType);
if (typePassing.length === 0) {
  // All 6 failed type-match — skip + log to TSV per SPEC R4
  const reason = allCandidates[0]?.typeMatchReason ?? 'unknown';
  logger.warn(`[ai-image-generator] All ${allCandidates.length} candidates failed type-match for ${pid}/${view}. Returning null.`);
  await appendRejectRow({ pid, view, reason, timestamp: new Date().toISOString(), run_id: getOrCreateRunId() });
  return null;
}
// Otherwise: existing hue-fallback constrained to typePassing
const bestOfTypePassing = typePassing.reduce((a, b) => (b.score > a.score ? b : a));
return { /* same GenerateViewResult shape */ };
```
The `pid` parameter must be threaded through `generateGarmentView()` (per RESEARCH Pitfall 2). Update the two callers in `src/lib/audit-runner.ts` at lines 304-306 and 342-344 (both already have `primary.row.productId` / `row.productId` in scope).

**Pattern 5 — Verifier calls bypass CostTracker** (per SPEC R5):
Inspect the current cost-budget call sites at lines 224, 254, 279, 285:
```typescript
if (!costTracker.canAfford(callCost)) { ... return null; }   // line 224, 279
costTracker.record(callCost);                                  // line 254, 285
```
**Constraint:** `verifyGarmentTypeMatch()` must NOT receive `costTracker` and must NOT call `canAfford` or `record`. The two new params on `scoreCandidates()` are `openai` and `frontBuffer` — no tracker. Add an inline `// NOTE: verifier calls bypass CostTracker per SPEC R5` comment at the verifier call site.

---

### `src/lib/rejects-tsv.ts` (new utility, file-I/O)

**Primary analog:** `scripts/audit-product-imagery.ts:544-547` (one-shot TSV write):
```typescript
// Write TSV
const lines = ['pid\tcolor\tcheck\tseverity\tdrive\tstore\tdetail'];
for (const i of allIssues) lines.push([i.pid, i.color, i.check, i.severity, i.driveCount, i.storeCount, i.detail].join('\t'));
writeFileSync('tmp/imagery-audit.tsv', lines.join('\n') + '\n');
```

**Secondary analog:** `scripts/fix-all-store-side-pairs.ts:31, 434` (incremental append idiom — exactly what Phase 15 needs):
```typescript
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
// ...
appendFileSync(PROGRESS_PATH, `${p.handle}\t${color}\tfix\t${cached.detectedSide}\n`);
```

**Pattern to assemble** (per RESEARCH TSV write pattern + CONTEXT D-06/D-07):
```typescript
import { existsSync, writeFileSync, appendFileSync } from 'fs';

const TSV_PATH = 'tmp/garment-type-rejects.tsv';
const HEADER = 'pid\tview\treason\ttimestamp\trun_id\n';

function sanitize(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ');  // ASVS V5 input-sanitization
}

export interface RejectRow {
  pid: string;
  view: 'back' | 'side';
  reason: string;
  timestamp: string;  // ISO-8601
  run_id: string;
}

export async function appendRejectRow(row: RejectRow): Promise<void> {
  const line = [row.pid, row.view, sanitize(row.reason), row.timestamp, row.run_id].join('\t') + '\n';
  if (!existsSync(TSV_PATH)) {
    writeFileSync(TSV_PATH, HEADER + line);
  } else {
    appendFileSync(TSV_PATH, line);
  }
}
```
- **Imports:** Use synchronous `fs` (matches `audit-product-imagery.ts:30` and `fix-all-store-side-pairs.ts:31` — both repo precedents use `'fs'` not `'node:fs/promises'`). The function is declared `async` purely for caller compatibility; planner can drop `async` if preferred.
- **Header-once, append-across-runs:** RESEARCH "TSV write pattern" section uses `access()` from `fs/promises`; the repo precedent is `existsSync` (sync). Use the repo precedent.
- **Sanitization:** Replace tab/newline runs with single space per RESEARCH Security Domain (V5 + TSV injection).
- **Run ID:** Generate once at module load OR via a memoized `getOrCreateRunId()` helper. CONTEXT defers to planner — recommend `new Date().toISOString()` captured in a module-level lazy const (no UUID dependency).

**Why a separate file (not inline in `ai-image-generator.ts`):**
Per RESEARCH Open Question #4: both R4 (in-pipeline) and R6 (retro script) write the same TSV. Extract from day one to avoid duplicate writers.

---

### `scripts/audit-garment-types.ts` (new CLI, batch + file-I/O)

**Analog:** `scripts/audit-images.ts` (full file, 515 lines).

**Imports pattern** (mirror of `scripts/audit-images.ts:1-12`):
```typescript
import 'dotenv/config';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows, readRowRange } from '../src/sheets/reader.js';
import { downloadImage } from '../src/shopify/image-standardizer.js';
import { verifyGarmentTypeMatch } from '../src/lib/ai-image-generator.js';
import { appendRejectRow } from '../src/lib/rejects-tsv.js';
import type { SheetRow } from '../src/sheets/types.js';
import type { sheets_v4 } from 'googleapis';
```
**Omit** from the analog (per SPEC R6 + RESEARCH Pitfall 5):
- `createDriveClient` — not needed; read-only.
- `auditProductImages`, `writeUpdates`, `buildStandardizationUpdates` — these are write-side; their absence is a positive signal in code review. Add a top-of-file comment: `// READ-ONLY: must never call uploadToDrive or writeUpdates.`
- `CostTracker` — per CONTEXT D-05.

**Help-text pattern** (mirror of `scripts/audit-images.ts:42-69`):
```typescript
function showHelp(): void {
  console.log(`
Garment Type Audit CLI — Phase 15

Scans BR back/side images and flags shape-mismatched uploads.
WRITES ONLY tmp/garment-type-rejects.tsv — never touches Drive or Sheets.

Usage:
  npx tsx scripts/audit-garment-types.ts --style-id <ID>
  npx tsx scripts/audit-garment-types.ts --all
  npx tsx scripts/audit-garment-types.ts --dry-run --all
  npx tsx scripts/audit-garment-types.ts --limit 50

Flags:
  --style-id <ID>   Style ID to audit.
  --all             Scan every row.
  --dry-run         List target rows without calling Vision.
  --limit N         Process at most N products.
  --help, -h        Show this help message.

Environment variables required:
  OPENAI_API_KEY
  GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SPREADSHEET_ID
`);
}
```

**DI + entry-point pattern** (mirror of `scripts/audit-images.ts:18-36, 448-514`):
```typescript
export interface RunAuditArgs { styleId?: string; all: boolean; dryRun: boolean; limit?: number; help: boolean; }
export interface RunAuditDeps {
  args: RunAuditArgs;
  sheetsClient: unknown;
  openai: OpenAI;
  readAllRowsFn: typeof readAllRows;
  spreadsheetId: string;
  sheetName: string;
}
export async function runGarmentTypeAudit(deps: RunAuditDeps): Promise<void> { /* ... */ }

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'style-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  // ... env-var check, client creation, dispatch
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-garment-types');
if (isDirectRun) { main(); }
```

**Loop-body pattern** (NEW shape — much simpler than `audit-images.ts` since no write-side):
- For each row: if `row.FrontImage` is empty/invalid (use `audit-images.ts:336-338` `isInvalidUrl` check) → skip.
- `const frontBuf = await downloadImage(row.FrontImage)` wrapped in try/catch.
- For each `view of ['back', 'side']`: if URL empty/invalid → skip. Else download buffer, call `verifyGarmentTypeMatch(openai, viewBuf, frontBuf)`, and on `!result.match` call `appendRejectRow({ pid: row.productId, view, reason: result.reason, timestamp: new Date().toISOString(), run_id })`.
- Wrap each `downloadImage` and `verifyGarmentTypeMatch` call in try/catch — log warn and continue (matches `audit-runner.ts:333-336` discipline: `catch (err) { logger.warn(...); }` and fall through).

**Chunked-read pattern for `--all`** (mirror of `scripts/audit-images.ts:268-442`):
```typescript
const CHUNK_SIZE = 1000;
let chunkNum = 0;
let hasMore = true;
while (hasMore) {
  const offset = chunkNum * CHUNK_SIZE;
  const { rows } = await readRowRange(sheetsClient, spreadsheetId, offset, CHUNK_SIZE, sheetName);
  if (rows.length === 0) { hasMore = false; break; }
  if (rows.length < CHUNK_SIZE) hasMore = false;
  // ... process rows, optional global.gc() between chunks
  chunkNum++;
}
```

**Dedup pattern** (mirror of `audit-images.ts:140-149`): per-(styleID|colorName) colorGroupMap so size-rows aren't re-processed.

---

### `tests/lib/ai-image-generator.test.ts` (modify — add R1/R3/R4/R5 + verifier-fallback tests)

**Analog:** itself — the full mocking infrastructure already exists.

**Pattern 1 — Extend the existing `openai` mock factory** (lines 19-41):
```typescript
const mockImagesEdit = vi.fn();
vi.mock('openai', () => {
  class BadRequestError extends Error { /* ... */ }
  class OpenAI {
    images = { edit: mockImagesEdit };
    static BadRequestError = BadRequestError;
  }
  return { default: OpenAI, toFile: vi.fn()... };
});
```
**Add:** declare `const mockChatCompletionsCreate = vi.fn();` at module scope, then add `chat = { completions: { create: mockChatCompletionsCreate } };` as a field on the fake `OpenAI` class. Per RESEARCH Test Strategy section.

**Pattern 2 — Test-case shape** (analog: lines 135-163, the AIGEN-01 test):
```typescript
describe('generateGarmentView — AIGEN-01 basic generation', () => {
  it('returns buffer with score=80, callCount=1, usedRetry=false when first candidate passes', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);
    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];
    mockExtractDominantHue.mockResolvedValue({ hue: 200, achromatic: false, rgb: ... });
    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));
    mockScoreImageQuality.mockResolvedValueOnce(makeQualityResult(80, 'pass'))...;
    const result = await generateGarmentView(...);
    expect(result!.score).toBe(80);
  });
});
```
**Mirror this shape** for each of the six new tests in RESEARCH "Test cases to add" (R1 filter, R3 strict-AND retry-fires, R3 no-retry-when-one-passes-both, R4 skip+TSV-log, R5 cost-tracker-not-decremented, verifier-API-failure-fallback). Each test should:
- Set up `mockChatCompletionsCreate` returns to seed `{match: true|false, reason: '...'}` JSON strings via the same `.mockResolvedValueOnce` chain pattern used by the existing tests for `mockScoreImageQuality`.
- Use `vi.spyOn(costTracker, 'record')` (analog at lines 434-465 — the "cost tracking" describe block).

**Pattern 3 — Mock `node:fs` for the R4 TSV-write test:**
No precedent in the file for mocking `fs`. Add (per RESEARCH Test Strategy):
```typescript
vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});
```
Assert on the spy's `.mock.calls[0]` that the path is `'tmp/garment-type-rejects.tsv'` and the line contains pid + view + reason.

**Pattern 4 — Mocked-OpenAI Vision-failure test** (no analog in file — new pattern):
```typescript
it('verifier API failure: returns a candidate (not null) when mockChat rejects', async () => {
  // ... 3 candidates pass hue
  mockChatCompletionsCreate.mockRejectedValue(new Error('API timeout'));
  const result = await generateGarmentView(...);
  expect(result).not.toBeNull();  // verifier-error fallback → match=true → candidate eligible
});
```

---

### `tests/lib/garment-type-verifier.test.ts` (new — fixture-gated real API)

**Analogs:**
- Test-suite shape: `tests/lib/prompt-templates.test.ts:1-35` (simple `describe`/`it` with no mocks).
- Real-Vision call shape: `describeGarment` at `src/lib/ai-image-generator.ts:35-64`.

**Imports + structure pattern** (no precedent for `skipIf` in this repo — new idiom but standard Vitest API):
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import { verifyGarmentTypeMatch } from '../../src/lib/ai-image-generator.js';
import labels from '../fixtures/garment-type/labels.json' with { type: 'json' };

const FIXTURE_DIR = join(__dirname, '../fixtures/garment-type');

describe.skipIf(!process.env.OPENAI_API_KEY)('verifyGarmentTypeMatch — fixture set', () => {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  for (const [pid, label] of Object.entries(labels)) {
    it(`${pid} back vs front`, async () => {
      const frontBuf = readFileSync(join(FIXTURE_DIR, label.front_path));
      const backBuf = readFileSync(join(FIXTURE_DIR, label.back_path));
      const result = await verifyGarmentTypeMatch(client, backBuf, frontBuf);
      expect(result.match).toBe(label.expected_match.back);
    }, 30000);  // 30s timeout for real API

    it(`${pid} side vs front`, async () => { /* same shape */ }, 30000);
  }
});
```

**Why no closer analog:** No existing test in `tests/` imports a real-network client gated on an env var. Closest precedents:
- `tests/lib/prompt-templates.test.ts` for the no-mock suite shape.
- `tests/lib/ai-image-generator.test.ts:8` for the Vitest import style.

**Fixture file pattern (`tests/fixtures/garment-type/labels.json`):** No analog (no existing `tests/fixtures/` directory). Schema per CONTEXT D-08:
```json
{
  "A343": {
    "expected_category": "crewnecks",
    "front_path": "A343-front.png",
    "back_path": "A343-back.png",
    "side_path": "A343-side.png",
    "expected_match": { "back": false, "side": false }
  }
}
```

---

## Shared Patterns

### Logging
**Source:** `src/lib/ai-image-generator.ts:58, 61, 139, 226, 314` — every log call prefixes its module name in brackets.
**Apply to:** verifier helper, rejects-tsv module, retro audit script.
```typescript
logger.info(`[ai-image-generator] Garment described as: "${desc}"`);
logger.warn(`[ai-image-generator] Vision describe failed: ${err}`);
```
For new files use the matching prefix: `[verifier]`, `[rejects-tsv]`, `[audit-garment-types]`.

### Error-handling discipline (non-fatal warn + safe fallback)
**Source:** `src/lib/ai-image-generator.ts:60-63` (describeGarment) and `src/lib/audit-runner.ts:333-336` (download failures fall through):
```typescript
} catch (err) {
  logger.warn(`[ai-image-generator] Vision describe failed: ${err}`);
  return '';  // safe fallback
}
```
```typescript
} catch (err) {
  logger.warn(`[audit-runner] Failed to download sourced ${view} for ${styleId}: ${err}`);
  // Fall through to AI generation
}
```
**Apply to:**
- Verifier on Vision/parse failure → `return { match: true, reason: 'verifier ... fallback' }` (RESEARCH Pitfall 1).
- Retro script on `downloadImage` failure → log warn, continue to next row.
- TSV writer on filesystem failure → log warn; do NOT throw (TSV is a side-channel, not a hard requirement).

### OpenAI client factory
**Source:** `src/lib/ai-image-generator.ts:86-91`:
```typescript
function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 600_000,
  });
}
```
**Apply to:** retro audit script — instantiate the same way OR pass through DI for testability (mirror `audit-images.ts` `RunAuditDeps`). 10-minute timeout is overkill for Vision (gpt-4o-mini latency ~1-3s); a 60_000ms timeout is acceptable in the retro script.

### CLI dispatch + DI seam
**Source:** `scripts/audit-images.ts:18-36, 98, 448-514`:
- `RunAuditArgs` / `RunAuditDeps` interface pair.
- `runAudit(deps)` exported separately from `main()` so tests can inject mocks.
- `const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-images');` guards `main()` so test imports don't trigger execution.
**Apply to:** `scripts/audit-garment-types.ts`.

### Input sanitization for TSV
**Source:** RESEARCH "Security Domain" + standard practice (no in-repo precedent — the existing TSV writers in `scripts/audit-product-imagery.ts:546` and `scripts/fix-all-store-side-pairs.ts:434` do not sanitize because their fields come from controlled enums).
**Apply to:** `src/lib/rejects-tsv.ts` `sanitize()` helper — strip `\t`, `\n`, `\r` runs from the `reason` field since it originates from an LLM response.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `tests/fixtures/garment-type/labels.json` | test fixture | data | No existing `tests/fixtures/` directory anywhere in the repo (verified via `Glob("tests/fixtures/**")`). Planner is creating a new conventional location. |
| `tests/fixtures/garment-type/*.png` | test binary | data | Same — no precedent for binary test fixtures. Planner picks the 6 fixture pids and captures front/back/side PNGs during plan-phase. |
| `describe.skipIf(!process.env.OPENAI_API_KEY)(...)` usage | test | test | No existing test in `tests/**/*.test.ts` uses `skipIf` or any `process.env.OPENAI_API_KEY` gate (verified via Grep). The Vitest API is standard but new to this repo. |

## Metadata

**Analog search scope:** `src/lib/**`, `src/shopify/**`, `src/sheets/**`, `scripts/**`, `tests/**`, `tests/fixtures/**` (the last returned zero files).
**Files read:**
- `src/lib/ai-image-generator.ts` (full, 382 lines)
- `src/lib/ai-image-types.ts` (full, 81 lines)
- `src/lib/audit-runner.ts` (lines 280-400 only)
- `scripts/audit-images.ts` (full, 515 lines)
- `scripts/audit-product-imagery.ts` (TSV-write section only, lines 30, 544-565)
- `scripts/fix-all-store-side-pairs.ts` (head + TSV-append section, lines 1-60, 434)
- `scripts/generate-cross-pollution-tsv.ts` (head, 80 lines)
- `tests/lib/ai-image-generator.test.ts` (full, 495 lines)
- `tests/lib/prompt-templates.test.ts` (head, 40 lines)
- `tests/scripts/audit-images.test.ts` (head, 100 lines)
**Pattern extraction date:** 2026-05-11

---
*Phase: 15-garment-type-verification*
*Patterns mapped: 2026-05-11*
