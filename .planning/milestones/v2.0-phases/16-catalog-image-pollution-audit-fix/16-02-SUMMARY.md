---
phase: 16-catalog-image-pollution-audit-fix
plan: 02
subsystem: audit-script
tags: [phase-16, audit, three-pass-detection, read-only-invariant, drive-rate-limit]
dependency_graph:
  requires:
    - "16-01 foundations: image-pollution-trail, verify-same-product, supplier-canonical, drive helpers"
  provides:
    - "scripts/audit-image-pollution.ts (3-pass image pollution auditor CLI)"
    - "tmp/image-pollution-audit-{YYYY-MM-DD}.tsv output format"
  affects:
    - "16-03 fix orchestrator (consumes audit TSV as input queue)"
    - "16-04 manual CLI (reads polluted-pid queue derived from this script's output)"
tech_stack:
  added: []
  patterns:
    - "Raw-row reader via sheets.spreadsheets.values.get + header-index (NOT readAllRows — SheetRow lacks Model* columns)"
    - "Cascading 3-pass detection: structural (free) → content (AI) → shape (AI), D-07 ordering"
    - "Token-bucket Drive metadata rate-limit + exponential backoff w/ jitter on 403/429"
    - "Static read-only invariant enforced via Test 7 source-scan (no uploadToDrive/writeUpdates/trashDriveFile below safety disclaimer)"
    - "DI seam (RunImagePollutionAuditDeps) for full mockability of network, AI, and fs"
key_files:
  created:
    - scripts/audit-image-pollution.ts
  modified: []
decisions:
  - "Pass 1 invalid_image_format check runs even on shared_url-polluted pids (dual flagging surfaces both issues; same column may be both)."
  - "no_canonical_available emitted as pollution_class='info' row (NOT counted as polluted) per D-04; pid still progresses to Pass 3."
  - "Dry-run skips both Pass 2 verifier AND Pass 1 Drive metadata calls (cost-only-on-explicit-run; tests assert verifySameProductFn + verifyShapeFn unused on dryRun)."
  - "Headwear (H08*) counted once per pid in headwearSkipped — not once per image column. Filter applied at target-pid build, before any pass."
  - "Pass 3 short-circuits per D-07: skipped on any pid with pass1 OR pass2 polluted rows (info rows from no_canonical_available do NOT count as polluted)."
  - "Single combined GREEN commit (66895de) — RED commit 5afa023 already split T1's tests from T2's; the source impl is one cohesive file."
metrics:
  duration_minutes: ~30
  completed_date: 2026-05-12
  tests_added: 15
  tests_per_pass:
    pass1_structural: 7  # Tests 1, 3, 4, 5, 6, 6b, 7, 8 (8 actually; 7 is invariant)
    pass2_content: 4    # Tests 9, 10, 11 + trail/summary partially Test 14
    pass3_shape: 2      # Tests 12, 13
    summary_and_trail: 2 # Tests 14, 15
  files_created: 1
  files_modified: 0
---

# Phase 16 Plan 02: Image Pollution Audit Script Summary

3-pass read-only audit script shipped: structural detection (shared_url + invalid_image_format) runs free with no AI calls, AI-content verification (content_mismatch + model_pollution) compares BR against supplier canonical, and Phase-15-reused shape verification (shape_drift) runs only on pids clean from passes 1+2 per D-07.

## Commits

| Task     | Commit  | Message                                                                 |
| -------- | ------- | ----------------------------------------------------------------------- |
| T1+T2 RED | 5afa023 | test(16-02-T1): add failing tests for audit script (Pass 1 + invariant + Pass 2/3 stubs) |
| T1+T2 GREEN | 66895de | feat(16-02): audit script — 3-pass detection (Pass 1 structural + Pass 2 content + Pass 3 shape) |

RED + GREEN gates satisfied. The previous agent's RED commit (5afa023) wrote all 15 tests; this agent's GREEN commit (66895de) wrote the single 981-line implementation that satisfies all of them in one atomic delivery.

## Files Created / Modified

### Created (1)

| Path                                      | Purpose                                                              | Lines |
| ----------------------------------------- | -------------------------------------------------------------------- | ----- |
| scripts/audit-image-pollution.ts          | Read-only 3-pass image pollution auditor CLI with DI seam            | 981   |

### Modified (0)

No source modifications — the script consumes Plan 01 libs as-is without touching them.

## Public Exports

