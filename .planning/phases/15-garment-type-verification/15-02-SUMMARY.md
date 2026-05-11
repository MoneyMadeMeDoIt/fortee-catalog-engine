---
phase: 15-garment-type-verification
plan: 02
subsystem: ai-image-generator
tags: [verifier-integration, vision-api, strict-and-filter, type-match, skip-on-fail]
requires:
  - phase: 15-garment-type-verification
    provides: "verifyGarmentTypeMatch helper + appendRejectRow TSV writer (Plan 01)"
provides:
  - "CandidateResult.passesType + typeMatchReason populated per candidate"
  - "scoreCandidates(buffers, frontHue, frontIsAchromatic, garmentType, openai, frontBuffer) signature"
  - "generateGarmentView(frontBuffer, view, garmentType, colorName, pid, costTracker, client?, productName?) — pid threaded for TSV log"
  - "Strict AND filter predicate (passesHue && passesType) at both winner-selection sites (R3)"
  - "Skip-on-total-type-fail behavior (R4) — null return + one appendRejectRow call"
  - "CostTracker bypass for verifier calls (R5) — record only called by images.edit"
affects:
  - "Plan 03 retro audit script (consumes same verifier helper)"
  - "Plan 04 fixture-gated real-API E2E (relies on filter+skip behavior verified here)"
  - "Phase 16+ Drive cleanup pipelines (will see fewer wrong-shape rejects)"
tech-stack:
  added: []
  patterns:
    - "Verifier wired inside the existing per-candidate serial loop (no parallel refactor)"
    - "appendRejectRow consumed at the failure boundary, not inside the verifier itself"
    - "Existing test suite remains green via verifier-fallback returning match=true on unseeded mocks"
key-files:
  created: []
  modified:
    - "src/lib/ai-image-generator.ts — CandidateResult interface (lines 190-199), scoreCandidates (lines 270-313), generateGarmentView signature (line 341-350), filter predicates (lines 392 + 423), D-04 fallback block (lines 446-486)"
    - "src/lib/audit-runner.ts — both generateGarmentView call sites at lines 305 + 343 thread row.productId"
    - "scripts/fill-missing-info.ts — 3rd in-tree caller updated at line 390 to pass prod.productId"
    - "tests/lib/ai-image-generator.test.ts — mockChatCompletionsCreate + rejects-tsv mock + 6 new Phase-15 tests appended (lines 526-746)"
decisions:
  - "Added pid: string parameter to generateGarmentView positioned between colorName and costTracker (per Plan 01 SPEC interface block); 3 in-tree callers updated."
  - "Found a 3rd production caller (scripts/fill-missing-info.ts:390) beyond the 2 in audit-runner.ts noted by the plan — updated to pass prod.productId (deviation Rule 3: blocking — typecheck failure otherwise)."
  - "When all 6 candidates fail type-match, typePassing.length===0 returns null + writes ONE row using allCandidates[0].typeMatchReason as the reason (per RESEARCH Example 4)."
  - "Preserved D-04 hue-fallback semantics for the type-passing subset: if some candidates passed type but none passed hue, still return the best-scoring type-passing one (constrained best-of-N)."
  - "Existing AIGEN-01..AIGEN-04 + D-04 + D-07 tests do NOT seed mockChatCompletionsCreate — they rely on the verifier-fallback (match=true) so the suite stays green without rewriting each existing test."
metrics:
  duration: "~18 minutes"
  tasks_completed: 3
  files_created: 0
  files_modified: 4
  tests_added: 6
  completed: 2026-05-11
requirements-completed: [R1, R3, R4, R5]
---

# Phase 15 Plan 02: Garment Type Verifier In-Pipeline Wiring Summary

**Wired Plan 01's `verifyGarmentTypeMatch()` into `scoreCandidates()` + `generateGarmentView()` so candidates failing garment-type comparison are excluded from winner selection, retry round fires under strict AND, total type-failure returns null + writes one rejects-TSV row, and CostTracker is bypassed by verifier calls (R1+R3+R4+R5).**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-05-11T13:30:00Z
- **Completed:** 2026-05-11T13:50:00Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- A343-class regression bug is now caught at generation time — wrong-shape candidates cannot win winner-selection.
- Strict AND filter predicate (`passesHue && passesType`) replaces the old `passesHue`-only predicate at both winner sites (R3).
- Total type-failure path returns `null` + writes exactly one TSV row via `appendRejectRow` (R4).
- CostTracker is provably untouched by the verifier code path (R5, asserted in test).
- `pid` parameter threaded through three production callers cleanly.

## Task Commits

