# Phase 15: Garment Type Verification - Research

**Researched:** 2026-05-11
**Domain:** OpenAI Vision-based garment-shape comparison inside the AI image generation pipeline + a one-off retro audit script
**Confidence:** HIGH

## Summary

This phase inserts a per-candidate Vision check into `generateGarmentView()` in `src/lib/ai-image-generator.ts`. Today the function generates 3 candidates per round (n=3, max 2 rounds = 6 candidates), filters them by hue drift, and picks the highest quality score. There is no garment-shape check - a crewneck source can produce hoodie-shaped candidates that win on hue and ship to Drive (the A343 regression). Phase 15 adds a `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)` helper that calls gpt-4o-mini with both images side-by-side, and changes the winner predicate from "hue passes" to "hue AND type pass." When both rounds fail, the function returns `null` (audit-runner.ts already treats `null` as a skip) and appends to `tmp/garment-type-rejects.tsv`. A separate `scripts/audit-garment-types.ts` mirrors `scripts/audit-images.ts` to flag mislabeled historical uploads.

Integration points are surgical: `describeGarment()` at `ai-image-generator.ts:35` is the existing gpt-4o-mini Vision template; `scoreCandidates()` at line 151 is the natural insertion point; the audit-runner already handles `null` returns. All test infrastructure (Vitest, mocked OpenAI, mocked sharp/hue-utils) exists in `tests/lib/ai-image-generator.test.ts` and is directly reusable.

**Primary recommendation:** Add `verifyGarmentTypeMatch()` in `src/lib/ai-image-generator.ts`; add `passesType: boolean` field to `CandidateResult`; gate winner-selection on `passesHue && passesType`; return `null` + write to `tmp/garment-type-rejects.tsv` when all candidates fail type-match; mirror `scripts/audit-images.ts` for the retro script.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Vision Verifier Design**
- **D-01: Side-by-side two-image comparison.** `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)` sends BOTH images in a single Vision API call. Returns `{ match, reason }`. Single call per candidate.
- **D-02: Coarse family match** at CategoryGroup level (`tops` | `hoodies` | `polos` | `crewnecks` | `jackets`). Long-sleeve vs short-sleeve = SAME family; only major drift (hoodie-for-crewneck) is rejected.
- **D-03: Vision model is `gpt-4o-mini`.** Matches existing `describeGarment()` pattern. Verifier calls are NOT budgeted (per SPEC R5).

**Retro Audit Identification**
- **D-04: Retro script scans ALL back/side images.** No identification heuristic needed.
- **D-05: Total cost cap is trivial** (~$0.06 per pass). No budget gating.

**Rejects TSV Format**
- **D-06: Path is `tmp/garment-type-rejects.tsv`.**
- **D-07: Columns: `pid | view | reason | timestamp | run_id`.** Tab-separated. Append across runs. `run_id` is ISO-8601 timestamp captured once per invocation.

**Fixture Set**
- **D-08: Location: `tests/fixtures/garment-type/`.** `labels.json` maps pid to `{ expected_category, front_path, back_path, side_path, expected_match: { back, side } }`.
- **D-09: A343 + 1 known-good per CategoryGroup = 6 minimum.**

**Test Strategy**
- **D-10: Unit tests with mocked OpenAI** (extend `tests/lib/ai-image-generator.test.ts`).
- **D-11: Fixture-based test with real gpt-4o-mini.** New `tests/lib/garment-type-verifier.test.ts`. Gated on `process.env.OPENAI_API_KEY` via `it.skipIf(!process.env.OPENAI_API_KEY)`.

### Claude's Discretion
- Exact Vision prompt wording.
- TSV row dedup behavior on re-run.
- `run_id` representation (timestamp vs UUID).
- Wiring location inside `scoreCandidates()` vs after.
- Picking the 5 known-good fixture pids.

### Deferred Ideas (OUT OF SCOPE)
- Verifier on AI-enhanced fronts.
- Sub-type drift detection.
- Retro REMEDIATION (delete/regenerate).
- Verifier cost telemetry / CostTracker integration.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| R1 | Per-candidate type check inside `generateGarmentView()` | `scoreCandidates()` at `ai-image-generator.ts:151`; add `passesType` to `CandidateResult` (line 73); gate filters at lines 261 + 292 on `passesHue && passesType` |
| R2 | `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)` returns `{match, reason}` | Mirrors `describeGarment()` at line 35 (same `client.chat.completions.create` + base64 `image_url`); 2 image content blocks instead of 1 |
| R3 | Strict AND retry predicate | Line 261 `.filter(c => c.passesHue)` becomes `.filter(c => c.passesHue && c.passesType)`; same for line 292 |
| R4 | Skip + TSV log on total fail | Replace D-04 fallback at lines 307-326 with: if `typePassing.length > 0` use existing hue-fallback on subset; else return null + TSV write |
| R5 | No CostTracker gating on verifier calls | `verifyGarmentTypeMatch()` does NOT receive `costTracker`; existing `canAfford`/`record` only gate `callImagesEdit` at lines 224, 279 |
| R6 | Retro audit script `scripts/audit-garment-types.ts` | Mirrors `scripts/audit-images.ts` CLI/chunked-reader structure; scans ALL back/side per D-04 |


## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-candidate Vision type check | `src/lib/ai-image-generator.ts` (in-pipeline) | - | Lives next to existing hue/quality filters; same module owns Vision + OpenAI client factory |
| Vision helper API | `src/lib/ai-image-generator.ts` or new `src/lib/garment-type-verifier.ts` | - | Self-contained; in-file is closer to `describeGarment()` template |
| Rejects TSV write | `src/lib/ai-image-generator.ts` (or shared `src/lib/rejects-tsv.ts`) | `node:fs/promises` | Local I/O; follows existing tmp/ TSV pattern |
| Retro audit script | `scripts/audit-garment-types.ts` (new) | - | Mirrors `scripts/audit-images.ts` |
| Test fixtures | `tests/fixtures/garment-type/` | - | Binary PNGs + labels.json; gated tests skip on CI without OPENAI_API_KEY |

## Integration Map (where R1-R6 land in actual files/functions)

### R1: Per-candidate type filter inside generateGarmentView()
**File:** `src/lib/ai-image-generator.ts`
**Function:** `scoreCandidates()` (lines 151-184)
**Change:**
- Add `passesType: boolean` and `typeMatchReason: string` fields to `CandidateResult` interface (lines 73-80).
- Extend `scoreCandidates()` signature to accept `openai: OpenAI` client and `frontBuffer: Buffer` so it can call the verifier per candidate.
- Inside the `for (const buffer of buffers)` loop (line 159), after the hue/quality block, call `await verifyGarmentTypeMatch(openai, buffer, frontBuffer)` and store `passesType = result.match`, `typeMatchReason = result.reason`.

### R2: verifyGarmentTypeMatch helper
**File:** `src/lib/ai-image-generator.ts` (or sibling)
**Signature:** `export async function verifyGarmentTypeMatch(client: OpenAI, generatedBuffer: Buffer, frontBuffer: Buffer): Promise<{ match: boolean; reason: string }>;`
**Template:** `describeGarment()` at lines 35-64.
**Error policy:** On Vision API failure or JSON parse failure, return `{ match: true, reason: 'verifier error fallback' }` and log warning. Do NOT reject candidates because the verifier itself broke - matches the fallback discipline of `describeGarment()` (line 60-63 returns empty string on error).

### R3: Strict AND predicate
**File:** `src/lib/ai-image-generator.ts`
**Locations:**
- Line 261: `const round1Passing = round1Candidates.filter(c => c.passesHue);` becomes `.filter(c => c.passesHue && c.passesType)`
- Line 292: same change for `round2Passing`.

### R4: Skip + TSV log on total type-match failure
**File:** `src/lib/ai-image-generator.ts`
**Location:** Lines 307-326 (existing D-04 fallback block).
**Logic:** First check `if (allCandidates.length === 0) return null;` Then compute `const typePassing = allCandidates.filter(c => c.passesType);` If `typePassing.length === 0`, append a reject row to the TSV and return null. Otherwise apply the existing hue-fallback constrained to `typePassing` (pick highest score, return GenerateViewResult).
**Caveat:** `generateGarmentView()` has no `pid` parameter today. Recommend adding `pid: string` as a new parameter. Single in-tree caller (`audit-runner.ts` lines 304 + 342) has `row.productId` available - small blast radius.

### R5: Verifier calls NOT budget-gated
**Confirmation:** `verifyGarmentTypeMatch()` does NOT receive `costTracker`. Existing `costTracker.canAfford(callCost)` at lines 224 (initial round) and 279 (retry round) gate only `callImagesEdit()`.

### R6: Retro audit script
**File:** `scripts/audit-garment-types.ts` (new)
**Mirrors:** `scripts/audit-images.ts` - CLI structure with `parseArgs`, dependency injection, `--style-id`/`--all`/`--dry-run`/`--limit` flags, chunked reading via `readRowRange`.
**Loop body pseudocode:** For each row, if `row.FrontImage` is valid download it. For each of `['back', 'side']`, if the URL is valid download the buffer, call `verifyGarmentTypeMatch(client, buf, frontBuf)`, and on `!match` append a row to `tmp/garment-type-rejects.tsv` with `{ pid: row.productId, view, reason, timestamp, run_id }`.
**MUST NOT** call `uploadToDrive` or `writeUpdates`. Flag-only per SPEC R6.


