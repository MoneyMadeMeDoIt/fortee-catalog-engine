---
phase: 17-catalog-image-pollution-fix
plan: 08
subsystem: image-pollution-fix-orchestrator
tags: [bug-fix, tier-2, openai, billing, short-circuit, trail]
dependency_graph:
  requires:
    - "src/lib/image-pollution-trail.ts (Phase 16 TrailOperation union + loadProcessedPids)"
    - "scripts/fix-image-pollution.ts (Phase 16 Tier 2 loop)"
    - "OpenAI.BadRequestError typed error shape"
  provides:
    - "TrailOperation = ... | 'TIER2_BUDGET_EXHAUSTED' (10-variant union)"
    - "scripts/fix-image-pollution.ts billing-hard-limit short-circuit (B-4)"
    - "__resetBillingExhaustedForTest export (test-only)"
    - "RunImagePollutionFixResult.status = ... | 'BILLING_LIMIT_HIT'"
    - "JSON summary field tier2_budget_exhausted_count"
  affects:
    - "Future re-runs after operator tops up OpenAI billing — affected pids retry"
    - "post-mortem scripts (awk over trail TSV) — new op type is filterable"
tech-stack:
  added: []
  patterns:
    - "Typed-error inspection (`err instanceof OpenAI.BadRequestError` + `err.code` check)"
    - "Module-scope feature-flag with explicit reset helper for test isolation"
    - "Re-throw billing errors from tier2Fix so outer loop can flip the flag"
key-files:
  created:
    - ".planning/phases/17-catalog-image-pollution-fix/17-08-SUMMARY.md"
  modified:
    - "scripts/fix-image-pollution.ts"
    - "src/lib/image-pollution-trail.ts"
    - "tests/lib/image-pollution-trail.test.ts"
    - "tests/scripts/fix-image-pollution.test.ts"
decisions:
  - "TIER2_BUDGET_EXHAUSTED is NOT a terminal-op (Open Q6) — pid stays retry-eligible after billing top-up"
  - "BILLING_LIMIT_HIT takes precedence over BLOCKED-QUEUE-OVERFLOW because remediation is different (top up vs broaden coverage)"
  - "tier2Fix re-throws billing errors instead of letting the catch block convert them to verifier_rejected"
metrics:
  duration: "~25 minutes (2 tasks, TDD RED → GREEN cycle on each)"
  completed_date: "2026-05-14"
  tasks: 2
  tests_added: 9
requirements: [R17-08]
---

# Phase 17 Plan 08: OpenAI billing-hard-limit short-circuit Summary

## One-Liner

Tier 2 in `fix-image-pollution.ts` now detects `OpenAI.BadRequestError` with `code === 'billing_hard_limit_reached'` ONCE, sets a module-scope flag, logs ONE warning, and short-circuits the remaining cascaded pids without further API calls — fixing the production behavior that called the OpenAI API 213 times in a row after the first billing-limit hit on 2026-05-14.

## Tasks Completed

### Task 1: Widen `TrailOperation` + ensure `loadProcessedPids` non-terminality

**Commit:** `1ea3886` — `fix(17-08-T1): widen TrailOperation with TIER2_BUDGET_EXHAUSTED`

**Files modified:**
- `src/lib/image-pollution-trail.ts` — widen union to 10 variants; JSDoc explains non-terminal semantics.
- `tests/lib/image-pollution-trail.test.ts` — add `describe('17-08 TIER2_BUDGET_EXHAUSTED')` with 3 tests.

**Behavior added:**
1. `TrailOperation` accepts `'TIER2_BUDGET_EXHAUSTED'` at compile time (TS) and runtime (`appendTrailRow`).
2. `loadProcessedPids` deliberately excludes `TIER2_BUDGET_EXHAUSTED` from the terminal set `{BR_WRITE, MANUAL_SKIP, MANUAL_ACCEPT}`. A pid with only `TIER2_BUDGET_EXHAUSTED` rows stays retry-eligible on the next run.
3. `appendTrailRow` writes the new op in the standard 9-column TSV format with `tier=2`.

**Verification:** `npx vitest run tests/lib/image-pollution-trail.test.ts` → 13/13 passing (10 pre-existing + 3 new).

### Task 2: Add billing-hard-limit short-circuit to Tier 2 loop

**Commit:** `8ff23fc` — `fix(17-08-T2): OpenAI billing-hard-limit short-circuit in Tier 2 loop`

**Files modified:**
- `scripts/fix-image-pollution.ts` — module-scope `__billingExhausted` flag, `isBillingHardLimit(err)` helper, tier2Fix re-throws billing errors, Tier 2 loop has fast-path + first-detection branches, status enum widened, summary JSON gains `tier2_budget_exhausted_count`.
- `tests/scripts/fix-image-pollution.test.ts` — extend `vi.mock('openai')` to expose `BadRequestError`; add `describe('17-08 B-4 billing hard limit')` with 6 tests.