| Symbol                          | Kind      | Purpose                                                |
| ------------------------------- | --------- | ------------------------------------------------------ |
| runImagePollutionAudit          | function  | DI-seam entry point — accepts mocked deps, returns AuditSummary |
| RunImagePollutionAuditArgs      | interface | CLI flag surface                                       |
| RunImagePollutionAuditDeps      | interface | Full dependency injection contract                     |
| POLLUTION_CLASSES               | const     | Frozen tuple of 5 pollution-class strings              |
| PollutionClass                  | type      | Discriminated union of POLLUTION_CLASSES entries       |
| AuditRow                        | interface | TSV row shape (8 columns + pollution_class)            |
| AuditSummary                    | interface | Return shape: pidsScanned/pidsPolluted/classCounts/headwearSkipped |
| defaultReadRawRows              | function  | Default raw-row reader via sheets.values.get           |

## Test Counts

15 / 15 tests passing in `tests/scripts/audit-image-pollution.test.ts`:

| # | Pass | Test                                                                          |
| - | ---- | ----------------------------------------------------------------------------- |
| 1 | DI   | DI seam shape: returns {pidsScanned, pidsPolluted, classCounts, headwearSkipped} |
| 3 | CLI  | parseArgs surface — dryRun propagation suppresses Pass 2 + 3 verifier calls    |
| 4 | 1    | shared_url FrontImage collision across 3 pids → 3 emitted rows                 |
| 5 | 1    | shared_url cross-column: pidA.ModelFrontImage collides with pidB.FrontImage    |
| 6 | 1    | invalid_image_format via Drive metadata returning application/pdf              |
| 6b| 1    | rate-limit backoff: 403 quotaExceeded twice then success → 3 metadata calls    |
| 7 | inv  | READ-ONLY static invariant: no write-side symbols below safety disclaimer      |
| 8 | 1    | H08* exclusion counted once per pid, not per column (headwearSkipped == 1)     |
| 9 | 2    | content_mismatch (baby onesie vs t-shirt verdict from verifySameProduct)       |
| 10| 2    | D-04 dispatch: null canonical skips Pass 2 verifier, Pass 3 still runs         |
| 11| 2    | model_pollution: Model* vs Front mismatch verdict                              |
| 12| 3    | shape_drift: verifyGarmentTypeMatch returning false on Back vs Front           |
| 13| 3    | D-07 ordering: Pass 3 skipped for pid already polluted in Pass 2               |
| 14| trail | VERIFIER_FAIL trail rows emitted with tier=0 on every verifier dissent         |
| 15| sum  | D-09 summary: pidsScanned + classCounts + headwearSkipped on return object     |

Plan-level verification command: `npx vitest run tests/scripts/audit-image-pollution.test.ts` → **1 file passed (1) / 15 tests passed (15)**.

Plan 01 regression check: `npx vitest run tests/lib/ tests/sheets/drive.test.ts` → **128 tests passing** (11 of 12 suites; the one failing suite is the pre-existing Phase 15 `garment-type-verifier.test.ts` module-load failure when `OPENAI_API_KEY` is unset — out-of-scope for Phase 16 per the resume instructions).

## TSV Header Format Produced

The audit emits a 5-line D-09 comment header followed by an 8-column tab-separated column header, exactly as produced by `writeAuditTSV`:

```
# audit_run_id=2026-05-12T17:37:15.815Z
# pids_scanned=2
# pids_polluted=1
# class_counts: shared_url=0 invalid_image_format=1 content_mismatch=0 model_pollution=0 shape_drift=0
# headwear_skipped_count=0
pid	pollution_class	affected_columns	affected_drive_urls	expected_supplier_url	recommended_fix_tier	pass_detected_in	notes
```

Counts in the comment header are computed AFTER all 3 passes complete (single-pass write at end of run), so the header is always consistent with the body. Re-audit mode appends `-reaudit` to the filename (`tmp/image-pollution-audit-{date}-reaudit.tsv`) so the original audit is preserved alongside the post-fix verification artifact.

## Decisions & Deviations

### Deviations from Plan

**1. [Rule 1 — Bug, anticipated] Pass 1 `invalid_image_format` check skipped under `--dry-run`**
- **Found during:** Test 3 (parseArgs dry-run propagation)
- **Behavior:** Plan said Pass 1 metadata-lookup gate is wired separately from AI gates. Under `--dry-run`, we skip BOTH Pass 1 Drive metadata AND Pass 2 AI calls. Rationale: a "dry run" should make zero network calls. Shared-URL detection still runs because it's pure in-memory computation over BR rows.
- **Impact:** Cost is zero on dry-run; test 3 assertion passes (verifySameProductFn + verifyShapeFn never called).
- **Files modified:** scripts/audit-image-pollution.ts (`if (!args.dryRun)` guards Pass 1 mime-type loop).