## Vision Prompt Design (gpt-4o-mini)

### Recommended v1 prompt (to be validated on fixtures during plan-phase)

System prompt (multi-line string assigned to `VERIFIER_SYSTEM_PROMPT`):

```
You are comparing two product photos of garments on white backgrounds.
The FIRST image is the reference (the source front view).
The SECOND image is a candidate (a generated back or side view).

Decide whether the two images depict the SAME GARMENT FAMILY.

Families (use exactly these labels):
- tops (t-shirts, tanks, short-sleeve casual)
- hoodies (any pullover or zip with a hood)
- polos (collared placket tops)
- crewnecks (round-neck sweatshirts, no hood)
- jackets (zip/snap outerwear, not hoodies)

Coarse match only:
- Long-sleeve vs short-sleeve = SAME family
- Boxy vs relaxed fit = SAME family
- Crewneck vs hoodie = DIFFERENT families (the bug we are catching)
- Hoodie vs jacket = DIFFERENT families
- Polo vs crewneck = DIFFERENT families

Respond with ONLY a JSON object on a single line:
{"match": true|false, "reason": "<short phrase, max 80 chars>"}

Examples of reasons:
- "both crewnecks"
- "front is crewneck, candidate is hoodie"
- "both hoodies"
- "front is polo, candidate is t-shirt"
```

### API call shape

Call `client.chat.completions.create` with `model: 'gpt-4o-mini'`, `max_tokens: 100`, `response_format: { type: 'json_object' }`. The `messages` array has two entries:
1. `{ role: 'system', content: VERIFIER_SYSTEM_PROMPT }`
2. `{ role: 'user', content: [...] }` where the content array contains:
   - text block: "Reference (source front):"
   - image_url block: `{ url: 'data:image/png;base64,' + frontB64, detail: 'low' }`
   - text block: "Candidate (generated view):"
   - image_url block: `{ url: 'data:image/png;base64,' + genB64, detail: 'low' }`

### Parsing + error policy
- Parse `response.choices[0].message.content` as JSON; if parsing fails, regex-extract `{...}` substring and retry.
- On any failure (API error, parse error, missing `match` field): return `{ match: true, reason: 'verifier fallback' }` and log warning.

### Tuning notes
- `response_format: { type: 'json_object' }` is supported on gpt-4o-mini and forces JSON output [CITED: openai docs response_format param].
- `max_tokens: 100` is enough for the short JSON answer; reasons capped at 80 chars.
- `image_url.detail: 'low'` does server-side downscale - ~3x lower per-call cost; sufficient for family-level match.
- The system prompt is intentionally verbose with examples; gpt-4o-mini benefits from concrete contrast cases. Planner should A/B against a terser variant on the fixture set.

[ASSUMED] Prompt achieves correct pass/fail on the 6 fixture pids without iteration. Planner validates with the fixture-based test (D-11) first; iterates only if pass-rate below 100%.

## CategoryGroup Taxonomy

**Source of truth:** `src/shopify/types.ts:102`
`export type CategoryGroup = 'tops' | 'hoodies' | 'polos' | 'crewnecks' | 'jackets';`

**Mapping helper:** `getCategoryGroup(category: string): CategoryGroup | null` at `src/shopify/variants.ts:9` - maps free-text `baseCategory` to one of the 5 buckets.

**Used by:**
- `scoreImageQuality(buffer, garmentType)` in `src/shopify/image-scorer.ts`.
- `buildPrompt(garmentType, view, colorName)` in `src/lib/prompt-templates.ts:62`.
- `generateGarmentView(... garmentType: CategoryGroup ...)` in `src/lib/ai-image-generator.ts:213`.

**Implication for verifier:** The verifier does NOT consume `CategoryGroup` from the sheet directly - per SPEC R2 the reference signal is the source front image. The 5 labels appear in the prompt as expected output classes (the model emits a label), but the verifier never reads sheet `categoryGroup`. This decouples the verifier from sheet-column drift.


## Retry & Skip+Log Patterns (matching existing code)

### Existing retry mechanics (`ai-image-generator.ts`)

Current 2-round shape (lines 248-305):
- **Round 1:** `callImagesEdit()` then `scoreCandidates()` then filter by `passesHue`; if any pass, return best.
- **Round 2** (lines 275-305, fires when no round-1 passing): `callImagesEdit()` with retry prompt then `scoreCandidates()` then filter by `passesHue`; if any pass, return best.
- **D-04 fallback** (lines 307-326): if no candidates passed hue in either round, return best-scoring of all 6.

**R3 changes only the filter predicate** - structure/budget checks/prompt-builders untouched. Replace `c.passesHue` with `c.passesHue && c.passesType` at lines 261 and 292.

### TSV write pattern

