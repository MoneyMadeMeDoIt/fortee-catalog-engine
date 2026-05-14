---
phase: 17-catalog-image-pollution-fix
plan: 01
subsystem: infra
tags: [drive, gaxios, googleapis, timeout, retry, dos-mitigation]

requires:
  - phase: 16-catalog-image-pollution-audit-fix
    provides: "Existing 4 Drive helpers (downloadFromDrive, getDriveFileMetadata, trashDriveFile) + uploadToDrive pattern that this plan wraps without breaking signatures."
provides:
  - "DRIVE_TIMEOUT_MS (30s) + DRIVE_RETRY_MAX (2) + withDriveRetry + isTimeoutError"
  - "Bounded-latency Drive helpers (B-1 fix from PRODUCTION-AUDIT-FINDINGS.md)"
  - "11 new tests on retry/timeout semantics + T-17-02 cred-leak + T-17-04 update-in-place"
affects:
  - 17-02-per-color-canonical
  - 17-03-model-rebuild
  - 17-04-d12-prefix-dispatcher
  - 17-05-manual-triage
  - 17-06-fix-image-pollution-manual-dry-run
  - 17-07-cleanup-checkpoint-test-data-manual
  - 17-08-fix-image-pollution-billing-shortcircuit
  - All future plans that touch Drive (every Phase 17 follow-up re-triggers full-catalog Drive scans)

tech-stack:
  added: []
  patterns:
    - "Drive-gaxios two-layer timeout: per-attempt gaxios `timeout` option + outer withDriveRetry retry budget."
    - "Timeout error classification via code (ECONNABORTED/ETIMEDOUT/ERR_CANCELED) + message-substring fallback for SDK drift."
    - "T-17-02 credential-leak guard: retry log lines carry only caller-supplied label + fileId + attempt counter — never err.config / err.response."

key-files:
  created:
    - "tests/sheets/drive.test.ts (rewritten: 327 line delta, +274 net)"
  modified:
    - "src/sheets/drive.ts (+143 net, 406 total)"

key-decisions:
  - "Two-layer timeout (gaxios option + withDriveRetry) rather than AbortController like image-standardizer.ts — gaxios accepts `timeout` directly in its 2nd-arg options object, simpler than wrapping in an AbortController for googleapis."
  - "withDriveRetry helper extracted (~20 LOC) instead of inlining the loop 9 times — matches the inline-duplication-is-drift note in the plan action section."
  - "Retry budget of 2 (3 attempts total) per the plan — worst-case extra latency per stuck call: 90s vs the 2.5h hang observed at pid 1376842 on 2026-05-13."
  - "Timeout-shaped errors are retried; non-timeout errors (404 / 403 / 5xx) rethrow immediately so operators distinguish a hard miss from a network stall."

patterns-established:
  - "Pattern A (Drive timeout helper): every gaxios drive.files.* call MUST carry `timeout: DRIVE_TIMEOUT_MS` in its 2nd-arg options object AND be wrapped in `withDriveRetry(() => ..., label)`. Both layers are mandatory."
  - "Pattern B (logging hygiene at boundary): error retry logs use only the label string from the caller. err.config / err.response — which contain auth headers — are never serialized into logger output."

requirements-completed: [R17-01]

duration: 5min
completed: 2026-05-14
---

# Phase 17 Plan 01: Drive fetch timeout + retry (B-1 fix) Summary

**Bounded-latency wrapper (`withDriveRetry` + gaxios `timeout`) on every Drive HTTP call — turns the 2026-05-13 indefinite-hang scenario into a max-90s per-call thrown error.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-14T12:59:15Z
- **Completed:** 2026-05-14T13:04:18Z
- **Tasks:** 1 (TDD: RED + GREEN, no refactor needed)
- **Files modified:** 2 (`src/sheets/drive.ts`, `tests/sheets/drive.test.ts`)

## Accomplishments

- Wrapped all 5 gaxios call sites in 4 public Drive helpers + the internal `findOrCreateFolder` helper — 9 `withDriveRetry(...)` wraps total, 11 `timeout: DRIVE_TIMEOUT_MS` occurrences.
- Added `DRIVE_TIMEOUT_MS = 30_000`, `DRIVE_RETRY_MAX = 2`, `isTimeoutError`, `withDriveRetry<T>(op, label)` — file-local, no new exports, public API surface unchanged.
- Wrote 11 new tests + kept the 8 pre-existing carry-over tests passing (19/19 green). Tests prove:
  - happy path zero-warn,
  - 3-attempt retry succeeds on attempt 3,
  - retry budget exhaustion rethrows the gaxios error verbatim,
  - non-timeout (404) errors short-circuit retry,
  - T-17-02 cred-leak guard (no Bearer / Authorization / private_key in any warn line),
  - T-17-04 update-in-place survives `files.update` retry without calling `files.create`.