**Behavior added (per the plan's `<must_haves>`):**
1. **First detection:** When `generateGarmentView` throws an `OpenAI.BadRequestError` with `code === 'billing_hard_limit_reached'` (or message contains `"Billing hard limit has been reached"`), `__billingExhausted` flips to `true`, ONE `logger.warn` line fires, a `TIER2_BUDGET_EXHAUSTED` sentinel row is appended for the affected pid, and the pid is marked `cascade: true`.
2. **Subsequent pids short-circuit:** Each iteration checks `__billingExhausted` at entry. If set, no API call is made; a sentinel `TIER2_BUDGET_EXHAUSTED` row is appended and the pid cascades.
3. **Non-billing errors unaffected:** `content_policy_violation`, generic `Error`, and `null` return paths all continue to behave exactly as in Phase 16.
4. **Status enum widened:** New value `'BILLING_LIMIT_HIT'` takes precedence over `'BLOCKED-QUEUE-OVERFLOW'` so the operator sees the actual cause.
5. **Summary JSON:** `tier2_budget_exhausted_count` is always emitted (zero when no billing hit occurred).
6. **Resume safety:** Confirmed by Task 1 + Test 5 — a pid with only `TIER2_BUDGET_EXHAUSTED` rows in today's trail is NOT skipped by `loadProcessedPids` and will retry on the next run.

**Tier 2 re-throw rationale:** Phase 16's `tier2Fix` caught and swallowed all errors internally (returning `verifier_rejected`). The outer loop never saw the error. To let the outer loop detect billing errors WITHOUT breaking the existing swallow-other-errors contract, `tier2Fix` now re-throws iff `isBillingHardLimit(err)` returns true; all other errors are still swallowed as before.

**Verification:** `npx vitest run tests/scripts/fix-image-pollution.test.ts` → 23/23 passing (17 pre-existing + 6 new).

## Test Coverage

| Test | Behavior verified |
|------|-------------------|
| `17-08 TIER2_BUDGET_EXHAUSTED > accepts TIER2_BUDGET_EXHAUSTED as a TrailOperation (compile-time)` | TS union widened + runtime accept |
| `17-08 TIER2_BUDGET_EXHAUSTED > loadProcessedPids does NOT treat TIER2_BUDGET_EXHAUSTED as terminal` | Non-terminal semantics |
| `17-08 TIER2_BUDGET_EXHAUSTED > appendTrailRow writes TIER2_BUDGET_EXHAUSTED row in 9-column TSV format` | TSV row format integrity |
| `17-08 B-4 billing hard limit > Test 1 (first pid hits ... → short-circuits rest)` | Primary detection path |
| `17-08 B-4 billing hard limit > Test 2 (message-substring fallback when code is undefined)` | Older-SDK fallback |
| `17-08 B-4 billing hard limit > Test 3 (content_policy_violation does NOT short-circuit)` | Specificity — non-billing OpenAI errors |
| `17-08 B-4 billing hard limit > Test 4 (generic Error does NOT short-circuit)` | Specificity — non-OpenAI errors |
| `17-08 B-4 billing hard limit > Test 5 (resume safety: TIER2_BUDGET_EXHAUSTED is non-terminal, pids retried on re-run)` | Resume contract |
| `17-08 B-4 billing hard limit > Test 6 (summary JSON has tier2_budget_exhausted_count + BILLING_LIMIT_HIT)` | Operator-visible reporting |

**9 new tests, all passing.**

## Acceptance Criteria (all met)

```
src/lib/image-pollution-trail.ts:
  'TIER2_BUDGET_EXHAUSTED'                                      ✅ 1 match (line 78)

tests/lib/image-pollution-trail.test.ts:
  describe('17-08 TIER2_BUDGET_EXHAUSTED'                       ✅ 1 match

scripts/fix-image-pollution.ts:
  let __billingExhausted = false                                ✅ 1 match (line 47)
  function isBillingHardLimit(err                               ✅ 1 match (line 63)
  billing_hard_limit_reached                                    ✅ 3 matches
  TIER2_BUDGET_EXHAUSTED                                        ✅ 3 matches (≥2 required)
  BILLING_LIMIT_HIT                                             ✅ 4 matches (≥2 required)
  tier2_budget_exhausted_count                                  ✅ 1 match
  export function __resetBillingExhaustedForTest                ✅ 1 match (line 54)

tests/scripts/fix-image-pollution.test.ts:
  describe('17-08 B-4 billing hard limit'                       ✅ 1 match
```

## Operator-facing changes

When the orchestrator hits the OpenAI billing hard limit:

- **Before (Phase 16):** 213 pids each call OpenAI; 213 separate warn lines; status reported as `BLOCKED-QUEUE-OVERFLOW`; operator must dig through stderr to diagnose.
- **After (17-08):** Exactly ONE API call (the detection one); ONE warn line:
  ```
  [fix-image-pollution] OpenAI billing hard limit — aborting Tier 2
  ```
  `tmp/image-pollution-fix-trail-YYYY-MM-DD.tsv` gets one `TIER2_BUDGET_EXHAUSTED` row per affected pid (the first one annotated `(first detection)`); JSON summary status is `BILLING_LIMIT_HIT` with `tier2_budget_exhausted_count: N`; remediation is "top up billing and re-run" (the affected pids stay retry-eligible).

## Replay of 2026-05-14 production scenario

The 2026-05-14 production audit hit the OpenAI billing limit on Tier 2's very first pid and made 213 redundant API calls. With 17-08 in place:

- Test 1 verifies the new fast-path: with 3 cascaded pids and a mocked first-call billing error, `generateGarmentViewFn` is invoked exactly once.
- Test 6 verifies the summary surfaces both the new status and the count.
- Test 5 verifies a follow-up run after the operator tops up billing will retry the affected pids (because TIER2_BUDGET_EXHAUSTED is non-terminal in `loadProcessedPids`).

The new test fixtures throw a mocked `OpenAI.BadRequestError` with the exact production `code` value, so the regression is now covered by the suite.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tier2Fix swallowed errors internally**

- **Found during:** Task 2 RED → GREEN cycle. Test 1, 2, 6 initially failed even though the helper + flag were in place.
- **Issue:** Phase 16's `tier2Fix` had a try/catch around `generateGarmentViewFn` that caught ALL errors, set `regen = null`, and returned `{ status: 'verifier_rejected' }`. The billing error never escaped `tier2Fix` to the outer Tier 2 loop where the plan's `isBillingHardLimit` check lives. So the flag never flipped.
- **Fix:** Modified `tier2Fix`'s inner catch to re-throw iff `isBillingHardLimit(err)` returns true; all other errors still swallowed (preserving Phase 16's existing behavior for non-billing failures).
- **Files modified:** `scripts/fix-image-pollution.ts` (added 5 lines to `tier2Fix`'s catch).
- **Commit:** `8ff23fc` (folded into Task 2).

**2. [Rule 1 - Bug] Two TS errors in new test code**

- **Found during:** TS check after initial Task 2 commit attempt.
- **Issue:** `vi.spyOn(logger, 'warn').mockImplementation(() => undefined)` — the implementation function returns `undefined` but `Logger.warn` is typed to return `Logger`. Caused `c[0]` in the follow-up `.find` to be inferred as `never`.
- **Fix:** Cast the implementation `as never` and the call array `as unknown[][]`.
- **Files modified:** `tests/scripts/fix-image-pollution.test.ts` (2 line changes).
- **Commit:** Folded into Task 2 (`8ff23fc`).

### Pre-existing issues NOT fixed (out of scope per Rule 4 SCOPE BOUNDARY)

- `scripts/fix-image-pollution.ts:291-293` — three pre-existing `CategoryGroup` TS errors (`'polos'`, `'crewnecks'`, `'jackets'` not in the type). Present on `master` before 17-08 began (verified via `git stash`). Documented for a future cleanup pass.
- 9 pre-existing test failures in `tests/lib/garment-type-verifier.test.ts`, `tests/lib/ai-image-generator.test.ts`, `tests/lib/audit-runner.test.ts`, `tests/shopify/metaobjects.test.ts`. Present on `master` before 17-08; unrelated to this plan's scope (Phase 15 / Phase 10 / Phase 9 surface).

### No deviations from `<must_haves>`

All 5 truth statements verified by tests:
1. ✅ Billing-hard-limit detection → flag + log + sentinel + cascade
2. ✅ Subsequent pids short-circuit via flag check
3. ✅ `TIER2_BUDGET_EXHAUSTED` is a new TrailOperation variant; backward-compat
4. ✅ `loadProcessedPids` doesn't treat it as terminal
5. ✅ Resume safety preserved

All 4 STRIDE mitigations applied:
- **T-17-25 (DoS):** Zero API calls after first detection. Verified by Test 1's `.mock.calls.length === 1`.
- **T-17-26 (Repudiation):** ONE warn + sentinel rows + clear status. Verified by Test 1 + Test 6.
- **T-17-27 (Info disclosure):** `logger.warn` logs only the typed code message, NOT the raw `err.message` (which could contain account/org IDs). Implementation hand-checked against `scripts/fix-image-pollution.ts:887` and `:917`.
- **T-17-28 (Tampering):** `TIER2_BUDGET_EXHAUSTED` not added to terminal set. Verified by trail Test "loadProcessedPids does NOT treat ... as terminal" + fix-image-pollution Test 5.

## Smoke test

Not run (would require an OpenAI key with a hit hard limit). The new test fixtures replay the 2026-05-14 production scenario via mocked `OpenAI.BadRequestError`.

## Self-Check: PASSED

**Files verified to exist (on disk):**
- `scripts/fix-image-pollution.ts` ✅ (modified)
- `src/lib/image-pollution-trail.ts` ✅ (modified)
- `tests/scripts/fix-image-pollution.test.ts` ✅ (modified)
- `tests/lib/image-pollution-trail.test.ts` ✅ (modified)
- `.planning/phases/17-catalog-image-pollution-fix/17-08-SUMMARY.md` ✅ (this file)

**Commits verified to exist:**
- `1ea3886` `fix(17-08-T1): widen TrailOperation with TIER2_BUDGET_EXHAUSTED` ✅
- `8ff23fc` `fix(17-08-T2): OpenAI billing-hard-limit short-circuit in Tier 2 loop` ✅
