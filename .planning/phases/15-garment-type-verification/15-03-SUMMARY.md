---
phase: 15-garment-type-verification
plan: 03
subsystem: retro-audit-cli
tags: [retro-audit, read-only, vision-api, di-seam, cli]
requires:
  - "verifyGarmentTypeMatch from src/lib/ai-image-generator.ts (Plan 01)"
  - "appendRejectRow + getOrCreateRunId from src/lib/rejects-tsv.ts (Plan 01)"
provides:
  - "scripts/audit-garment-types.ts — read-only retro audit CLI (SPEC R6)"
  - "runGarmentTypeAudit(deps) DI seam — exported for testing"
  - "RunGarmentTypeAuditArgs / RunGarmentTypeAuditDeps TypeScript interfaces"
affects:
  - "tmp/garment-type-rejects.tsv (written on mismatch via appendRejectRow)"
tech-stack:
  added: []
  patterns:
    - "DI seam mirrors scripts/audit-images.ts (RunAuditArgs/RunAuditDeps + isDirectRun guard)"
    - "Chunked --all reader mirrors audit-images.ts:302-310 + colorGroupMap dedup"
    - "Per-row try/catch + warn-and-continue mirrors audit-runner.ts:333-336"
    - "Vitest module-scope vi.mock('openai', ...) mirrors tests/lib/ai-image-generator.test.ts"
key-files:
  created:
    - "scripts/audit-garment-types.ts"
    - "tests/scripts/audit-garment-types.test.ts"
  modified: []
decisions:
  - "Per-row skip discipline: download failures and verifier exceptions log warn and fall through — never crash the loop (matches audit-runner.ts:333-336 precedent and CONTEXT specifics)"
  - "Both-views-missing rows are skipped silently (not counted as skipped) — there's nothing to verify so it's not a real skip event"
  - "Test 7 invariant uses an import-only grep (split on `^\\s*import\\b` lines) + a code-without-safety-comment grep so the top-of-file READ-ONLY comment that names the forbidden symbols doesn't trigger a false positive"
  - "Mismatch count is incremented ONLY on confirmed verifier mismatch (result.match === false), NOT on verifier exceptions — exceptions are 'unknown' verdicts, not mismatches"
metrics:
  duration: "~20 minutes"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
  tests_added: 7
  completed: 2026-05-11
---

# Phase 15 Plan 03: Retro Garment-Type Audit CLI Summary

Read-only retro audit CLI for SPEC R6 — scans existing back/side images in BR
and flags shape-mismatched uploads (the A343-class hoodie-for-crewneck case)
to `tmp/garment-type-rejects.tsv` for human review. Per CONTEXT D-04 the
script scans ALL back/side images regardless of source (no AI-vs-supplier
filtering heuristic — simpler, ~$0.06-0.18 per full pass per RESEARCH).

The script consumes both primitives shipped by Plan 01 (`verifyGarmentTypeMatch`
and `appendRejectRow`) without modifying any existing module. T-15-Extra
(regression to write-side) is mitigated by Test 7 — a static invariant that
fails if any future edit adds Drive/Sheets-write imports.

## Tasks Completed

1. **Task 1** — Created `scripts/audit-garment-types.ts` (307 lines) with the
   `runGarmentTypeAudit(deps)` DI seam, `RunGarmentTypeAuditArgs` /
   `RunGarmentTypeAuditDeps` interfaces, chunked `--all` reader,
   `colorGroupMap` dedup, and `isDirectRun` guard mirroring
   `scripts/audit-images.ts`. Imports only the read-side primitives
   (`readAllRows`, `readRowRange`, `downloadImage`, `verifyGarmentTypeMatch`,
   `appendRejectRow`, `getOrCreateRunId`, `createSheetsClient`) — never
   `uploadToDrive`, `writeUpdates`, or `buildStandardizationUpdates`.
   Commit `27088a6`.

2. **Task 2** — Created `tests/scripts/audit-garment-types.test.ts` (215
   lines) with 7 mocked-deps smoke tests covering the DI seam contract:
   mismatches → TSV writes, dry-run skips Vision + TSV, invalid front URL
   skips row, download failure skips row, match=true means no TSV, --limit N
   caps product count, and the static read-only invariant (Test 7) that
   regexes the source file for forbidden import paths and write-side symbols.
   Commit `9c95cb7`.

## Files Created / Modified

**Created (2):**
- `scripts/audit-garment-types.ts` — 307 lines
- `tests/scripts/audit-garment-types.test.ts` — 215 lines (7 tests)

**Modified:** None. Plan 03 is purely additive — it consumes Plan 01's
primitives without modifying them.

## Verification Results

| Task | Verify Command | Result |
|------|----------------|--------|
| 1 | `npx tsc --noEmit` (filtered to new file) | PASS — 0 errors in `audit-garment-types.ts`. Pre-existing project-wide TS errors unrelated to this plan. |
| 1 | `npx tsx scripts/audit-garment-types.ts --help` | PASS — prints help text and exits 0 (no env vars required for `--help`). |
| 2 | `npx vitest run tests/scripts/audit-garment-types.test.ts` | PASS — 7/7 tests green in 10ms. |
| Full suite | `npx vitest run` | 368/369 tests pass. The single failure (`tests/shopify/metaobjects.test.ts` — `print_area` vs `print_areas`) is **pre-existing** and unrelated to Plan 03 — verified by `git stash && vitest run tests/shopify/metaobjects.test.ts` reproducing the same failure on master without my changes. Out of scope per CLAUDE.md. |