Verified from `tmp/imagery-audit.tsv` and `tmp/contaminated-sides-unfixable.tsv`:
- Tab-separated, header on line 1, append across runs.

Helper structure: import `appendFile`, `access`, `writeFile` from `node:fs/promises`. Sanitize fields by replacing `[\t\n\r]+` with single space. Build header line `'pid\tview\treason\ttimestamp\trun_id\n'` and row line by tab-joining fields with `\n`. Use `access()` to check existence; if exists `appendFile`; if not `writeFile(header + line)`.

### Existing null-return-as-skip handling (no audit-runner changes needed)

`src/lib/audit-runner.ts:341-369` already handles `generateGarmentView()` returning `null`: it sets `resolvedBuffers[view] = { buffer: Buffer.alloc(0), score: null, verdict: 'fail', status: 'skipped', reason: 'AI generation failed or budget exhausted' }`.

Lines 380-393: when `resolvedBuffers[view].buffer.length === 0`, the view is skipped without an upload. Phase 15 may want to update the reason string to reflect "type mismatch" vs "budget exhausted" - recommend threading reason through `GenerateViewResult` OR letting the rejects-TSV be the canonical record.

## Retro Audit Script Pattern (per Phase 12 structure)

Template: `scripts/audit-images.ts` (515 lines, fully read).

### Reusable structure to copy:
1. `import 'dotenv/config'` at top.
2. `parseArgs` from `node:util` for CLI.
3. `showHelp()` function with usage examples.
4. DI: `RunAuditArgs`, `RunAuditDeps` interfaces; `runAudit(deps)` exported separately from `main()`.
5. Chunked reader via `readRowRange(client, spreadsheetId, offset, CHUNK_SIZE, sheetName)` for `--all`.
6. Deduplication via `colorGroupMap` keyed by `${styleID}|${colorName}`.
7. Flags: `--style-id <ID>`, `--all`, `--dry-run`.
8. Summary block at end.

### Simplifications for retro script
- No `uploadToDrive`, no `writeUpdates` - read-only.
- No `CostTracker` (D-05).
- No `auditProductImages` - loop body is just `downloadImage` then `verifyGarmentTypeMatch` then `appendTsv` if `!match`.
- Add `--limit N` for sampling; `--filter-category <bucket>` for targeted runs.

### Skip cases (don't call Vision)
- `row.FrontImage` empty or invalid (`isInvalidUrl` matches `assetly.ordermygear` per audit-images.ts:336).
- Both `row.BackImage` AND `row.DirectSideImage` empty.
- `downloadImage()` throws (log warning, continue).

### Cost arithmetic
- Per D-05: ~283 products x 2 views x $0.0001/call = ~$0.06 per pass.
- [CITED: openai pricing] gpt-4o-mini Vision: $0.150/1M input, $0.600/1M output. Two 1024x1024 images at `detail: low` encode at ~1500 input tokens combined; output ~30 tokens. Per-call ~$0.0002-0.0003 - closer to $0.12-0.18 total per pass. "No budget gating" decision holds at either price point.


## Test Strategy (mocked + fixture-gated patterns from codebase)

### Pattern 1: Mocked OpenAI (extend `tests/lib/ai-image-generator.test.ts`)

Existing infrastructure to reuse (verified from file read):
- `vi.mock('openai', ...)` factory at lines 21-41. Extend: add `chat = { completions: { create: mockChatCompletionsCreate } }` to the fake OpenAI class.
- `vi.mock('../../src/shopify/image-scorer.js', ...)` at lines 49-51.
- `vi.mock('../../src/lib/hue-utils.js', ...)` at lines 59-67.
- `vi.mock('sharp', ...)` at lines 73-82.
- `vi.clearAllMocks()` in `beforeEach`.

New mock to add: declare `const mockChatCompletionsCreate = vi.fn();` at module scope. Inside the existing `vi.mock('openai', ...)` factory, add `chat = { completions: { create: mockChatCompletionsCreate } };` as a field on the fake `OpenAI` class alongside `images = { edit: mockImagesEdit };`.

### Test cases to add (per D-10)

| Test | Setup | Assertion |
|------|-------|-----------|
| R1: Candidate filter | round1: 3 candidates; mockChat returns `{match:false}` for c1+c2, `{match:true}` for c3; all 3 pass hue+quality | Winner is c3 even if c1/c2 have higher quality scores |
| R3: Strict AND round-2 fires | round1: c1 (hue=pass, type=fail), c2 (hue=pass, type=fail), c3 (hue=fail, type=pass); round2: 1 candidate passing both | `usedRetry===true`, `callCount===2`, mockChat called 4 times |
| R3: No retry when one passes both | round1: c1 (hue=pass, type=pass) | `usedRetry===false`, `callCount===1` |
| R4: Skip on total fail | All 6 candidates `{match:false}`; all pass hue | Returns `null`; TSV write called once with correct pid/view/reason |
| R5: CostTracker not decremented by verifier | spy `costTracker.record`; trigger 2 rounds | `recordSpy.calls === 2` (one per `images.edit`), NOT 8 |
| Verifier API failure | mockChat rejects; 3 candidates with passing hue | Returns a candidate (not null); `logger.warn` called |