1. **Task 1: Extend CandidateResult + scoreCandidates with type-match check** — `97f1554` (feat)
2. **Task 2: Wire strict AND filter + skip-on-total-fail in generateGarmentView** — `64e805c` (feat)
3. **Task 3: Add 6 Phase-15 tests for R1/R3/R4/R5 + verifier-fallback** — `f644feb` (test)

## Files Created/Modified

- `src/lib/ai-image-generator.ts` — `CandidateResult` interface extended; `scoreCandidates` signature gained `openai` + `frontBuffer`; per-candidate `verifyGarmentTypeMatch` call inserted in the serial loop; `generateGarmentView` signature gained `pid: string`; both filter sites changed to `passesHue && passesType`; D-04 fallback block replaced with three-branch logic (no candidates / no type-passing / hue-fallback constrained to type-passing).
- `src/lib/audit-runner.ts` — Both `generateGarmentView(...)` call sites at lines 305 and 343 now thread `row.productId` as the 5th positional argument.
- `scripts/fill-missing-info.ts` — Third in-tree caller at line 390 updated to pass `prod.productId`.
- `tests/lib/ai-image-generator.test.ts` — Extended openai mock with `chat.completions.create`; added `vi.mock('../../src/lib/rejects-tsv.js', ...)` with `mockAppendRejectRow` + `mockGetOrCreateRunId`; added `makeChatResponse` + `makeDescribeGarmentResponse` helpers; updated all 10 existing test call sites with `'TEST-PID'`; appended `describe('generateGarmentView — Phase 15 type-match', ...)` block with 6 new tests (R1, R3a, R3b, R4, R5, verifier-API-failure).

## Verification Results

| Task | Verify Command | Result |
|------|----------------|--------|
| 1 | `grep -n "passesType: boolean\|typeMatchReason: string\|verifyGarmentTypeMatch(openai, buffer, frontBuffer)" src/lib/ai-image-generator.ts` | PASS — exactly 3 matches (interface + interface + call) |
| 1 | `npx tsc --noEmit ... grep scoreCandidates` | PASS — produces 2 "Expected 6 arguments, but got 4" errors (intentional intermediate state) |
| 2 | `npx tsc --noEmit` on touched src/ files | PASS — source code clean (1 pre-existing error at line 250 already noted in Plan 01 SUMMARY, out of scope per CLAUDE.md) |
| 2 | All Task 2 grep acceptance criteria | PASS — `passesHue && c.passesType` × 2, `appendRejectRow` × 2, `getOrCreateRunId` × 2, `pid: string,` × 1, `row.productId, costTracker` × 2, rejects-tsv import × 1, audit-runner generateGarmentView callers × 2, verifier-CostTracker coupling × 0 |
| 3 | `npx vitest run tests/lib/ai-image-generator.test.ts` | PASS — 18/18 tests (12 existing + 6 new) |
| 3 | `npx vitest run` (full suite) | PASS — 369/369 tests across 31 files |
| Overall | `grep -c "passesType" src/lib/ai-image-generator.ts` | 6 (interface + scoreCandidates assignment + result push + 2 filter predicates + typePassing reduce) |

## Decisions Made

- **`pid` parameter positioning**: placed between `colorName` and `costTracker` per the Plan 01 SPEC interface block. Three in-tree callers (audit-runner × 2 + fill-missing-info × 1) all had a product-id symbol in scope so the change was mechanical.
- **Reason field source on total fail**: used `allCandidates[0]?.typeMatchReason ?? 'unknown'` per RESEARCH Example 4. Did not synthesize an aggregate "5/6 said X" line — that's the Open Question #1 deferred decision, and the simplest implementation matched the plan's verbatim action step.
- **Existing tests left as-is on the verifier-mock front**: instead of seeding `mockChatCompletionsCreate` in every old test, the existing tests rely on the verifier's error-fallback (returns `match: true` on unseeded responses). This keeps the diff scoped to the new R1-R5 tests and avoids touching the 10 existing test bodies beyond adding `'TEST-PID'` as a positional arg.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Found a 3rd in-tree caller of `generateGarmentView`**

- **Found during:** Task 2 (typecheck after audit-runner edits)
- **Issue:** Plan stated "Both audit-runner.ts callers (line 304 + line 342) need `pid: row.productId` threaded" but the verification grep also flagged `scripts/fill-missing-info.ts:390` calling the function. Without updating it, `npx tsc --noEmit` would surface a `Expected 6-8 arguments, but got 5` error on that line, blocking the Task 2 typecheck gate.
- **Fix:** Updated `scripts/fill-missing-info.ts:390` to pass `prod.productId` as the 5th positional argument (matching pattern: `prod.productId` was already in scope at the loop level `for (const prod of scope)` at line 232).
- **Files modified:** `scripts/fill-missing-info.ts`
- **Verification:** `npx tsc --noEmit` now reports zero new errors on touched src/scripts files.
- **Committed in:** `64e805c` (rolled into Task 2 commit as part of the coupled signature/caller change).

