---
phase: 17-catalog-image-pollution-fix
plan: 07
subsystem: cleanup-checkpoint
tags: [phase-17, b-3-fix, cleanup-script, manual-folder, di-seam, tdd]
dependency_graph:
  requires:
    - "Phase 16 Plan 04: scripts/fix-image-pollution-manual.ts handleReplace path (hardcodes supplierCode='MANUAL')"
    - "Phase 16 Plan 04: scripts/cleanup-checkpoint-test-data.ts original CHECKPOINT-TEST/ scan logic"
    - "src/sheets/drive.ts: createDriveClient + trashDriveFile (unchanged)"
  provides:
    - "scripts/cleanup-checkpoint-test-data.ts with MANUAL/ scan path (B-3 closed)"
    - "tests/scripts/cleanup-checkpoint-test-data.test.ts (7 tests covering R17-07 + T-17-23/T-17-24)"
    - "Exported runCleanup(deps: CleanupDeps) DI seam + TEST_PIDS const"
  affects:
    - "Phase 17 17-07 acceptance: future checkpoint runs leave zero MANUAL/CHECKPOINT-TEST-NNN/ orphans after cleanup"
tech_stack:
  added: []
  patterns:
    - "DI seam mirror from Phase 16's fix-image-pollution.ts — runCleanup(deps: CleanupDeps) with vi.fn()-shaped helper functions"
    - "Direct-invocation guard: main() runs only when fileURLToPath(import.meta.url) === process.argv[1], so test imports don't trip process.exit"
    - "T-17-23 exact-name folder lookup — `name = '<TEST_PID>'` in the Drive query string never enumerates non-test subfolders"
    - "T-17-24 parent-folder safety — MANUAL/ root never appears as trashDriveFile arg; only per-pid subfolders + their descendants"
key_files:
  created:
    - tests/scripts/cleanup-checkpoint-test-data.test.ts
    - .planning/phases/17-catalog-image-pollution-fix/deferred-items.md
  modified:
    - scripts/cleanup-checkpoint-test-data.ts
decisions:
  - "TDD RED commit FIRST (test file with broken imports) then GREEN commit (script refactor + helpers) — followed the gate sequence strictly so the test commit precedes the implementation commit in git log."
  - "deleteBrRows kept as an inline closure passed into deps via deleteBrRowsFn — its logic is well-tested via Phase 16 live runs; refactoring it out would have expanded scope beyond B-3."
  - "Added a direct-invocation guard (`fileURLToPath(import.meta.url) === process.argv[1]`) so `main()` runs only when the script is invoked via `npx tsx ...`, not when imported by the test file. Without the guard, importing the module from tests would call process.exit(1) due to missing GOOGLE_SPREADSHEET_ID env var."
  - "main() always returns a CleanupResult object via runCleanup; brRowsDeleted is gated by `if (deps.spreadsheetId)` so test deps don't have to provide one."
metrics:
  duration_minutes: 7
  completed_date: 2026-05-14
  tests_added: 7
  files_created: 2
  files_modified: 1
  script_lines: 363
  test_lines: 336
---

# Phase 17 Plan 07: Cleanup MANUAL/ scan summary

B-3 cleanup blind-spot patched. `scripts/cleanup-checkpoint-test-data.ts` now scans both `CHECKPOINT-TEST/` (existing) and `MANUAL/CHECKPOINT-TEST-NNN/` (new) Drive folder trees and trashes orphan files in both locations. The MANUAL/ scan uses exact-name `TEST_PIDS` matching so real operator force-replace folders (e.g. `MANUAL/S05610/`) are never enumerated, and the `MANUAL/` parent itself is never trashed. Refactored to expose a `runCleanup(deps: CleanupDeps)` DI seam mirroring the Phase 16 fix-image-pollution.ts pattern so 7 vi.fn()-mocked tests can drive the cleanup end-to-end without any real Drive/Sheets calls.

## Commits

| Task | Commit   | Message                                                          |
| ---- | -------- | ---------------------------------------------------------------- |
| T1 (RED)   | 9f4a78a | test(17-07-T1): add failing tests for cleanup MANUAL/ scan      |
| T1 (GREEN) | ad13d46 | fix(17-07-T1): add MANUAL/ scan to cleanup script + DI seam     |

## Files Created

| Path                                                                                | Purpose                                                                                  | Lines |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----- |
| tests/scripts/cleanup-checkpoint-test-data.test.ts                                  | 7-test DI-mocked suite — R17-07 coverage + T-17-23/T-17-24 mitigations                  | 336   |
| .planning/phases/17-catalog-image-pollution-fix/deferred-items.md                   | Pre-existing test failures (lib + shopify) confirmed not caused by 17-07                | 32    |

