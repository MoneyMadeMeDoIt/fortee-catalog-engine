---
phase: 18-drive-to-br-image-linker
plan: "03"
subsystem: image-linker-verify
tags: [drive, image-linker, verification, url-render, idempotency, checkpoint, tdd]
dependency_graph:
  requires: [buildPlan, urlForFileId, parseCanonicalFilename (18-01, 18-02)]
  provides: [classifyHeadResponse, main (scripts/check-br-image-urls.ts), dry-run audit]
  affects: [live --apply (pending checkpoint approval)]
tech_stack:
  added: []
  patterns: [content-type-classification, http-head-probe, redirect-follow, ranged-get-fallback]
key_files:
  created:
    - scripts/check-br-image-urls.ts
    - tests/scripts/check-br-image-urls.test.ts
  modified: []
decisions:
  - "classifyHeadResponse: 4xx/5xx→forbidden, image/*→ok, everything else (including missing CT)→not-image"
  - "probeUrl: follows up to 5 redirects; 405 Method Not Allowed triggers 1-byte ranged GET fallback"
  - "Dry-run audit: 65417 total updates planned (691 written_new + 64726 overwritten_changed); 6552 misses"
  - "DirectSideImage mapping confirmed non-inverted: existing cells hold uc?id= Drive left-side URLs"
  - "Brand-leak audit passed: H08050 color tokens clean (Black, Burgundy, Caramel, Forest, etc.)"
  - "URL HEAD sample: 10/10 newUrl entries return image/png — no Drive permission gaps"
  - "CHECKPOINT REACHED: --apply not yet run; awaiting operator approval"
metrics:
  duration: "~35 minutes"
  completed: "2026-06-10"
  tasks_completed: 2
  files_created: 2
---

# Phase 18 Plan 03: URL Validator + Dry-Run Audit Summary

URL-render validator (`scripts/check-br-image-urls.ts`) built and tested; full dry-run audit of the Drive→BR image linker completed against the live sheet; blocking checkpoint reached before any sheet writes.

## What Was Built

### `scripts/check-br-image-urls.ts`

New URL-render validator exporting:

- `classifyHeadResponse({ status, contentType, wasRedirected? }): UrlClassification`  
  Pure classifier — no I/O. Rules: 4xx/5xx→`forbidden`; status 2xx + content-type `image/*`→`ok`; otherwise→`not-image` (includes html interstitial + absent content-type).

- `main()`: samples N (default 10) random Drive `uc?id=` URLs from either:
  - `--from-tsv <path>` — the `newUrl` column of a link-br-images diff TSV
  - default — the live BR `FrontImage` column (reads via Sheets API)
  
  Issues HTTP HEAD (with redirect follow + 405→ranged GET fallback); prints per-URL status/content-type table + pass/flag summary; exits 1 if any non-ok results.

### `tests/scripts/check-br-image-urls.test.ts`

