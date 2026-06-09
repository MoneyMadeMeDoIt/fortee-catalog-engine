---
phase: 17-catalog-image-pollution-fix
plan: 06
subsystem: manual-cli
tags: [phase-17, b-2-fix, dry-run-gate, drive-trash, footgun-close, tdd]
dependency_graph:
  requires:
    - "Phase 16 Plan 04: scripts/fix-image-pollution-manual.ts handleReplace + handleManualRow paths (the call sites)"
    - "Phase 16 Plan 04: pre-existing Sheets-write gates at lines 404 + 741 (the pattern this plan mirrors)"
    - "Phase 16 Plan 01: T-16-01 compare-before-trash invariant (preserved unchanged in live mode)"
  provides:
    - "scripts/fix-image-pollution-manual.ts with --dry-run truly side-effect-free for Drive ops (B-2 closed)"
    - "tests/scripts/fix-image-pollution-manual.test.ts (5 new tests under 17-06 B-2 dry-run blocks trash)"
  affects:
    - "Phase 17 17-05 manual-triage runs: operator can now confidently smoke-test queues with --dry-run without destroying Drive files"
tech_stack:
  added: []
  patterns:
    - "Defense-in-depth dry-run gating: each destructive helper call wrapped in `if (!deps.args.dryRun) { ... } else { logger.info('would have...') }` — mirrors the Sheets-write pattern from Phase 16"
    - "Trail row co-located inside the gate: DRIVE_DELETE trail row only written when the actual trash happens — matches BR_WRITE gate behavior so trail TSVs stay consistent with reality"
    - "vi.spyOn(logger, 'info') for would-have assertions: test pattern proves observability requirement T-17-22 without coupling to the exact log transport"
key_files:
  created: []
  modified:
    - scripts/fix-image-pollution-manual.ts
    - tests/scripts/fix-image-pollution-manual.test.ts
decisions:
  - "TDD strict order: RED commit (test file additions) FIRST then GREEN commit (script gates). Verified the 2 dry-run tests failed pre-implementation with the expected 'trashDriveFileFn called once' error, then turned green after gating."
  - "Used `vi.spyOn(logger, 'info').mockImplementation(() => undefined)` to silence + capture the would-have-trashed log messages — matches the existing test file's habit of using vi.fn for mocked helpers and avoids polluting test stdout."
  - "Else branch of each gate emits logger.info with rich context (handler name, pid, replacedBy for replace handler) — chose info over warn so operators can grep for 'dry-run: would have' without alarm-fatigue from warn-level."
  - "Did NOT touch the pre-existing BR_WRITE trail rows that ARE written even on dry-run (those rows sit OUTSIDE the BR_WRITE gate at lines 415-425). That's pre-existing Phase 16 scope; the test for dry-run [d]elete reflects this — see Known Stubs / Pre-Existing Quirks below."
metrics:
  duration_minutes: 12
  completed_date: 2026-05-14
  tests_added: 5
  files_modified: 2
  commits: 2
requirements_completed:
  - R17-06
---

# Phase 17 Plan 06: --dry-run Drive-trash gate (B-2) Summary

**Closed the `--dry-run` Drive-trash footgun in `scripts/fix-image-pollution-manual.ts` — both `[d]elete` and `[r]eplace` paths now respect `args.dryRun` and emit `logger.info(dry-run: would have trashed …)` instead of irrecoverably destroying Drive files.**

## What shipped

Two surgical gates around the existing `deps.trashDriveFileFn(...)` call sites — one per choice handler. Mirrors the Sheets-write gate pattern already in use at lines 404 + 741. Each gate also moves the corresponding `DRIVE_DELETE` trail-row append INSIDE the gate, so dry-run trail TSVs never claim a trash happened when it didn't.

### Patch sites (post-patch line numbers — see "Line drift note" below)

| Original (per plan) | Post-patch | Handler | What changed |
|---|---|---|---|
| line 429 | line 434 | delete handler in `handleManualRow` | Wrapped `trashDriveFileFn` + DRIVE_DELETE `appendTrailRowFn` in `if (!deps.args.dryRun)`. Else branch: `logger.info('… dry-run: would have trashed <id> (delete handler, pid=<pid>)')`. |
| line 712 | line 727 | replace handler in `handleReplace`'s compare-before-trash block | Same gate pattern. Else branch includes `replacedBy=<newFileId>` for traceability. |

### Tests added (5 under `describe('17-06 B-2 dry-run blocks trash', ...)`)

1. **dry-run [d]elete**: `trashDriveFileFn` NOT called; `writeUpdatesFn` NOT called; `logger.info` matches `dry-run: would have trashed` with origFileId; no DRIVE_DELETE trail row.
2. **dry-run [r]eplace**: `trashDriveFileFn` NOT called even when `uploadToDriveFn` returns a different fileId; `writeUpdatesFn` NOT called; `logger.info` matches; no DRIVE_DELETE trail row.
3. **live [d]elete regression**: `trashDriveFileFn` called exactly once with origFileId; `writeUpdatesFn` called once; DRIVE_DELETE trail row written.
4. **live [r]eplace regression (fileIds differ)**: trash + BR write + DRIVE_DELETE all fire.
5. **live [r]eplace T-16-01 (same fileId)**: trash NOT called (T-16-01 update-in-place invariant preserved); writeUpdates called once; no DRIVE_DELETE trail row.

## Commits

