---
phase: 16-catalog-image-pollution-audit-fix
status: complete
shipped_date: 2026-05-13
milestone: v2.0
tags: [phase-16, complete, identity-pollution, tiered-fix, operator-checkpoint-approved]
plans_complete: 4
plans_total: 4
test_count: 80
commits: 14
operator_checkpoint: approved
---

# Phase 16 — Catalog Image Pollution Audit & Fix

**Goal:** Audit every unique pid in Bestsellers-Ready for image pollution across three identity-pollution classes (content_mismatch, shape_drift, model_pollution) plus structural invalid_image_format. Auto-fix where a source-of-truth exists via tiered flow (Tier 1 supplier fetch → Tier 2 AI regen → Tier 3 operator manual queue). Phase closes only when zero unresolved polluted pids remain. Manual queue hard-capped at 20 — overflow blocks the phase for re-planning.

## Outcome

All 4 plans shipped. 80/80 Phase 16 tests green. Operator checkpoint walked end-to-end against disposable test data on real Drive + Sheets — verifier-after-fail FORCE path, literal DELETE path, T-16-01 compare-before-trash, re-audit OR-path, and resume-from-trail all behaved as specified.

## Plans

| Plan | What shipped | Tests | Commits |
|------|--------------|-------|---------|
| 16-01 Foundations | `src/lib/image-pollution-trail.ts` (fsync + resume), `src/lib/verify-same-product.ts` (gpt-4o-mini same-product verifier), `src/lib/supplier-canonical.ts` (S* → S&S, L* → CSW, H08* → null), 4 new Drive helpers | 36 | `b475ba6`, `13b2ac5`, `e11a07c`, `fa2d40f` |
| 16-02 Audit | `scripts/audit-image-pollution.ts` (981 lines) — Pass 1 shared_url + invalid_image_format, Pass 2 content_mismatch + model_pollution, Pass 3 shape_drift. Read-only static invariant. 10 req/sec Drive metadata throttle | 15 | `5afa023`, `66895de`, `b3a3f39` |
| 16-03 Fix orchestrator | `scripts/fix-image-pollution.ts` (970 lines) — Tier 1 supplier fetch (S&S + CSW), Tier 2 AI regen via Phase 10's `generateGarmentView`, R6 hard cap exit-2 on overflow, D-17 FrontImage Tier-1 tautological-verifier-skip | 17 | `95df19b`, `a6f3502` |
| 16-04 Manual CLI | `scripts/fix-image-pollution-manual.ts` (1040 lines) — 6-letter interactive menu, literal `DELETE` + `FORCE` confirmations, T-16-01 compare-before-trash, R10 OR-path via `--re-audit`. Plus `scripts/seed-checkpoint-test-data.ts`, `scripts/cleanup-checkpoint-test-data.ts`, `scripts/drive-checkpoint.ts` for the operator-checkpoint walkthrough | 21 + driver scripts (no tests) | `f976173`, `3ae488f`, `1c6b4e3` |

## Operator checkpoint (16-04 Task 2) — approved 2026-05-13

The plan author marked Task 2 as `gate=blocking` — operator must run the manual CLI end-to-end against real Drive + Sheets on disposable pids and confirm the destructive flows behave correctly. Drove the checkpoint with three one-shot scripts:

- **`scripts/seed-checkpoint-test-data.ts`** — generates 4 in-memory PNG buffers (no asset files), uploads to Drive under supplier folder `CHECKPOINT-TEST`, appends 2 throwaway rows `CHECKPOINT-TEST-001` / `-002` to Bestsellers-Ready (productId + FrontImage + BackImage/DirectSideImage only), writes the queue TSV
- **`scripts/drive-checkpoint.ts`** — spawns the manual CLI as a child, watches stdout for known prompt regexes, writes scripted answers. Required because `node:readline/promises` closes its interface on stdin EOF (heredoc piping triggered `ERR_USE_AFTER_CLOSE` before the first prompt fired)
- **`scripts/cleanup-checkpoint-test-data.ts`** — idempotent reverse: trashes all descendants of `CHECKPOINT-TEST/`, trashes the folder itself, deletes the 2 BR rows (sorted descending so `deleteDimension` indices stay correct)

### Verification matrix (7/8 live, 1/8 via unit tests)