19 unit tests covering all classifier cases against mocked response objects (no real network):
- image/* variants (png/jpeg/webp/gif + params) → ok
- text/html variants (plain, charset, spaced) → not-image
- application/json → not-image
- 403, 404, 401 → forbidden
- 5xx errors → forbidden
- redirect + final image/* → ok
- redirect + final html → not-image
- missing/empty contentType → not-image

## Test Results

```
✓ tests/scripts/check-br-image-urls.test.ts (19 tests) 4ms
Test Files  1 passed (1)
Tests       19 passed (19)
Duration    1.48s
```

## TDD Gate Compliance

- RED commit `1af7ca5`: `test(18-03): add failing classifyHeadResponse unit tests (RED)` — failed with "Cannot find module" before implementation
- GREEN commit `ae88045`: `feat(18-03): implement classifyHeadResponse + URL-render sampler (GREEN)` — all 19 tests pass

## Dry-Run Audit Results (Task 2)

**Command run:**
```
NODE_OPTIONS=--use-system-ca npx tsx scripts/link-br-images.ts --dry-run
```

**Drive index:**
- 5 supplier folders found (Shiping, CANADASPORTSWEAR, Richardson, Autres Fournisseurs, Tough Duck)
- 434 pid(s) indexed
- Collision warnings: ~200+ first-seen-wins dedup events (expected — some pids have duplicate files across subfolders; first-seen correct file wins, operator-visible via stderr)

**Plan Stats:**
```
written_new           : 691
overwritten_changed   : 64726
skipped_already_current: 0
misses                : 6552
skipped_no_pid        : 1
total updates planned : 65417
```

**Stats interpretation:**
- `written_new=691`: 691 cells that were empty and now have a Drive file — filling new columns/new pids
- `overwritten_changed=64726`: cells with different existing URLs that will be replaced by canonical uc?id= form
- `skipped_already_current=0`: no cells already at canonical form (expected — the 4 new columns don't exist yet, so they can't be current; existing 3-column cells used a different URL form or different fileId)
- `misses=6552`: (pid,color,role) triples with populated cells but no matching Drive file — cells will be left unchanged (never-blank D-08)
- `skipped_no_pid=1`: one data row with empty productId

The 6,552 misses are plausible: they represent BR rows for products/colors that exist in the sheet but whose images were not re-generated in the v2.0 finalize pipeline (the pipeline completed 452/452 pid folders but not all BR (pid,color) pairs had Drive files generated for every role). This is expected behavior — those cells are protected.

**Brand-leak audit (H08050 / Q-Tees):**

All H08050 color tokens in the diff: Black, Burgundy, Caramel, Forest, Grey Heather, Ivory, Navy, Red, Sage, Taupe. Zero "Q", "Tees", or brand fragments. Brand-leak prevention (D-07) confirmed working.

**DirectSide=LeftSide mapping sanity:**

LeftSide role maps to column M in the diff TSV. The live sheet has column M = DirectSideImage (index 12). Spot-checked 5 pids: all existing DirectSideImage cells contain `https://drive.google.com/uc?id=` URLs (left-side Drive images). Mapping is non-inverted. T-18-09 threat mitigated.

**URL HEAD sample (10 random newUrls from diff TSV):**

```
=== check-br-image-urls ===
Sample size: 10
Source: diff TSV
Found 65417 newUrl entries in TSV

[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...
[OK]         200  image/png  ...

ok: 10 / 10 | not-image: 0 / 10 | forbidden: 0 / 10

[PASS] All sampled URLs return image/* — no Drive permission gaps detected.
```

P7 threat (Drive permission interstitial) not triggered. All 10 sampled URLs are publicly readable images.

## TSV Artifact Paths

- **Diff TSV:** `tmp/link-br-images-plan-2026-06-10T12-09-14-617Z.tsv`
  - 65,417 data rows + 1 header
  - Columns: pid, color, role, range, oldUrl, newUrl
  
- **Miss TSV:** `tmp/link-br-images-misses-2026-06-10T12-09-14-617Z.tsv`
  - 6,552 miss rows
  - Columns: pid, color, role, existingValue, reason

## CHECKPOINT REACHED — Awaiting Operator Approval

**Status:** BLOCKED on checkpoint:human-verify (gate="blocking")

The live `--apply` has NOT been run. The sheet is unchanged.

**To approve and execute the live apply:**

After reviewing the diff and miss TSVs, run:
```
NODE_OPTIONS=--use-system-ca npx tsx scripts/link-br-images.ts --apply
```

This will:
1. Write `tmp/br-image-backup-<ts>.tsv` BEFORE any sheet writes (D-10 pre-apply backup)
2. Add 4 new columns (RightSide, ModelFront, ModelSide, ModelBack) to the sheet grid + headers
3. Re-read the live header to compute column indices (D-06)
4. Write 65,417 cell updates across 7 image columns (3 existing + 4 new)

**Post-apply verification steps:**
```bash
# URL sample (10 random from live sheet after apply)
NODE_OPTIONS=--use-system-ca npx tsx scripts/check-br-image-urls.ts --sample 10

# Idempotency check (second --apply must report 0 changes)
NODE_OPTIONS=--use-system-ca npx tsx scripts/link-br-images.ts --apply
```

## Deviations from Plan

None — plan executed exactly as written for the pre-checkpoint tasks. Task 2 was read-only (dry-run audit) with no code changes. The dry-run revealed no parser/join defects requiring a gap to be filed.

Minor collision warnings during Drive enumeration (~200+ events) are expected and handled correctly by first-seen-wins dedup.

## Known Stubs

None — all code is complete. The live sheet write is intentionally gated behind the operator checkpoint.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan specified.

## Self-Check: PASSED (pre-checkpoint tasks only)

- `scripts/check-br-image-urls.ts` exists
- `tests/scripts/check-br-image-urls.test.ts` exists
- RED commit `1af7ca5` confirmed in git log
- GREEN commit `ae88045` confirmed in git log
- 19/19 tests pass
- Dry-run produced `tmp/link-br-images-plan-2026-06-10T12-09-14-617Z.tsv` and `tmp/link-br-images-misses-2026-06-10T12-09-14-617Z.tsv`
- Brand-leak audit: zero brand tokens in H08050 color column
- DirectSideImage mapping: non-inverted (existing cells hold uc?id= left-side URLs)
- URL HEAD sample: 10/10 ok (all image/png)
- Zero sheet mutations (dry-run only; --apply blocked pending checkpoint)

## Checkpoint Approved + Live Apply (2026-06-10)

Operator approved the live overwrite after reviewing the dry-run audit.

- `--apply` ran: backup `tmp/br-image-backup-2026-06-10T12-49-07-476Z.tsv` (24,174 rows) written first; 4 new columns added (43→47 cols) with header re-read; **90,139 cells written** in 2 batches (25,413 new + 64,726 overwritten; 6,552 misses preserved; 1 no-pid skip).
  - Note: total exceeded the pre-checkpoint dry-run estimate (65,417) because the 4 new columns did not exist during the dry-run, so their ~24.7k fills could not be previewed.
- **Idempotency (OPS-02):** second `--apply` → 0 new, 0 overwritten, 90,139 already-current, **0 updates**.
- **URL render (P7):** post-apply sample 12/12 returned `image/*`.

Phase 18 success criteria 1–5 all satisfied. Phase COMPLETE.