- `cf4fda1` — `test(17-06-T1): add failing tests for --dry-run Drive-trash gate (B-2)` (RED)
- `c765da1` — `fix(17-06-T1): gate Drive-trash calls behind !args.dryRun (B-2 footgun closed)` (GREEN)

## Verification

```text
npx vitest run tests/scripts/fix-image-pollution-manual.test.ts

Test Files  1 passed (1)
     Tests  26 passed (26)
```

All 21 pre-existing Phase 16 manual-CLI tests still pass; 5 new tests added by this plan pass.

### Acceptance-criteria grep verification

```text
$ grep -cE "if \(!deps\.args\.dryRun\) \{" scripts/fix-image-pollution-manual.ts
4                                            ← 2 pre-existing Sheets gates + 2 new Drive-trash gates ✓

$ grep -nE "dry-run: would have trashed" scripts/fix-image-pollution-manual.ts
453:            …dry-run: would have trashed ${origFileId} (delete handler, pid=${row.pid})
746:        …dry-run: would have trashed ${origFileId} (replace handler, pid=${row.pid}, replacedBy=${newFileIdFromUpload})
                                             ← exactly 2 lines ✓

$ grep -nE "trashDriveFileFn\(" scripts/fix-image-pollution-manual.ts
434:            await deps.trashDriveFileFn(deps.driveClient, origFileId);
727:        await deps.trashDriveFileFn(deps.driveClient, origFileId);
                                             ← exactly 2 call sites, both inside new gates ✓

$ grep -cE "describe\('17-06 B-2 dry-run blocks trash" tests/scripts/fix-image-pollution-manual.test.ts
1                                            ← describe block present ✓
```

## Line drift note

The plan referenced the Phase-16-source line numbers 429 (delete) and 712 (replace). After patching, the actual `trashDriveFileFn(` call sites are at:

- **Line 434** (delete handler) — was at 429 pre-patch; the `if (!deps.args.dryRun) {` wrapper added 5 lines above the call.
- **Line 727** (replace handler) — was at 712 pre-patch; same +15-line shift from the new comment + gate.

The plan's acceptance criteria did not depend on exact line numbers, just on grep matching the two call sites — both still pass.

## Deviations from Plan

None — plan executed exactly as written. TDD gate sequence honored (test commit precedes implementation commit; RED phase verified by running the tests once before the fix and observing 2 expected failures on `dryRun=true` cases).

## Pre-existing quirks (NOT this plan's scope)

1. **BR_WRITE trail row at line 415 is written even in `--dry-run`.** The `appendTrailRowFn({operation:'BR_WRITE', …})` call lives OUTSIDE the Sheets-write gate at line 404. This means in dry-run mode the manual CLI writes a BR_WRITE trail row claiming `new_value: ''` even though no actual sheet mutation happened. The Test 17-06-1 deliberately does not assert "no BR_WRITE trail row" because that would require touching pre-existing Phase 16 scope outside this plan's surface. Flagged here for any future operator audit.

   Behaviorally, this is a *less* destructive quirk than B-2 (a stray trail row vs. a destroyed Drive file), so it can be addressed in a follow-up if operators find it confusing. The DRIVE_DELETE trail row gate added by this plan IS consistent with the actual trash gate, so the trail's claims match reality for Drive ops.

## Threat surface scan

No new network endpoints, auth paths, or schema changes. Net effect of this plan REDUCES surface: fewer Drive trash calls under operator misuse. T-17-21 (Tampering — dry-run data destruction) and T-17-22 (Repudiation — operator can't tell what dry-run would do) both mitigated per the threat-model spec.

## Deferred Issues (pre-existing, out of scope)

Full-suite `npx vitest run` reports 9 pre-existing failing tests in:
- `tests/lib/garment-type-verifier.test.ts`
- `tests/lib/ai-image-generator.test.ts` (6)
- `tests/lib/audit-runner.test.ts` (2)
- `tests/shopify/metaobjects.test.ts` (1)

These are documented in `.planning/phases/17-catalog-image-pollution-fix/deferred-items.md` (added by Plan 17-07) and reproduce on the parent commit `6abcf0d` without any of this plan's changes applied. They touch zero files that 17-06 modifies and are unrelated to B-2.

## TDD Gate Compliance

| Gate | Commit | Status |
|---|---|---|
| RED | `cf4fda1 test(17-06-T1): add failing tests for --dry-run Drive-trash gate (B-2)` | ✓ Test commit precedes implementation |
| GREEN | `c765da1 fix(17-06-T1): gate Drive-trash calls behind !args.dryRun (B-2 footgun closed)` | ✓ Implementation commit follows test commit |
| REFACTOR | n/a — patches were already minimal (1 `if` + 1 `else` per site); no cleanup pass needed | — |

Order verified via `git log --oneline -5` — test commit (`cf4fda1`) appears immediately before fix commit (`c765da1`) in linear history.

## Self-Check: PASSED

Files claimed:
- `scripts/fix-image-pollution-manual.ts` modified — FOUND (1040+ lines, 4 dry-run gates present, 2 would-have-trashed log lines present, 2 trashDriveFileFn call sites present, all inside gates).
- `tests/scripts/fix-image-pollution-manual.test.ts` modified — FOUND (describe block for `17-06 B-2 dry-run blocks trash` present with 5 tests).

Commits claimed:
- `cf4fda1` (RED) — FOUND in git log.
- `c765da1` (GREEN) — FOUND in git log.

Tests claimed:
- All 26 tests in `tests/scripts/fix-image-pollution-manual.test.ts` passing (21 pre-existing + 5 new) — VERIFIED via `npx vitest run`.
