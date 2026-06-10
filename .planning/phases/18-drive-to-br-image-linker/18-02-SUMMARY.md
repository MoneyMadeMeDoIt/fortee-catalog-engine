---
phase: 18-drive-to-br-image-linker
plan: "02"
subsystem: image-linker
tags: [drive, image-linker, sheets, column-add, idempotent, dry-run, tdd]
dependency_graph:
  requires: [parseCanonicalFilename, normalizeColor, ROLE_TO_COLUMN, CANONICAL_ROLES (18-01)]
  provides: [buildPlan, urlForFileId, DiffRow, MissRow, PlanStats, main (scripts/link-br-images.ts)]
  affects: [18-03 (live --apply + render check)]
tech_stack:
  added: []
  patterns: [DI-pure-core, raw-values-get-anti-pattern1, live-header-reread, drive-retry-with-timeout, diff-miss-backup-tsv]
key_files:
  created:
    - scripts/link-br-images.ts
    - tests/scripts/link-br-images.test.ts
  modified: []
decisions:
  - "buildPlan is pure and fully DI'd (driveIndex + urlForFileId injected) — no network in tests"
  - "urlForFileId produces uc?id= form — consistent with uploadToDrive and write-model-urls.ts"
  - "Local withLocalDriveRetry mirrors isTimeoutError from drive.ts (withDriveRetry not exported)"
  - "Raw values.get used for data read — readAllRows excluded (Anti-Pattern 1: drops new columns)"
  - "D-06 live header re-read implemented: re-read after appendDimension before computing indices"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-10"
  tasks_completed: 2
  files_created: 2
---

# Phase 18 Plan 02: Drive→BR Image Linker Summary

Deterministic Drive→BR image linker entry point (`scripts/link-br-images.ts`) — dry-run-safe, idempotent, never-blank, with a full unit test suite for the pure plan-builder core.

## What Was Built

### `scripts/link-br-images.ts`

New deterministic entry point (link-drive-images.ts untouched).

**Exported pure core:**

- `buildPlan(args: BuildPlanArgs): PlanResult` — joins Drive index to BR rows by (pid, normColor), emits `EnrichmentUpdate[]` + `DiffRow[]` + `MissRow[]` + `PlanStats`. Implements:
  - IMG-01/D-02..D-05: overwrite all 7 image columns per matched (pid,color) pair
  - D-08 never-blank: no update emitted when no Drive file exists; miss logged only if cell was populated
  - D-11/OPS-02 idempotency: delta-only — cells already at canonical URL skipped
  - P5 row-1 guard: sheetRow = ri+2, assertion throws on sheetRow < 2
  - P13 PlanStats: written_new, overwritten_changed, skipped_already_current, misses, skipped_no_pid

- `urlForFileId(fileId): string` — canonical `https://drive.google.com/uc?id=<fileId>` form; consistent with uploadToDrive (drive.ts:279) and write-model-urls.ts:181

**I/O wiring (main):**

- CLI: default dry-run; `--apply` enables writes; `--supplier <CODE>` filter; `--supplier __NONE__` smoke-test path
- Drive scan: `createDriveClient()`, listSubfolders for supplier→pid hierarchy, paginated `files.list` per pid folder, `parseCanonicalFilename` for each file, dedup first-seen with collision log
- Local `withLocalDriveRetry` + `{ timeout: 30000 }` (T-18-06) — mirrors isTimeoutError from drive.ts (withDriveRetry not exported)
- Header + columns (OPS-03/D-06): `values.get` `'Bestsellers-Ready'!1:1`; on `--apply`, appendDimension for absent new columns, write headers, **RE-READ live header**, recompute all indices
- Data read: raw `values.get` on full tab (NOT `readAllRows` — Anti-Pattern 1)
- Outputs: always emits `tmp/link-br-images-plan-<ts>.tsv` (diff) + `tmp/link-br-images-misses-<ts>.tsv`; dry-run stops here
- `--apply`: writes `tmp/br-image-backup-<ts>.tsv` BEFORE any sheet write (D-10), then `writeUpdates(sheets, MAIN_ID, plan.updates)`

### `tests/scripts/link-br-images.test.ts`