- No regressions in Phase 16 tests (53/53 in audit + fix + manual passing).
- No new TypeScript errors in `src/sheets/drive.ts` or `tests/sheets/drive.test.ts`.

## Task Commits

TDD task with RED + GREEN gates:

1. **Task 1 (RED): add failing tests for Drive timeout + retry budget** — `c92431e` (test)
2. **Task 1 (GREEN): wrap Drive helpers in timeout + retry budget (B-1 fix)** — `619b63c` (feat)

No REFACTOR commit — the GREEN implementation matched the plan exactly, no cleanup needed.

## Files Created/Modified

- `src/sheets/drive.ts` (+143 net, 406 total) — added `DRIVE_TIMEOUT_MS`, `DRIVE_RETRY_MAX`, `isTimeoutError`, `withDriveRetry`; wrapped `findOrCreateFolder` (2 wraps), `uploadToDrive` (4 wraps: list + update OR create + permissions.create), `downloadFromDrive` (1 wrap), `trashDriveFile` (1 wrap), `getDriveFileMetadata` (1 wrap).
- `tests/sheets/drive.test.ts` (+274 net, 473 total) — 19 tests covering extractFileId carry-over, downloadFromDrive happy path + retry success + exhaustion rethrow + non-timeout fast-rethrow, getDriveFileMetadata happy path + empty-field defaults + retry, trashDriveFile happy + retry, uploadToDrive list-retry + create-retry, T-17-02 leak guard, T-17-04 update-in-place + Test 11 source declarations.

## Test Cases (11 new)

1. **downloadFromDrive happy path** — `drive.files.get` resolves once with `{ data: <ArrayBuffer> }`; assertion: `responseType: 'arraybuffer'` AND `timeout: 30_000` on the 2nd-arg options object; Buffer returned; no warn logged.
2. **downloadFromDrive timeout retry succeeds on 3rd attempt** — `ECONNABORTED` thrown twice then resolve; assertion: 3 `files.get` calls, 2 warns with `attempt 1/3` and `attempt 2/3` + fileId.
3. **downloadFromDrive all 3 attempts time out** — `ETIMEDOUT` thrown 3x; assertion: 3 calls, 3 warns, error rethrown verbatim (`/socket hang up/`).
4. **downloadFromDrive non-timeout error rethrown immediately** — synthetic 404; assertion: single call, NO warn, error rethrown.
5. **getDriveFileMetadata happy + empty-defaults + retry** — three sub-cases asserting param shape (`fields: 'mimeType,size,name'`), 2nd-arg `{ timeout: 30_000 }`, empty-string defaults, and `ERR_CANCELED` / `ETIMEDOUT` retry success.
6. **trashDriveFile timeout retry + happy path** — retry success on 3rd attempt with `timeout: 30_000` verified on every call; happy path logs `[drive] Trashed file <id>`.
7. **uploadToDrive timeout retry on findOrCreateFolder.files.list** — first `files.list` throws `ERR_CANCELED` once then 3 successful lookups follow; ends in `files.create` + `permissions.create`; final URL = `…?id=NEW_FILE_ID`.
8. **uploadToDrive timeout retry on files.create** — `request aborted` message-based timeout detection (no `code`); assertion: 2 `files.create` calls; final URL = `…?id=CREATED_AFTER_RETRY`.
9. **T-17-02 credential-leak guard** — drains the retry budget; every `logger.warn` message inspected: no `Bearer`, `Authorization`, `private_key`, `GOOGLE_PRIVATE_KEY` (case-insensitive); must contain `attempt` + the fileId only.
10. **T-17-04 update-in-place survives retry** — existing file found; `files.update` throws timeout once then resolves; assertion: 2 `files.update` calls; `files.create` NEVER called; URL contains `EXISTING`.
11. **Source-declaration guard** — reads `src/sheets/drive.ts` from disk; asserts `^const DRIVE_TIMEOUT_MS = 30_000` and `^const DRIVE_RETRY_MAX = 2` declarations exist, plus `function withDriveRetry` and `function isTimeoutError` are present.

## Decisions Made

