---
phase: 14-imagery-cleanup
plan: 02
subsystem: br-drive-store-reconciliation
tags: [shopify, drive, audit, store-cleanup, cross-pollution, dedupe-sides]

# Dependency graph
requires:
  - plan: 01
    provides: resolveStoreProduct helper + KNOWN_SUPPLIER_PREFIXES allowlist (used by all plan-02 mutation scripts)
provides:
  - tmp/cross-pollution-resolution.tsv with 742 rows classified MOVE/KEEP-WHITELIST/TRASH-ORPHAN (consumed by 14-03 Task 1)
  - tmp/audit-baseline-14-02.txt baseline snapshot (805 issues, 51 pids)
  - scripts/delete-orphan-store-colors.ts one-shot reaper for store-side orphan colors
  - scripts/delete-duplicate-sides.ts dedupe per-color side media on a store product
  - scripts/generate-cross-pollution-tsv.ts BR-aware classifier producing the resolution TSV
  - 60 store media trashed on pid 5000; 43 backfilled
  - 4 dup left-side media trashed on pid 168
affects: [14-03 cross-pollution apply, 14-03 BAD-ALT triage, 14-03 final verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "one-shot pid-targeted store cleanup: resolveStoreProduct → media query → alt-pattern match → productDeleteMedia"
    - "TSV-driven classification: read audit TSV → load BR pid index → classify each row with explainable reason → write reviewable TSV"
    - "default dry-run with --apply gate: every store/Drive mutation script defaults to logging-only; no flag = no writes"

key-files:
  created:
    - scripts/delete-orphan-store-colors.ts
    - scripts/delete-duplicate-sides.ts
    - scripts/generate-cross-pollution-tsv.ts
    - tmp/audit-baseline-14-02.txt
    - tmp/cross-pollution-resolution.tsv
  modified: []

key-decisions:
  - "Task 3 deviation: pid 168 had EXCESS side media (3 sides, expected 2) not MISSING — fix-store-drift was the wrong tool. Wrote delete-duplicate-sides.ts instead and kept newest by Shopify CDN ?v= timestamp."
  - "TSV is review-only — plan-02 produces the artifact; plan-03 applies it. Avoids destructive Drive mutations without an inspection pass."
  - "KEEP-WHITELIST suggestions name the brand explicitly (BELLA, Richardson, Next_Level, etc.) so the audit allowlist entry is reviewable."
  - "Orphan delete uses regex `<color> (front|back|left side|right side|side)$` — same alt convention drop-br-colors.ts established, but the new script targets store-only-cleanup (no BR touch)."

requirements-completed:
  - R1.5000-recon
  - R3.cross-sweep
  - R5.168-cross

# Metrics
duration: ~25min execution + ~10min audit re-runs
completed: 2026-05-08
---

# Phase 14 Plan 02: BR-Drive-Store Reconciliation Summary

**60 orphan-color store media reaped on pid 5000 + 43 drift backfilled; 4 duplicate left-side media reaped on pid 168; 742 cross-pollution rows classified into a reviewable resolution TSV.**

## Performance

- **Duration:** ~25 min execution across 4 tasks (plus ~10 min for full-audit re-runs)
- **Started:** 2026-05-08T14:04Z (Task 1 baseline)
- **Completed:** 2026-05-08T15:47Z (Task 4 commit)
- **Tasks:** 4 — all completed; Task 3 included a plan deviation (see below)
- **Files created:** 3 source scripts + 2 tmp artifacts

## Accomplishments

- Pid 5000 audit: **0 issues** (was 15 STORE-EXTRA-COLOR + 33 STORE-DRIFT in baseline). Live store product `unisex-heavy-cotton-t-shirt-5000` reaped of 60 media (15 colors × 4 views) and backfilled with 43 missing media.
- Pid 168 audit: **0 issues** (was 4 STORE-DRIFT + 0 CROSS-POLLUTION after 14-01 allowlist). 4 duplicate left-side media trashed; newer copy retained per CDN `?v=` timestamp.
- 742 CROSS-POLLUTION rows classified: **551 KEEP-WHITELIST** (6 brands), **172 TRASH-ORPHAN**, **19 MOVE-TO-{pid}**. TSV checked in for plan 14-03 to apply.
- Phase-wide audit delta: 805 → 761 issues. STORE-EXTRA-COLOR cleared (15 → 0); STORE-DRIFT 37 → 1; CROSS-POLLUTION 742 unchanged (intentional — that's plan 14-03 scope).

## Task Commits

1. **Task 1: Refresh audit baseline** — `5113aad` (chore)
2. **Task 2: Delete 15 orphan store colors on pid 5000 + drift backfill** — `a4edc88` (feat)
3. **Task 3: Dedupe duplicate left-side media on pid 168 (deviation)** — `e1f5f36` (feat)
4. **Task 4: Generate cross-pollution resolution TSV (742 rows)** — `f9ce0d6` (feat)

## Files Created

- `scripts/delete-orphan-store-colors.ts` — Reaps store-side orphan-color media for a fixed pid + color list. Default dry-run; `--apply` mutates.
- `scripts/delete-duplicate-sides.ts` — Per-color side dedupe on a store product. Keeps newest by Shopify CDN `?v=` timestamp.
- `scripts/generate-cross-pollution-tsv.ts` — Classifies CROSS-POLLUTION audit rows by trying every BR pid against `fileBelongsToPid`-style predicate, then brand-prefix detection.
- `tmp/audit-baseline-14-02.txt` — Pre-mutation baseline snapshot (805 issues, 51 pids, per-check counts).
- `tmp/cross-pollution-resolution.tsv` — 742 rows with `pid | filename | suggested_action | reason` columns. Action distribution: 551 KEEP-WHITELIST, 172 TRASH-ORPHAN, 19 MOVE-TO.

## Decisions Made

- **Plan vs reality on pid 168 (Task 3 deviation):** Plan said run `fix-store-drift --pids 168` expecting ~30+ media attached. Actual state: each of 4 colors had TWO `left side` media (uploaded ~23h apart), not missing media. Drift fix is purely additive — wrong tool. Wrote `delete-duplicate-sides.ts` instead, which groups (color, view) and keeps the newest. 4 deletions, 0 errors.
- **TSV classification heuristic priority:** (1) MOVE-TO-X if filename's pid signature matches another BR pid via raw or numeric prefix; (2) KEEP-WHITELIST-{brand} if filename starts with `Brand_<parentPidNum>_*`; (3) TRASH-ORPHAN otherwise. Avoids force-trashing supplier-branded files that audit just doesn't recognize yet.
- **Brand-prefix regex (`extractBrandPrefix`):** `^([A-Za-z]+(?:_(?:\+_)?[A-Za-z]+)*)[_-](\d+)[_-]` — handles `BELLA_+_CANVAS_6110_*`, `Richardson_168_*`, `Next_Level_3911_*`, `Comfort_Colors_*`, `Gildan_*`, `American_Apparel_*`. Rejects single-letter prefixes.
- **Two store-cleanup scripts not one:** `delete-orphan-store-colors.ts` (color-list driven) and `delete-duplicate-sides.ts` (per-color dedup) solve different problems; combining would have hurt the dry-run review story.

## Deviations from Plan

### Plan-Acknowledged Deviation

**1. [Task 3] Plan tool didn't match reality**
- **Plan said:** Run `fix-store-drift --pids 168`; expected ~30+ media attached.
- **Reality:** Pid 168 had **excess** side media (3 sides per color where 2 expected), not missing. Drift fix is additive only.
- **Fix:** Wrote `scripts/delete-duplicate-sides.ts` (~140 lines) — groups by (color, view), keeps newest by `?v=` timestamp, trashes the rest. 4 trash candidates exactly matched the 4 STORE-DRIFT rows.
- **User-checkpoint:** Surfaced 3 options; user picked "delete the older duplicate per color".
- **Verification:** Audit on pid 168 dropped from 4 STORE-DRIFT → 0 issues. No regression on CROSS-POLLUTION (already 0 from 14-01 allowlist).
- **Committed in:** `e1f5f36`

### Auto-fixed Issues

**2. In-script bucket display regex was buggy**
- **Found during:** Task 4 first run.
- **Issue:** Bucket grouping `replace(/-[\w-,…]+$/, '')` failed on `KEEP-WHITELIST-BELLA_+_CANVAS` because `+` isn't in `\w`. Display showed full string instead of `KEEP-WHITELIST` group.
- **Fix:** Replaced regex with explicit `startsWith` checks for `MOVE-TO-`, `MOVE-AMBIGUOUS`, `KEEP-WHITELIST-`. TSV content was always correct; only the in-script summary log was misleading.
- **Verification:** Re-run shows `551 KEEP-WHITELIST / 172 TRASH-ORPHAN / 19 MOVE-TO` — matches manual `awk` count.
- **Committed in:** `f9ce0d6` (fix bundled with the script that introduced it)

---

**Total deviations:** 1 plan-deviation (Task 3 tool mismatch), 1 auto-fixed display bug.
**Impact:** No scope creep. The plan's intent — "pid 168 audit fully clean" — was met; only the tool changed.

## Issues Encountered

- **`tmp/imagery-audit.tsv` overwritten by narrow audits:** Task 2/3 verification used `--pids X` which truncates the TSV to that pid only. Had to re-run full audit before Task 4 (which reads from the TSV). Cost: ~5 min wall time. Possible follow-up: add `--write-narrow-tsv` flag or write to a separate path on narrow runs. Logged in deferred-items.md.
- **9 DUPE-DRIVE leftovers from 14-01:** Untouched in this plan (out of scope). Still tracked in `tmp/dedupe-leftovers.tsv`.
- **MODEL-MISSING-ON-STORE: 7 rows surfaced** in the post-task-2 full audit — different category from anything plan-02 touched. Likely needs its own remediation in 14-03 or a future phase. Logged in deferred-items.md.

## Known Stubs

None — all 3 source scripts wire into real call sites and have run live. No placeholder data.

## User Setup Required

- Continue using `NODE_OPTIONS=--use-system-ca` for any imagery script that hits Google Drive on Node v24 (carryover from 14-01).
- No new env vars or service config.

## Self-Check

- [x] `scripts/delete-orphan-store-colors.ts` exists; ran dry-run + apply with 60/60 deleted, 0 errors
- [x] `scripts/delete-duplicate-sides.ts` exists; ran dry-run + apply with 4/4 deleted, 0 errors
- [x] `scripts/generate-cross-pollution-tsv.ts` exists; produced 742-row TSV with 3 action types
- [x] `tmp/audit-baseline-14-02.txt` exists with timestamp + per-check counts
- [x] `tmp/cross-pollution-resolution.tsv` exists with header `pid\tfilename\tsuggested_action\treason` and 742 data rows
- [x] Pid 5000 narrow audit: 0 issues
- [x] Pid 168 narrow audit: 0 issues
- [x] All 4 task commits exist in git log (`5113aad`, `a4edc88`, `e1f5f36`, `f9ce0d6`)
- [x] `npx tsc --noEmit -p tsconfig.json` shows zero errors in plan-modified files

## Self-Check: PASSED

## Next Phase Readiness

- **14-03 Task 1 (apply cross-pollution TSV)** unblocked — `tmp/cross-pollution-resolution.tsv` ready for consumption. Expected mutations: 19 Drive moves + 172 Drive trashes + 551 KEEP-WHITELIST allowlist entries.
- **14-03 Task 2 (BAD-ALT triage on L01210/L01250)** unblocked — only 2 BAD-ALT rows remain in fresh audit (count 13 in plan was stale; current is 2 per latest audit Summary).
- **14-03 Task 3 (VERIFICATION.md)** unblocked — baseline + per-task deltas captured; final pass just needs a clean audit run.

---
*Phase: 14-imagery-cleanup*
*Completed: 2026-05-08*