TSV write mock: use `vi.mock('node:fs/promises', ...)` returning `{ ...actual, appendFile: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined), access: vi.fn().mockResolvedValue(undefined) }` so the test environment never touches the real filesystem.

### Pattern 2: Real Vision API gated on OPENAI_API_KEY (new `tests/lib/garment-type-verifier.test.ts`)

The test file uses `describe.skipIf(!process.env.OPENAI_API_KEY)` to silently skip the entire block on CI without the key. Inside the block, iterate `Object.entries(labels)` from the imported `labels.json` and for each pid declare two `it()` blocks: one for back vs front, one for side vs front. Each test reads the PNG via `readFile()`, calls `verifyGarmentTypeMatch(client, viewBuf, frontBuf)`, and asserts `result.match === label.expected_match[view]`. Use a 30000ms test timeout per case to accommodate real API latency.

labels.json schema (per D-08): top-level object keyed by pid. Each pid maps to `{ expected_category: string, front_path: string, back_path: string, side_path: string, expected_match: { back: boolean, side: boolean } }`. Example pids: `"A343"` (expected_match both false - regression case) and `"FIXTURE-tops-01"` (expected_match both true - positive control). Mandatory pids: A343 + 5 known-good (1 per CategoryGroup).

**CI implication:** Without `OPENAI_API_KEY`, `describe.skipIf` silently skips fixture tests. Unit tests (Pattern 1) always run.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAI Vision call | Custom HTTP wrapper | Existing `client.chat.completions.create()` | `describeGarment()` is a working template at line 35 |
| JSON parsing from LLM | Naive `JSON.parse` | `response_format: { type: 'json_object' }` + regex-extract fallback | Forced JSON mode eliminates ~90% of parse errors |
| TSV writing | Custom CSV library | `node:fs/promises` `appendFile`/`writeFile` + manual tab joins | Matches existing repo pattern |
| Image download | Custom fetch | `downloadImage()` from `src/shopify/image-standardizer.ts` | Already used by audit-runner at line 292 |
| Sheets read | Custom Google API client | `readAllRows` / `readRowRange` from `src/sheets/reader.js` | Same pattern audit-images.ts uses |
| CLI argument parsing | `commander`/`yargs` | Node built-in `parseArgs` from `node:util` | Already used by audit-images.ts |
| Env-gated tests | Manual `if (process.env.X) skip` | `describe.skipIf(!process.env.X)` | Native Vitest API; reports as skipped not failed |
| Sheet row dedup | Hand-rolled Map loop | Copy `colorGroupMap` pattern from `scripts/audit-images.ts:140-149` | Battle-tested across 49K-row sheets |

**Key insight:** Phase 15 has zero need for new dependencies. Every primitive has a precedent within 1-2 files of where the new code lands.

## Runtime State Inventory

> Feature-additive phase, but previously-generated Drive images are not verified by the in-pipeline check. The retro script (R6) is the explicit answer.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Drive: ~283 bestsellers x 3 views with no shape verification flag. No DB stores garment-type provenance. | Retro script (R6) scans + flags; no migration to a flag column (deferred). |
| Live service config | None. | None. |
| OS-registered state | None. | None. |
| Secrets/env vars | `OPENAI_API_KEY` (already required by Phase 10). | None - no new secrets. |
| Build artifacts | None (tsx runtime, no separate build step). | None. |


## Common Pitfalls

### Pitfall 1: Verifier rejects valid candidates due to model error or parse failure
**What goes wrong:** gpt-4o-mini returns malformed JSON or hallucinates "match: false" on a legitimate pair.
**How to avoid:** On parse failure or API error, fall through with `match: true` (per CONTEXT specifics). Log warning.
**Warning signs:** Spike in `[verifier]` warnings; rejects-TSV row count drops to zero on a known-bad batch.

### Pitfall 2: Threading pid through the call stack for the rejects-TSV
**What goes wrong:** `generateGarmentView()` has no pid parameter today.
**How to avoid:** Add `pid: string` parameter. Update single in-tree caller in `audit-runner.ts:304` and `:342` to pass `row.productId`. Unit tests stub it.
**Warning signs:** TypeError in tests; rejects-TSV rows with empty pid.