- **`withDriveRetry` extracted to a single helper** instead of inlining the retry loop 9 times. The plan's `<action>` step (3) explicitly mandated this — inline duplication is a known drift source in this codebase.
- **`isTimeoutError` accepts message-substring fallback** in addition to `err.code` checks. Justification: gaxios + Node-internal SDK paths surface timeouts inconsistently across versions. Message substrings (`'aborted' | 'timeout' | 'canceled'`) cover the path where `err.code` is undefined (e.g., AbortController under the hood). Test 8 exercises this path with a synthetic `Error('request aborted')` that has no `code` field — and the retry still fires.

## Deviations from Plan

None — plan executed exactly as written. The test file was rewritten rather than appended-to because the pre-existing 8 tests had assertions like `expect(opts).toEqual({ responseType: 'arraybuffer' })` that would fail with strict-equality after the timeout option was added; updating those assertions to match the new shape was the minimum necessary edit.

## Issues Encountered

- **Worktree was behind master at start of execution** — the agent was spawned with the worktree branch at the Phase 16 planning state, before Phase 17's plan files were committed. Resolved by `git merge master --no-edit` to bring the worktree up to the Phase 17 plan-locked state before reading the plan file. Surface for the orchestrator: future Phase 17 agents may need the same merge step or the orchestrator should refresh worktrees before spawn.
- **Pre-existing test failures in unrelated files** — `tests/lib/audit-runner.test.ts` (1 fail), `tests/shopify/metaobjects.test.ts` (2 fails), `tests/scripts/audit-images.test.ts` (TS compile errors) are pre-existing as of master. Verified by stashing my changes and re-running the same tests — failures persist. Out of scope per the deviation-rules scope boundary.

## User Setup Required

None — no environment variables, dashboard config, or secrets added. The `GOOGLE_PRIVATE_KEY` and `GOOGLE_SERVICE_ACCOUNT_EMAIL` env vars are unchanged.

## Recommended Smoke Test

**Strongly recommend operator re-run** `npx tsx scripts/audit-image-pollution.ts --all` against the same 449-pid corpus that hung at pid 1376842 on 2026-05-13. With the wrapper in place:
- Either the run completes the full 449-pid scan in bounded wall-clock time (best case — the underlying Drive flake has cleared),
- OR the previously-stuck pid surfaces as a per-pid retry+throw in stderr (`[drive] downloadFromDrive timeout (attempt N/3) on <fileId>`), the audit's per-pid try/catch catches the throw, and the run continues past that pid into the remaining 14+ unscanned pids.

Either way confirms the original deadlock is no longer possible.

## Next Phase Readiness

- Plan 17-02 (per-color canonical), 17-04 (D-12 prefix dispatcher widening), 17-03 (Model rebuild) can now safely trigger full-catalog Drive scans without indefinite-hang risk.
- Plans 17-06 / 17-07 / 17-08 (the Wave 1 sibling cleanups on disjoint files) can run in parallel with 17-01's downstream consumers.

## Self-Check: PASSED

Files verified to exist:
- `src/sheets/drive.ts` — modified, 406 lines (includes `DRIVE_TIMEOUT_MS`, `DRIVE_RETRY_MAX`, `isTimeoutError`, `withDriveRetry`, 9 wrap sites, 11 `timeout: DRIVE_TIMEOUT_MS` occurrences)
- `tests/sheets/drive.test.ts` — modified, 473 lines, 19 tests
- `.planning/phases/17-catalog-image-pollution-fix/17-01-SUMMARY.md` — this file

Commits verified to exist on `worktree-agent-a9cf51e87b19b725f`:
- `c92431e` test(17-01-T1): add failing tests for Drive timeout + retry budget
- `619b63c` feat(17-01-T1): wrap Drive helpers in timeout + retry budget (B-1 fix)

Test gates verified:
- `npx vitest run tests/sheets/drive.test.ts` → 19/19 passing
- `npx tsc --noEmit -p tsconfig.json` → no new errors in target files
- Phase 16 regression check (`tests/scripts/audit-image-pollution.test.ts`, `tests/scripts/fix-image-pollution.test.ts`, `tests/scripts/fix-image-pollution-manual.test.ts`) → 53/53 passing

## TDD Gate Compliance

- RED gate: `c92431e` `test(17-01-T1): ...` — 11/19 tests failing as expected.
- GREEN gate: `619b63c` `feat(17-01-T1): ...` — 19/19 tests passing.
- REFACTOR gate: skipped — implementation matched plan, no cleanup commit needed.

Gate sequence: test → feat. Both commits present in git log.

---
*Phase: 17-catalog-image-pollution-fix*
*Completed: 2026-05-14*