9 test cases, all DI'd (in-memory driveIndex + urlForFileId):

1. Fresh fill — empty cell → update + diff
2. Overwrite — different existing URL → update + diff
3. Idempotent skip — identical URL → zero updates, skipped_already_current++
4. Idempotent re-run — second pass on same inputs → zero updates
5. Never-blank miss — no Drive file, populated cell → miss, no update
6. Never-blank empty — no Drive file, empty cell → no miss, no update
7. Row-1 guard — ri=0 → range ends in '2', not '1'
8. Skip no-pid — empty productId → skipped_no_pid++
9. Range format — tab name and sheetRow encoded correctly

## Test Results

```
✓ tests/scripts/link-br-images.test.ts (9 tests) 5ms
✓ tests/scripts/br-image-parser.test.ts (29 tests) 8ms
Test Files  2 passed (2)
Tests       38 passed (38)
Duration    1.53s
```

## TDD Gate Compliance

- RED commit `f052d78`: `test(18-02): add failing buildPlan unit tests (RED)` — confirmed failing with "Cannot find module" before implementation
- GREEN commit `5d5ba07`: `feat(18-02): implement buildPlan + link-br-images.ts entry point (GREEN)` — all 9 tests pass

## Dry-Run Output (smoke test)

```
=== link-br-images [DRY RUN] ===
Supplier filter: __NONE__ (empty smoke-test run)
[drive] Empty smoke-test run — skipping Drive enumeration
[sheets] Reading header row...
[sheets] Header row: 43 column(s)
[dry-run] NOTE: 4 new column(s) not yet in sheet (will be added on --apply): RightSide, ModelFront, ModelSide, ModelBack
[sheets] Reading all data rows...
[sheets] Data rows: 24175
[plan] Building write plan...
[output] Diff TSV:  tmp/link-br-images-plan-<ts>.tsv
[output] Miss TSV:  tmp/link-br-images-misses-<ts>.tsv
=== Plan Stats ===
  written_new           : 0
  overwritten_changed   : 0
  skipped_already_current: 0
  misses                : 71278
  skipped_no_pid        : 1
  total updates planned : 0
[DRY RUN] No writes to sheet. Pass --apply to execute.
```

With `__NONE__` supplier: driveIndex is empty; all 71,278 populated image cells appear as misses (expected — no Drive files indexed). Zero sheet writes.

## Verification Checks

- `parseCanonicalFilename` imported from `br-image-parser` and used in scanPidFolder
- `classifyImage` not present anywhere in `scripts/link-br-images.ts`
- `readAllRows` not used for data read (comment-only reference, raw `values.get` used)
- No hard-coded column letters for the 4 new columns — all indices from header-index map
- D-06 live header re-read: implemented in `--apply` path after `appendDimension`
- tsc --noEmit: new files have zero type errors (pre-existing errors in other files only)

## Deviations from Plan

None — plan executed exactly as written.

The plan verification command (`npx tsc --noEmit && npx tsx scripts/link-br-images.ts --dry-run --supplier __NONE__`) required `NODE_OPTIONS=--use-system-ca` prefix for Google API auth (AV TLS interception on this machine — documented in project memory `feedback_node_use_system_ca.md`). This is a machine-level env requirement, not a code deviation.

## Known Stubs

None — the live --apply path is complete code (not stubbed); it is gated behind the `--apply` CLI flag per plan. The 18-03 checkpoint gates the actual live-sheet apply run.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced beyond what the plan specified. The 7 BR image columns are the intended write surface (already in the STRIDE threat register as T-18-03..T-18-07).

## Self-Check: PASSED

- `scripts/link-br-images.ts` exists (660 lines, > 150 minimum)
- `tests/scripts/link-br-images.test.ts` exists (295 lines, > 60 minimum)
- RED commit `f052d78` confirmed in git log
- GREEN commit `5d5ba07` confirmed in git log
- 9/9 tests pass; 38/38 total across both suites
- Dry-run produced `tmp/link-br-images-plan-*.tsv` and `tmp/link-br-images-misses-*.tsv`
- Zero sheet mutations (dry-run)
- `parseCanonicalFilename` imported; `classifyImage` absent; `readAllRows` absent