## Files Modified

| Path                                       | Change                                                                                              | Delta |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----- |
| scripts/cleanup-checkpoint-test-data.ts    | +173 / -16 — 2 new helpers, exported runCleanup DI seam, exported TEST_PIDS, direct-invoke guard    | +189  |

## New helpers (3)

| Symbol                                       | Kind      | Purpose                                                                                          |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| findManualFolderId                           | function  | Locates MANUAL/ at the configured Drive images root. Returns null when absent (silent no-op).    |
| trashCheckpointArtifactsInManualFolder       | function  | For each TEST_PID, exact-name lookup of MANUAL/<pid>/ then descends + trashes; then trashes the per-pid folder itself. Mitigates T-17-23 + T-17-24. |
| runCleanup                                   | function  | Exported DI seam. Mirrors Phase 16 pattern. main() now constructs concrete deps and delegates.   |

## Public Exports

| Symbol         | Kind      | Purpose                                                              |
| -------------- | --------- | -------------------------------------------------------------------- |
| runCleanup     | function  | Cleanup orchestration entry point with full DI                       |
| TEST_PIDS      | const     | Exact array `['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002']`         |
| CleanupDeps    | interface | DI contract (driveClient, sheetsClient, 5 helper fns, spreadsheetId) |
| CleanupResult  | interface | Returned summary (ctTrashed, manualTrashed, brRowsDeleted)           |

## Test cases (7/7 passing)

| # | Test                                                                                                    | Asserts                                                                                                          |
| - | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1 | Existing CHECKPOINT-TEST/ scan still runs when MANUAL/ is absent                                        | trashDriveFile called 4 times (3 descendants + 1 CT parent); manualTrashed=0                                     |
| 2 | Both CHECKPOINT-TEST/ + MANUAL/CHECKPOINT-TEST-001/ + MANUAL/CHECKPOINT-TEST-002/ scans run             | 7 trash calls total (2 CT desc + 1 CT parent + 1+1 MANUAL desc + 1+1 MANUAL per-pid folders); manualTrashed=2     |
| 3 | MANUAL/ exists but no CHECKPOINT-TEST-* subfolders → MANUAL no-op                                       | MANUAL side issues per-pid lookups (>= 2) but zero trash calls; CT side still runs                                |
| 4 | T-17-23 — MANUAL/ contains S05610 (real prod pid) alongside CHECKPOINT-TEST-001                         | No drive.files.list query uses `name = 'S05610'`; every MANUAL-scoped query targets one of TEST_PIDS exactly      |
| 5 | T-17-24 — MANUAL/ parent folder never trashed                                                            | trashDriveFile never called with `'MANUAL-FOLDER'`; M-001-FOLDER + M-002-FOLDER per-pid folders ARE trashed       |
| 6 | Idempotent re-run — both folders empty, zero trash calls                                                | trashDriveFile NOT called; ctTrashed=manualTrashed=brRowsDeleted=0                                                |
| 7 | TEST_PIDS const integrity                                                                                | Imports TEST_PIDS and asserts exact deep-equal `['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002']`                  |

## Smoke test

Not run — operator's account may have no MANUAL/CHECKPOINT-TEST-*/ orphans left after Phase 16's manual cleanup. The plan flagged this as optional; the 7-test DI suite covers all the path semantics.

## Verification

Acceptance criteria from the plan — all pass:

| AC | Expectation                                                                                       | Result |
| -- | ------------------------------------------------------------------------------------------------- | ------ |
| 1  | `^async function findManualFolderId\(` present                                                    | line 54 |
| 2  | `^async function trashCheckpointArtifactsInManualFolder\(` present                                | line 154 |
| 3  | `^export async function runCleanup\(` present                                                     | line 299 |
| 4  | `^export interface CleanupDeps ` present                                                          | line 276 |
| 5  | `name = '${pid}'` exact-match per-pid lookup present (T-17-23 mitigation)                         | line 175 |
| 6  | `tests/scripts/cleanup-checkpoint-test-data.test.ts` exists                                       | yes |
| 7  | `npx vitest run tests/scripts/cleanup-checkpoint-test-data.test.ts` reports 7 tests passing       | 7/7 PASS |
| 8  | `npx vitest run` full suite — no regressions caused by 17-07                                      | confirmed (see Deferred Issues) |