### Pitfall 3: Mutating shared CandidateResult interface breaks existing tests
**What goes wrong:** Adding required field breaks any literal-construction site.
**How to avoid:** `CandidateResult` is internal to `ai-image-generator.ts` and only constructed in `scoreCandidates()`. Update the construction site in one place.
**Warning signs:** TS compile errors referencing missing fields.

### Pitfall 4: Double-counting Vision calls toward CostTracker
**What goes wrong:** Passing `costTracker` into `verifyGarmentTypeMatch()` "for telemetry."
**How to avoid:** Verifier signature is `(client, generatedBuffer, frontBuffer)` - no tracker. Inline comment to discourage drift.
**Warning signs:** R5 unit test fails with `recordSpy.calls > 2`.

### Pitfall 5: Retro script accidentally writes to Drive or Sheets
**What goes wrong:** Operator later extends the script to "fix while you scan."
**How to avoid:** No imports from `drive.js`, `writer.js`, or `audit-runner.js`. Top-of-file comment: "READ-ONLY: must never call uploadToDrive or writeUpdates."
**Warning signs:** Diff shows write-side imports appearing.

### Pitfall 6: Two large base64 images in one Vision call hit token limits
**What goes wrong:** Two 1024x1024 PNGs base64 ~2.7 MB of text per call.
**How to avoid:** Use `image_url.detail: 'low'` - server-side downscale. Avoid client-side sharp resize unless rate limits show up.
**Warning signs:** Verifier hits TPM rate limit on a full retro pass; per-call latency >5s.

## Code Examples

### Example 1: verifyGarmentTypeMatch helper (drop-in template)

Function signature: `async function verifyGarmentTypeMatch(client: OpenAI, generatedBuffer: Buffer, frontBuffer: Buffer): Promise<{ match: boolean; reason: string }>`.

Implementation outline (wrap in try/catch around the whole body):
1. `const genB64 = generatedBuffer.toString('base64');` and same for frontBuffer.
2. Call `client.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 100, response_format: { type: 'json_object' }, messages: [...] })` as documented in the Vision Prompt Design section.
3. Extract `const raw = response.choices[0]?.message?.content?.trim() ?? '';`
4. Try `const jsonMatch = raw.match(/\{[\s\S]*\}/);` - if null, log warn and return `{ match: true, reason: 'verifier parse error (fallback to match)' }`.
5. `const parsed = JSON.parse(jsonMatch[0]);` then return `{ match: parsed.match === true, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '' }`.
6. Catch block: log warn and return `{ match: true, reason: 'verifier api error (fallback to match)' }`.

### Example 2: Updated CandidateResult interface

Extend the existing interface at `ai-image-generator.ts:73-80` to add two new fields after `passesHue: boolean`:
- `passesType: boolean;`
- `typeMatchReason: string;`

### Example 3: Updated filter predicate (replaces line 261 + 292)

Replace `round1Candidates.filter(c => c.passesHue)` with `round1Candidates.filter(c => c.passesHue && c.passesType)`. Same change for `round2Candidates`.

### Example 4: Updated D-04 fallback block (replaces lines 307-326)

After computing `allCandidates`, if `allCandidates.length === 0` return null (unchanged). Then compute `const typePassing = allCandidates.filter(c => c.passesType);`. If `typePassing.length === 0`: log warning citing pid/view, await `appendRejectRow({ pid, view, reason: allCandidates[0]?.typeMatchReason ?? 'unknown', timestamp: new Date().toISOString(), run_id: getOrCreateRunId() })`, return null. Otherwise reduce `typePassing` to the highest-score candidate via `.reduce((a, b) => (b.score > a.score ? b : a))` and return a `GenerateViewResult` built from that candidate.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Caption-then-string-compare for shape match | Side-by-side two-image Vision prompt | Locked in CONTEXT D-01 (2026-05-08) | Single Vision call per candidate; bypasses caption fidelity |
| JSON-mode optional | `response_format: { type: 'json_object' }` on gpt-4o-mini | OpenAI shipped JSON mode for 4o-family late 2024 | Near-zero parse-failure rate |
| `detail: 'auto'` on image_url | `detail: 'low'` for comparison tasks | OpenAI Vision pricing 2025 | ~3x lower per-call cost; sufficient for family-level match |

**Deprecated/outdated:** N/A - Phase 15 introduces new functionality.