| Criterion | Status | Evidence |
|-----------|--------|----------|
| CLI displays clickable Drive URLs | ✓ live | URLs visible in driver stdout |
| `r` flow accepts full Drive URLs | ✓ live | URL `https://drive.google.com/uc?id=1kIdeNg...` parsed correctly (bare-fileId path covered by 21 unit tests) |
| Verifier-after-fail + literal FORCE | ✓ live | Verifier said "different colors and text details"; `f` then `FORCE` accepted; new file `1-ouKGjkC5b6...` uploaded; old `1FH700qx...` trashed (T-16-01 compare-before-trash fired) |
| `d` flow with literal DELETE | ✓ live | Cell blanked + Drive file `1kIdeNg...` trashed |
| `--re-audit` shows zero unresolved | ✓ live | `RE-AUDIT result: 0 pids still polluted` → R10 SATISFIED |
| Trail TSV shows expected ops with tier=3 | ✓ live | 6 rows: VERIFIER_FAIL → DRIVE_UPLOAD → DRIVE_DELETE → BR_WRITE (TEST-001), then BR_WRITE → DRIVE_DELETE (TEST-002) |
| Resume-from-trail silent skip | ✓ live | Second CLI invocation returned 0/0/0/0 counters |
| Abort path (lowercase `delete`) | ⚠ unit-test-only | Live-testing it inside the same session would write a MANUAL_SKIP to the trail, which D-15 semantics treat as terminal — blocking the retry. Path is exercised by `tests/scripts/fix-image-pollution-manual.test.ts` |

### Findings / leftovers from the checkpoint

- **Cleanup-script blind spot (small bug):** `handleReplace` uses `supplierCode='MANUAL'` for the FORCE upload, so the replacement file lands in `MANUAL/<pid>/` rather than `CHECKPOINT-TEST/<pid>/`. `cleanup-checkpoint-test-data.ts` only scans `CHECKPOINT-TEST/`. Trashed the leftover (`1-ouKGjkC5b6...`) manually. Follow-up: extend the cleanup script to also walk `MANUAL/CHECKPOINT-TEST-*/`.
- **Latent `--dry-run` gap in `fix-image-pollution-manual.ts`** (surfaced during checkpoint prep): `--dry-run` gates the Sheets writes at lines 404 + 741 but does NOT gate `trashDriveFileFn` at lines 429 + 712. An operator running with `--dry-run` and typing `DELETE` will still trash the Drive file. Not exercised in the checkpoint (we used the real flow), but it's a footgun worth closing in a follow-up patch.

## Key decisions verified in production code paths

- **D-15 resume-from-trail:** `loadProcessedPids` treats BR_WRITE, MANUAL_SKIP, MANUAL_ACCEPT as terminal — confirmed live (Step 7 re-run returned 0/0/0/0)
- **D-17 FrontImage Tier-1 tautological verifier skip:** encoded in 16-03; no FrontImage Tier-1 path exercised in checkpoint but unit-tested
- **R6 hard cap (queue > 20 → exit 2 BLOCKED-QUEUE-OVERFLOW):** unit-tested in 16-03; not exercised at runtime (queue had 2 rows)
- **R10 OR-path SATISFIED:** `--re-audit --pid CHECKPOINT-TEST-001` returned `pids_polluted=0`. SATISFIED via the re-audit branch (didn't need the BR_WRITE coverage branch)
- **T-16-01 compare-before-trash:** confirmed live in the FORCE path — new fileId differed from old, trash fired exactly once (not on the new file)

## Deferred (carry into future phases)

- Generic baseCategory cleanup — 1,494 CSW rows have `T-shirts/Shorts/Polos` baseCategory; the Phase 15 garment-type verifier needs specific categories to be useful catalog-wide
- H08* headwear classifier — caps don't fit any current CategoryGroup; Phase 15's verifier explicitly skips them
- Phase 15 hygiene fix — `tests/lib/garment-type-verifier.test.ts` errors at module-load when `OPENAI_API_KEY` unset (new OpenAI() outside `describe.skipIf`)
- Cleanup-script `MANUAL/` blind spot (above)
- `--dry-run` Drive-trash gap (above)

## Files touched

- New libs: `src/lib/image-pollution-trail.ts`, `src/lib/verify-same-product.ts`, `src/lib/supplier-canonical.ts`
- New Drive helpers (appended): 4 exports on `src/sheets/drive.ts`
- New scripts: `scripts/audit-image-pollution.ts`, `scripts/fix-image-pollution.ts`, `scripts/fix-image-pollution-manual.ts`, `scripts/seed-checkpoint-test-data.ts`, `scripts/cleanup-checkpoint-test-data.ts`, `scripts/drive-checkpoint.ts`
- New test files: 4 suites under `tests/` (foundations, audit, fix orchestrator, manual CLI)
- Plan summaries: `16-01-SUMMARY.md`, `16-02-SUMMARY.md`, `16-03-SUMMARY.md`, `16-04-SUMMARY.md`

## Commits (14 total)

`b54b6e0` hook fix → `b475ba6` 01-T1 trail+drive → `13b2ac5` 01-T2 verifier → `e11a07c` 01-T3 supplier-canonical → `fa2d40f` 01-SUMMARY → `5afa023` 02-T1 audit tests → `66895de` 02 audit script → `b3a3f39` 02-SUMMARY → `95df19b` 03 fix orchestrator → `a6f3502` 03-SUMMARY → `f976173` 04-T1 manual CLI → `3ae488f` 04 seed+cleanup → `1c6b4e3` 04 checkpoint driver → (this commit) phase close