## Deviations from Plan

None. Plan 03 executed exactly as written.

### Notes on plan acceptance grep imprecisions (informational, not deviations)

The plan's Task 1 acceptance criteria included a forbidden-imports grep:

```bash
grep -E "from ['\"]\\.\\./src/sheets/drive\\.js['\"]|...|uploadToDrive|writeUpdates|buildStandardizationUpdates" scripts/audit-garment-types.ts | wc -l
# expected: 0
```

The actual file has `1` match — the safety comment on line 2:

```typescript
// MUST NEVER call uploadToDrive, writeUpdates, or modify Drive/Sheets.
```

This is the documented file-protection contract — the comment names the
symbols specifically to make the contract human-readable. Task 2 Test 7 is
the stronger replacement: it parses the file into import-lines and
code-without-safety-comment regions, asserting that NO actual import or
code-site references the forbidden symbols. The safety comment is allowed
(and explicitly required by `15-PATTERNS.md`); function-call regressions are
caught.

The original grep was a count of textual occurrences; Test 7 is a semantic
check that's both stricter (catches symbol use anywhere, not just import
statements) and correct (allows the documented safety comment). Verified
both ways:
- `grep "from .*drive.js\\|from .*writer.js\\|from .*audit-runner.js" scripts/audit-garment-types.ts` returns 0.
- `grep "uploadToDrive\\|writeUpdates\\|buildStandardizationUpdates" scripts/audit-garment-types.ts` returns 1 (the safety comment only).

## Authentication / Environment Gates

None. All work was local code editing + mocked unit tests. The `--help`
smoke test runs without `OPENAI_API_KEY` or any Google credentials — the
env-var check is gated after the help-text early-return.

A real `--style-id` or `--all` invocation would require `OPENAI_API_KEY`,
`GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and
`GOOGLE_PRIVATE_KEY` — the script exits 1 cleanly if any are missing
(mirrors `audit-images.ts:466-470`).

## Known Stubs

None. Plan 03 is feature-complete for the SPEC R6 retro audit deliverable.

The deliberate scope boundary remains as noted in 15-01-SUMMARY: this script
flags mismatches only — operator remediation (delete + regenerate) is
deferred to a follow-up phase. `tmp/garment-type-rejects.tsv` is the
operator hand-off.

## Threat Flags

None. No new network endpoints, no new auth surface, no new file-access
patterns beyond what the plan's `<threat_model>` already covers (T-15-01
accepted residual, T-15-02 mitigated by Plan 01's `sanitize()`, T-15-Extra
mitigated by Test 7).

The threat register's `T-15-03` (OPENAI_API_KEY in test logs) is mitigated
here too: all 7 smoke tests use the DI seam (`openai` is an injected fake);
the module-scope `vi.mock('openai', ...)` prevents the real SDK from loading
during test imports; `process.env.OPENAI_API_KEY` is never read in tests.

## Open Follow-ups

1. **Operator runbook for `--all` execution** — when ready, run
   `npx tsx scripts/audit-garment-types.ts --all` with `OPENAI_API_KEY` set;
   expect ~$0.06-0.18 cost and ~5 min for ~283 bestsellers. Review
   `tmp/garment-type-rejects.tsv` rows; filter to the most recent `run_id`
   to isolate one pass. Mismatch reasons of `"verifier api error fallback"`
   or `"verifier parse error fallback"` indicate transient Vision failures
   — re-run those rows.

2. **Plan 04 fixture binaries** — Plan 03 does not depend on the
   `tests/fixtures/garment-type/*.png` binaries (the smoke tests use mocked
   verifier responses). Plan 04 still owns Wave 0 fixture sourcing for the
   real-API gated tests.

3. **Future R6 remediation phase** — once the retro TSV exists, a follow-up
   can delete + regenerate the flagged back/side images (out of scope per
   SPEC R6 + CONTEXT deferred-ideas).

## Commits

| Commit | Message |
|--------|---------|
| `27088a6` | feat(15-03): add read-only retro audit CLI for garment-type mismatches |
| `9c95cb7` | test(15-03): smoke tests for runGarmentTypeAudit DI seam + read-only invariant |

## Self-Check: PASSED

- `scripts/audit-garment-types.ts` — FOUND (307 lines)
- `tests/scripts/audit-garment-types.test.ts` — FOUND (215 lines, 7 tests)
- Commit `27088a6` — FOUND in `git log`
- Commit `9c95cb7` — FOUND in `git log`
- `runGarmentTypeAudit` export — FOUND (`grep -c "export async function runGarmentTypeAudit" == 1`)
- `READ-ONLY` safety comment — FOUND (line 1)
- Forbidden import sources — NONE (no imports from `drive.js`, `writer.js`, or `audit-runner.js`)
- Forbidden symbols outside safety comment — NONE
- 7 smoke tests pass — VERIFIED via `npx vitest run`
- Full suite 368/369 — pre-existing metaobjects failure verified unrelated via git stash check