### Line-number shifts (informational, not deviations)

Plan referenced specific line numbers from a pre-Plan-01 state of `ai-image-generator.ts`. Plan 01 inserted the verifier function (lines 65-180) so all downstream references shifted by ~100 lines:

| Plan reference | Actual location after Plan 01 |
|----------------|-------------------------------|
| `CandidateResult` at lines 73-80 | lines 190-199 |
| `scoreCandidates` at lines 151-184 | lines 270-313 |
| `generateGarmentView` at lines 211-219 | lines 341-350 |
| Round 1 filter at line 261 | line 392 |
| Round 2 filter at line 292 | line 423 |
| D-04 fallback at lines 307-326 | lines 446-486 (after replacement) |

All anchors found via structural patterns (`async function scoreCandidates(`, `.filter(c => c.passesHue)`, `D-04 fallback`) per the executor instructions. No functional impact — line numbers were used as locators only.

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking) + 6 informational line-shifts.
**Impact on plan:** Single Rule 3 fix was essential for the Task 2 typecheck gate. No scope creep — the 3rd caller was already using the function exactly the same way as the audit-runner sites.

## Issues Encountered

- None. The plan was tight and the line shifts predicted by the executor's deviation note were exactly as expected.

## User Setup Required

None — all changes are local code + tests. No environment variables, no Drive/Sheets credentials, no real Vision API calls (full suite uses mocked OpenAI).

## Known Stubs

None.

## Threat Flags

None. The plan's `<threat_model>` (T-15-01 vision cost / T-15-02 TSV injection / T-15-03 API-key in fixtures) is fully addressed:

- **T-15-01:** Verifier-error fallback (`match: true, reason: 'verifier api error fallback'`) is exercised by the "verifier API failure" test and proven to keep generation succeeding when the verifier breaks.
- **T-15-02:** The `appendRejectRow` writer from Plan 01 already sanitizes `reason` via `[\t\n\r]+` collapse. This plan only passes the LLM reason through; no inline writer was created.
- **T-15-03:** All 6 new tests use `vi.mock('openai', ...)` — no real client constructed, no `OPENAI_API_KEY` referenced.

## Open Follow-ups for Plan 03 / 04

1. **Plan 03 (retro audit R6)** — Create `scripts/audit-garment-types.ts`. This plan's changes do not touch the retro path. (Note: a `tests/scripts/audit-garment-types.test.ts` already exists per `git status` — suggests Plan 03 may have been started ahead of this plan; verify before claiming Wave 3 work.)
2. **Plan 04 (fixture-gated real-API E2E)** — Source the A343 + 5 known-good fixture binaries and the `describe.skipIf(!process.env.OPENAI_API_KEY)` test. No dependency on Plan 02 internals beyond the now-exported `verifyGarmentTypeMatch`.
3. **Operational signal**: when this ships, the rejects TSV at `tmp/garment-type-rejects.tsv` becomes the operator's review queue. No alerting wired — manual TSV scan is the v1 review workflow.

## Commits

| Commit | Message |
|--------|---------|
| `97f1554` | feat(15-02): extend CandidateResult + scoreCandidates with type-match check |
| `64e805c` | feat(15-02): wire strict AND filter + skip-on-total-fail in generateGarmentView |
| `f644feb` | test(15-02): add 6 Phase-15 tests for R1/R3/R4/R5 + verifier-fallback |

## Self-Check: PASSED

- `src/lib/ai-image-generator.ts` — modified, `passesType` count = 6, `appendRejectRow` import + call present
- `src/lib/audit-runner.ts` — both callers thread `row.productId` (grep verified)
- `scripts/fill-missing-info.ts` — 3rd caller threads `prod.productId` (grep verified)
- `tests/lib/ai-image-generator.test.ts` — 6 new tests, all 10 existing calls updated
- Commit `97f1554` — FOUND in `git log`
- Commit `64e805c` — FOUND in `git log`
- Commit `f644feb` — FOUND in `git log`
- Full vitest suite — 369 / 369 PASS
- `passesHue && c.passesType` — exactly 2 matches (R3 acceptance grep)

---
*Phase: 15-garment-type-verification*
*Completed: 2026-05-11*