**2. [Rule 2 — Critical] no_canonical_available emitted as `pollution_class='info'` (not omitted)**
- **Found during:** Test 10
- **Behavior:** D-04 says no_canonical_available is informational and should not count as polluted. The plan said "EMIT a `notes='no_canonical_available'` audit row (no class change)" — but the row needs SOME class to be valid TSV. We use the string literal `'info'` which is filtered out of both the counter loop and the `pollutedPids` set.
- **Impact:** Class counts stay accurate; Pass 3 still runs on the pid (D-04 cascade).
- **Files modified:** scripts/audit-image-pollution.ts (line ~565 in pass2Content; line ~795 in pollutedPids filter).

**3. [Rule 1 — Bug] dryRun emits pass-1 shared_url rows but does NOT call recommendedFixTier**
- **Found during:** Test 3 hardening
- **Behavior:** `recommendedFixTier` calls `supplierCanonicalFn` to decide tier 1 vs 3. Under dry-run we hardcode tier 1 to avoid invoking the canonical resolver (which would defeat the dry-run intent).
- **Impact:** Dry-run output is structurally correct but recommended_fix_tier may be optimistic. Acceptable since dry-run is for pass-plan inspection, not real fix routing.

### no_canonical_available pids observed

No real audit run was executed (this plan does not exercise real network); the only fixtures are test mocks. The 16-03 fix orchestrator will produce real-world `no_canonical_available` rows when run against the live BR sheet. Plan 01 already memos the dispatch surface: H08* always returns null; non-S/non-L pids in KNOWN_SUPPLIER_PREFIXES log a D-12 expansion candidate hint; truly unknown pids return null silently.

## Authentication Gates

None encountered. All tests run with `vi.mock('openai', …)` and `vi.mock('fs', …)`; no real OpenAI or Drive calls were exercised. The real-network path requires `SS_ACCOUNT_NUMBER`, `SS_API_KEY`, `OPENAI_API_KEY`, and the Google service-account vars at CLI run time — these are validated in `main()` before any client is constructed.

## Pre-existing Issues (Not Phase 16)

`tests/lib/garment-type-verifier.test.ts` (Phase 15 fixture-gated suite) still fails at module-load when `OPENAI_API_KEY` is unset — the `new OpenAI({...})` call lives outside the `describe.skipIf(...)` block. This is a Phase 15 bug carried over from Plan 01 and called out in the resume instructions. Not in scope.

## Known Stubs

None. The script is self-contained and consumes Plan 01 libs as fully-implemented dependencies.

## Self-Check: PASSED

- File `scripts/audit-image-pollution.ts` exists (981 lines).
- Commit `5afa023` (RED) found in git log.
- Commit `66895de` (GREEN) found in git log.
- `npx vitest run tests/scripts/audit-image-pollution.test.ts` → 15 passing.
- `npx vitest run tests/lib/ tests/sheets/drive.test.ts` → 128 passing (the 1 failing suite is pre-existing Phase 15 OPENAI_API_KEY module-load bug, called out as out-of-scope).
- Acceptance grep checks:
  - "MUST NEVER call uploadToDrive" → 1 match on line 2 (safety disclaimer).
  - Below line 20 forbidden symbols `(uploadToDrive|writeUpdates|trashDriveFile)` → 0 matches.
  - `from '../src/sheets/writer'` → 0 matches.
  - `VALID_IMAGE_MIMES` → 3 matches.
  - `extractFileId(` → 7 matches.
  - `/^H08/i` → 1 match.
  - `max-drive-rps|maxDriveRps` → 6 matches.
  - `quotaExceeded|drive_quota` → 2 matches.
  - `async function pass2Content` → 1 match (line 499).
  - `async function pass3Shape` → 1 match (line 663).
  - `no_canonical_available` → 2 matches.
  - `'model_pollution'` → 2 matches.
  - `'shape_drift'` → 2 matches.
  - `# audit_run_id` / `audit_run_id` → 2 matches (header literal + console log).
  - `re-audit|reaudit` → 5 matches.
  - `post-mortem|postMortem` → 10 matches.
- `export ` count → 8 named exports (target was ≥4).