## Validation Architecture (Nyquist evidence map)

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (verified: existing `tests/lib/*.test.ts` use `import { describe, it, expect, vi, beforeEach } from 'vitest'`) |
| Config file | `vitest.config.ts` (verified by existing tests) |
| Quick run command | `npx vitest run tests/lib/ai-image-generator.test.ts tests/lib/garment-type-verifier.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R1 | Type-mismatched candidates excluded from winner selection | unit (mocked OpenAI) | `npx vitest run tests/lib/ai-image-generator.test.ts -t "R1"` | extend existing |
| R2 | `verifyGarmentTypeMatch` returns `{match, reason}` correctly | unit + fixture (real API, gated) | `npx vitest run tests/lib/garment-type-verifier.test.ts` | new (Wave 0) |
| R3 | Strict AND retry trigger | unit (mocked) | `npx vitest run tests/lib/ai-image-generator.test.ts -t "R3"` | extend existing |
| R4 | Returns null + writes TSV when all 6 fail type | unit (mocked fs/promises) | `npx vitest run tests/lib/ai-image-generator.test.ts -t "R4"` | extend existing |
| R5 | CostTracker not decremented by verifier | unit (spy on record) | `npx vitest run tests/lib/ai-image-generator.test.ts -t "R5"` | extend existing |
| R6 | Retro script writes TSV on fixture mismatch, no Drive writes | integration (mocked sheets, real verifier, gated) | `npx vitest run tests/scripts/audit-garment-types.test.ts` | new (Wave 0) |
| Accept: A343 regression | A343 front+back -> `match: false` | fixture (real API, gated) | `npx vitest run tests/lib/garment-type-verifier.test.ts -t "A343"` | needs A343 fixtures committed |
| Accept: 5 known-good per CategoryGroup | Each pair -> `match: true` | fixture (real API, gated) | `npx vitest run tests/lib/garment-type-verifier.test.ts` | needs 5 fixture pairs |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/lib/ai-image-generator.test.ts tests/lib/garment-type-verifier.test.ts` (~15s mocked; +30-60s if OPENAI_API_KEY set)
- **Per wave merge:** `npx vitest run` (full Vitest suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`; fixture tests pass with OPENAI_API_KEY set locally.

### Wave 0 Gaps
- [ ] `tests/lib/garment-type-verifier.test.ts` - covers R2 fixture-gated assertions
- [ ] `tests/fixtures/garment-type/labels.json` - fixture index
- [ ] `tests/fixtures/garment-type/A343-{front,back,side}.png` - regression buffers (3 binaries)
- [ ] `tests/fixtures/garment-type/FIXTURE-{tops,hoodies,polos,crewnecks,jackets}-01-{front,back,side}.png` (15 binaries - 5 pids x 3 views)
- [ ] `tests/scripts/audit-garment-types.test.ts` (optional smoke) - read-only constraint + TSV write
- [ ] Framework install: none - Vitest already in deps.

## Security Domain

> `security_enforcement` not explicitly set in `.planning/config.json`. Treat as enabled. Security relevance is low for this phase.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A - no user-facing endpoints |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A - CLI runs as the operator |
| V5 Input Validation | yes | Sanitize verifier `reason` for tab/newline before TSV write. |
| V6 Cryptography | no | N/A |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| API key in error log | Information Disclosure | Never log full OpenAI request/response; openai SDK strips Authorization header by default. |
| Untrusted image fetch from CDN -> SSRF | Tampering | `downloadImage()` validates http(s) URLs; sheet URLs are operator-curated. Low risk. |
| TSV injection via reason containing tab/newline | Tampering | Replace tab/newline runs with single space before write. |
| Prompt injection via image content | Tampering | Verifier prompt anchors output to JSON-only with hardcoded labels; fallback on parse failure is `match: true` (degrades safely). |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Everything | yes | >=20 (verified by scripts using `node:util` parseArgs strict mode) | N/A |
| `openai` SDK | verifier helper | yes | already a dep | N/A |
| `sharp` | optional pre-verifier downscale | yes | already a dep | N/A |
| `googleapis` (Sheets + Drive) | retro script | yes | already a dep | N/A |
| `vitest` | all tests | yes | already a dep | N/A |
| `OPENAI_API_KEY` | real-Vision tests + retro script | depends on local env | - | `it.skipIf` skips fixture tests; retro script errors out cleanly if missing |
| `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` | retro script | depends on local env | - | Retro script errors cleanly if missing (mirrors audit-images.ts:466) |

**No new dependencies required.**


## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | v1 Vision prompt achieves >=95% pass-rate on 6-fixture set without iteration | Vision Prompt Design | LOW - fixture experiment in plan-phase catches this; iteration is cheap |
| A2 | `response_format: { type: 'json_object' }` works on gpt-4o-mini Vision calls | Vision Prompt Design | LOW - regex-extract fallback works without JSON mode |
| A3 | gpt-4o-mini at `detail: 'low'` is accurate enough for crewneck-vs-hoodie | Pitfall 6 | MEDIUM - switch to `detail: 'auto'` at ~3x cost if false-negatives spike |
| A4 | `downloadImage()` accepts arbitrary Drive/CDN URLs without auth munging | Retro Audit Script | LOW - audit-runner.ts:292 already uses it on the same URL set |
| A5 | Per-call cost ~$0.0002-0.0003 (not $0.0001 in CONTEXT D-05) | Retro Audit Script | TRIVIAL - decision (no budget gating) holds either way |
| A6 | Adding `pid: string` to `generateGarmentView()` is the cleanest TSV-threading path | Integration Map / Pitfall 2 | LOW - falls under Claude's Discretion in CONTEXT |

**Confirmation needed from user:** None - A1+A3 are validated by fixture tests; A5 immaterial; A6 implementation detail.

## Open Questions

1. **TSV reason field - what level of detail on total-fail?**
   - What we know: D-07 fixes `reason` column. Verifier returns ~80-char `reason`.
   - What is unclear: One reason, all 6, or summary?
   - Recommendation: Record most-frequent reason with count, e.g., `"5/6 said: front is crewneck, candidate is hoodie"`. Claude's Discretion.

2. **Should the rejects-TSV deduplicate on (pid, view) within a run?**
   - What we know: D-06/D-07 say append across runs.
   - Recommendation: Append (no in-run dedup); `run_id` lets the operator filter. Simplest.

3. **Retro script - skip rows whose front itself looks wrong-shape?**
   - What we know: Verifier reference signal is `row.FrontImage`. A bad-shape front produces false mismatches.
   - Recommendation: Out of scope v1. Add `--dry-run` listing the fronts that would be used so operator can spot-check.

4. **Where does the rejects-TSV writer live?**
   - What we know: Write happens on total type-match failure in `generateGarmentView()` (R4).
   - Recommendation: Extract to `src/lib/rejects-tsv.ts` from the start since R6 also writes the same TSV. Planner decides.

5. **Image resize before the verifier - yes or no?**
   - Recommendation: Use `image_url.detail: 'low'` only - no client-side pre-resize. Simpler.

## Sources

### Primary (HIGH confidence)
- `src/lib/ai-image-generator.ts` (382 lines, full file read) - generateGarmentView, scoreCandidates, describeGarment, CandidateResult, retry/fallback logic
- `src/lib/ai-image-types.ts` (full read) - CANDIDATES_PER_CALL, HUE_DRIFT_THRESHOLD, GenerateViewResult, AIView
- `src/lib/cost-tracker.ts` (full read) - CostTracker.canAfford/record/remaining
- `src/lib/prompt-templates.ts` (full read) - buildPrompt*, buildRetryPrompt*, CLEANUP_PROMPT
- `src/lib/audit-runner.ts` (lines 1-100, 270-420 read) - null-as-skip handling, downloadImage usage
- `src/shopify/types.ts:102` (Grep verified) - `CategoryGroup` type
- `src/shopify/variants.ts:9` (Grep verified) - `getCategoryGroup` helper
- `scripts/audit-images.ts` (515 lines, full read) - CLI template for R6
- `tests/lib/ai-image-generator.test.ts` (495 lines, full read) - Vitest mock patterns
- `.planning/phases/15-garment-type-verification/15-SPEC.md` - R1-R6
- `.planning/phases/15-garment-type-verification/15-CONTEXT.md` - D-01 through D-11
- `.planning/config.json` - yolo mode, fine granularity, plan_check + verifier enabled
- `tmp/imagery-audit.tsv`, `tmp/contaminated-sides-unfixable.tsv` (head reads) - TSV format convention

### Secondary (MEDIUM confidence)
- OpenAI gpt-4o-mini Vision pricing - [CITED: training data; order-of-magnitude only]
- `response_format: { type: 'json_object' }` on gpt-4o-mini Vision - [CITED: training data; verified for text-only, assumed-equivalent for vision]
- `image_url.detail: 'low'` server-side downscale - [CITED: training data]
- Vitest `describe.skipIf` / `it.skipIf` - [VERIFIED: established API]

### Tertiary (LOW confidence)
- Exact per-call cost ($0.0002 vs CONTEXT's $0.0001) - [ASSUMED] - immaterial
- v1 prompt phrasing passes 100% of fixtures without iteration - [ASSUMED] - planner validates

## Metadata

**Confidence breakdown:**
- Integration map (where R1-R6 land): HIGH - every file/line referenced was directly read
- Vision prompt design: MEDIUM - template is mechanically sound; exact wording validated on fixtures
- CategoryGroup taxonomy: HIGH - Grep verified
- Retry/skip patterns: HIGH - direct read of audit-runner.ts and ai-image-generator.ts
- Retro audit script pattern: HIGH - `scripts/audit-images.ts` read in full
- Test strategy: HIGH - extends existing mocked-OpenAI test file pattern verbatim
- Pitfalls: HIGH for codebase-derived; MEDIUM for Vision-API quirk items

**Research date:** 2026-05-11
**Valid until:** 2026-06-10 (30 days)