## Deviations from Plan

### None for the script + test work itself

The script refactor matched the plan's spelled-out interface 1:1 (3 helpers + DI seam + exported TEST_PIDS + CleanupDeps interface). Test count matches the plan (7).

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Importing the script triggered `process.exit(1)`**

- **Found during:** RED-phase test run (Task 1 first vitest invocation)
- **Issue:** The existing script ended with `main().catch(... process.exit(1))` at module top-level. When the new test file imports `runCleanup` from the script, that import auto-ran `main()`, which immediately failed because `GOOGLE_SPREADSHEET_ID` was unset in the test env, and the `process.exit(1)` in the catch handler crashed vitest with an unhandled rejection. Without this fix, none of the 7 tests could even be collected (vitest reported `0 tests`).
- **Fix:** Wrapped the `main().catch(...)` invocation in a direct-invocation guard: `if (fileURLToPath(import.meta.url) === process.argv[1]) { main().catch(...) }`. This is the standard Node ESM idiom for "only run when invoked via CLI, not when imported as a module".
- **Files modified:** scripts/cleanup-checkpoint-test-data.ts
- **Commit:** ad13d46 (GREEN — bundled with the main implementation since the test-file import was the trigger)

**2. [Rule 3 — Blocking] esbuild parse error from `MANUAL/CHECKPOINT-TEST-*/` inside a JSDoc block**

- **Found during:** RED-phase test run (first vitest invocation)
- **Issue:** The opening JSDoc comment in the test file contained the path string `MANUAL/CHECKPOINT-TEST-*/`. The `*/` substring closed the JSDoc block early, and esbuild then choked on the unquoted text "orphans behind" outside the comment. Vitest reported `Expected ";" but found "behind"`.
- **Fix:** Rewrote the docstring to use `MANUAL/CHECKPOINT-TEST-(NNN)/` (parenthesized placeholder) instead of the literal glob — preserves the meaning without embedding a JSDoc-terminator.
- **Files modified:** tests/scripts/cleanup-checkpoint-test-data.test.ts (in-place during RED, before commit)
- **Commit:** 9f4a78a (RED — fix applied before the RED commit so the test file at least imports cleanly)

## Deferred Issues

The full vitest suite (`npx vitest run`) reports 9 pre-existing failures across 4 unrelated files:

- `tests/lib/garment-type-verifier.test.ts` (whole-file load failure)
- `tests/lib/ai-image-generator.test.ts` (6 tests in `Phase 15 type-match` describe block)
- `tests/lib/audit-runner.test.ts` (2 tests in `auditProductImages` describe block)
- `tests/shopify/metaobjects.test.ts` (1 test — `print_area` vs `print_areas` plurality drift)

These were confirmed present on pristine master before Plan 17-07 started (verified by checking out `master:scripts/cleanup-checkpoint-test-data.ts` and re-running the affected suites). They are out of scope per the executor scope-boundary rule and logged in `deferred-items.md` for follow-up.

## TDD Gate Compliance

Plan flagged Task 1 with `tdd="true"`. Gate sequence followed:

| Gate     | Commit  | Verification                                                                                                  |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| RED      | 9f4a78a | `test(17-07-T1): ...` — tests file added; importing `runCleanup`/`CleanupDeps`/`TEST_PIDS` from the script fails because those exports don't exist yet. Vitest reports 7 failed tests (or 0 tests w/ unhandled rejection on the bare `main()` import). |
| GREEN    | ad13d46 | `fix(17-07-T1): ...` — script refactored with helpers + DI seam + direct-invocation guard. All 7 tests pass.  |
| REFACTOR | n/a     | No refactor needed; helpers were sized correctly on first cut.                                                |

## Self-Check: PASSED

- [x] scripts/cleanup-checkpoint-test-data.ts modified — verified at 363 lines, contains all 3 new symbols + exports + DI seam.
- [x] tests/scripts/cleanup-checkpoint-test-data.test.ts created — verified at 336 lines, 7 tests passing.
- [x] .planning/phases/17-catalog-image-pollution-fix/deferred-items.md created — verified at 32 lines.
- [x] Commits 9f4a78a (test) and ad13d46 (fix) present in git log.
- [x] `npx vitest run tests/scripts/cleanup-checkpoint-test-data.test.ts` → 7/7 passing.
- [x] `npx vitest run tests/scripts/` → 75/75 passing across all script-test files (no sibling regressions).
- [x] Full-suite failures (9) confirmed pre-existing on master; not caused by 17-07.
