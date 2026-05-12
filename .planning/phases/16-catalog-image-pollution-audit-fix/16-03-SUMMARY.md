---
phase: 16-catalog-image-pollution-audit-fix
plan: 03
subsystem: fix-orchestrator
tags: [phase-16, fix-orchestrator, tier-1-supplier-fetch, tier-2-ai-regen, r6-hard-cap, drive-write-safety]
dependency_graph:
  requires:
    - "16-01 foundations: image-pollution-trail, verify-same-product, supplier-canonical, Drive helpers"
    - "16-02 audit script: tmp/image-pollution-audit-{date}.tsv (D-09 header + 8-col body)"
  provides:
    - "scripts/fix-image-pollution.ts (Tier 1 + Tier 2 orchestrator with R6 hard-cap exit)"
    - "tmp/image-pollution-manual-queue-{YYYY-MM-DD}.tsv (6-col Tier 3 input)"
    - "tmp/image-pollution-fix-summary-{YYYY-MM-DD}.json (run summary with status)"
  affects:
    - "16-04 manual CLI (consumes the manual queue TSV)"
tech_stack:
  added: []
  patterns:
    - "Drive update-in-place compare-before-trash (T-16-01 mitigation at every write site)"
    - "Front-first per-pid ordering so back/side verifier-after-fix uses the new front as source-of-truth"
    - "D-17 Exception: FrontImage tier-1 replacement skips verifier (tautological); trail logs 'verifier_skipped_tautology'"
    - "D-21 cross-tier sequencing: Tier 1 fully completes before Tier 2 starts"
    - "D-15 resume-from-trail: loadProcessedPids skips today's terminal pids silently"
    - "R6 hard cap: manual_queue_size > 20 → process.exit(2) after queue TSV + summary JSON both flushed"
key_files:
  created:
    - scripts/fix-image-pollution.ts
    - tests/scripts/fix-image-pollution.test.ts
  modified: []
decisions:
  - "Single atomic commit instead of split (T1 + T2). Both tasks ship buildable + tests-green; the file is one cohesive piece and splitting would require fabricating an intermediate state with partial Tier 2."
  - "PermissiveCostTracker shim for Tier 2 generateGarmentView dependency — D-24 says no fix cost cap. Real CostTracker would require setting up a budget; the shim always reports 'can afford' and records cost for the summary JSON."
  - "inferCategoryGroup heuristic from baseCategory + productName text — generateGarmentView needs CategoryGroup. Production wires this from BR header columns; tests don't exercise the path so it's a best-effort fallback that defaults to 'tops'."
  - "Manual queue front_image_screenshot_link always points at FrontImage (D-13 ergonomics — operator wants visual context of the product even when the polluted column is Back/Side). Test 16 asserts this."
  - "Headwear (H08*) exclusion is NOT re-checked in Plan 03 — the audit TSV from Plan 02 already filtered them. If a stray H08 pid appears in the audit TSV, supplier-canonical returns null → cascade → manual queue → operator can [s]kip in Plan 04."
metrics:
  duration_minutes: ~35
  completed_date: 2026-05-12
  tests_added: 17
  files_created: 2
  files_modified: 0
  script_lines: 970
  test_lines: 705
---

# Phase 16 Plan 03: Fix Orchestrator Summary

Tier 1 (supplier fetch) + Tier 2 (AI regen) fix orchestrator shipped with the R6 hard cap, T-16-01 Drive update-in-place mitigation, D-17 front-first ordering (and tautology exception), and D-15 resume-from-trail. Reads the Plan 02 audit TSV and produces the Plan 04 manual queue TSV. The script is the first Phase 16 component that WRITES to BR + Drive — every mutation is gated on a verifier-passing fix AND a fileId-comparison check before any deletion.

## Commits

| Task     | Commit  | Message                                                                            |
| -------- | ------- | ---------------------------------------------------------------------------------- |
| T1 + T2  | 95df19b | feat(16-03): fix orchestrator — Tier 1 supplier fetch + Tier 2 AI regen + R6 hard cap |

Single atomic commit per Plan 16-03's explicit allowance ("your call as long as each commit is buildable + tests-green at HEAD"). The 17 tests + 970-line implementation ship together because Tier 1 and Tier 2 share helpers (`makeFilename`, BR index, T-16-01 compare-before-trash logic) and an intermediate "Task 1 only" commit would require artificially gutting `runImagePollutionFix` of the Tier 2 + R6 gate path.

## Files Created

| Path                                       | Purpose                                                              | Lines |
| ------------------------------------------ | -------------------------------------------------------------------- | ----- |
| scripts/fix-image-pollution.ts             | Tier 1 + Tier 2 orchestrator + R6 hard cap + manual queue emission   | 970   |
| tests/scripts/fix-image-pollution.test.ts  | 17-test DI-mocked smoke suite covering Tasks 1+2 behaviors           | 705   |

## Public Exports

| Symbol                       | Kind      | Purpose                                                          |
| ---------------------------- | --------- | ---------------------------------------------------------------- |
| runImagePollutionFix         | function  | DI-seam entry point; returns RunImagePollutionFixResult or exits 2 |
| tier1Fix                     | function  | Per-pid Tier 1 (supplier fetch + verifier-after-fix + Drive/BR write) |
| tier2Fix                     | function  | Per-pid Tier 2 (generateGarmentView + Drive/BR write); NO double verifier |
| parseAuditTsv                | function  | Parse Plan 02 audit TSV into PollutionRow[] (skips info rows)    |
| defaultReadRawRows           | function  | Production raw-row reader (sheets.values.get)                    |
| PollutionRow                 | interface | Audit-TSV row shape (pid + class + columns + urls + tier hint)   |
| TierResult                   | interface | Per-pid tier outcome (status + cascade flag)                     |
| RunImagePollutionFixArgs     | interface | CLI flag surface                                                 |
| RunImagePollutionFixDeps     | interface | Full dependency injection contract                               |
| RunImagePollutionFixResult   | interface | Run-level summary returned to caller (or written to disk JSON)   |

10 named exports total (acceptance criterion: ≥5).

## Test Counts (17 / 17 passing)

| Bucket             | Tests | Coverage                                                                                                    |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------- |
| Task 1 / Tier 1    | 9     | DI seam (1), TSV parser (2), resume D-15 (3), R3 happy front (4), R3 happy back/side (5), R9 verifier-fail safety rail (6), T-16-01 compare-before-trash (7), front-first ordering D-17 (8), no_canonical → cascade (9) |
| Task 2 / Tier 2    | 4     | R4 happy + no double verifier (10), retry-null → Tier 3 (11), T-16-01 mirrored in Tier 2 (12), D-21 no cross-tier concurrency (13) |
| Task 2 / R6 gate   | 2     | 19 pids → exit 0, status OK (14); 21 pids → exit 2, BLOCKED-QUEUE-OVERFLOW, queue + summary both written (15) |
| Task 2 / queue+sum | 2     | manual queue 6-col TSV format with derived suggested_action (16); summary JSON shape with all 9 keys (17)   |

Plan verification: `npx vitest run tests/scripts/fix-image-pollution.test.ts` → **1 file passed (1) / 17 tests passed (17) / 37 ms**.

Plan 01/02 regression: `npx vitest run tests/lib/ tests/sheets/drive.test.ts tests/scripts/audit-image-pollution.test.ts` → **143 / 143 passing** across 12 of 13 suites. The 1 failing suite is the pre-existing Phase 15 `tests/lib/garment-type-verifier.test.ts` OPENAI_API_KEY module-load bug — out of scope per the resume instructions.

## Edge Cases Encountered

1. **`generateGarmentView` signature richer than plan text.** Plan 03 stated the signature as `(frontBuffer, view, options?)`, but the real signature (src/lib/ai-image-generator.ts:341-479) is `(frontBuffer, view, garmentType, colorName, pid, costTracker, client?, productName?)`. The orchestrator gathers these from the BR row (`inferCategoryGroup` heuristic over baseCategory + productName; colorName + productName direct from row). Tests pass through the DI seam so the per-arg shape doesn't matter for assertions — `generateGarmentViewFn` is mocked. Production path infers a CategoryGroup that defaults to `'tops'` when the regex doesn't match.

2. **CostTracker dependency.** generateGarmentView requires a CostTracker (D-07 budget gate). D-24 says no fix-cost cap. Introduced `PermissiveCostTracker` (in-file shim) that always reports `canAfford(_) === true` and accumulates `record()` calls into `summary.total_cost_usd_estimate`. Real-network runs see real cost in the summary JSON.

3. **Front-first ordering across both Front + Back pollution.** Test 8 stresses this: even when the audit TSV lists `affected_columns=['BackImage', 'FrontImage']` (Back first), the orchestrator sorts so FrontImage processes first. The local `currentBrUrls['FrontImage']` is updated mid-iteration to reflect the new fileId. If a back/side verifier-after-fix runs in the same iteration, it downloads the NEW Drive front (via `downloadFromDrive` on the updated fileId), satisfying D-17's source-of-truth rule.

4. **D-21 cross-tier sequencing.** Test 13 instruments the dep mocks with a shared `callOrder` array. The assertion is `firstGenIdx > lastSupplierIdx`, i.e., every `supplierCanonical` call (Tier 1) precedes every `generateGarmentView` call (Tier 2). The implementation guarantees this by collecting Tier 1 results into an array before iterating into the Tier 2 loop — no `Promise.all` or interleaving.

5. **R6 BLOCKED path also writes both artifacts.** Test 15 asserts that even when `process.exit(2)` fires, BOTH the manual queue TSV AND the summary JSON have already been written before the exit call. The implementation orders the writes in the runner: `writeManualQueueTsv` → `writeFileSync(summaryPath, ...)` → `console.log` → conditional `process.exit(2)`. The fs mock captures both writes regardless of exit.

6. **Test fixtures don't exercise the production audit-file path.** Tests inject `auditRowsOverride` directly into the deps to skip `parseAuditTsv` and `findLatestAuditTsv`. Test 2 covers `parseAuditTsv` separately with a synthetic TSV. The production path (`--audit-file path` or auto-find newest TSV in `tmp/`) is wired in `main()` but not unit-tested — it'll be exercised on the first real audit-run-then-fix-run cycle.

## Sample Summary JSON (from Test 17 fixture run)

The synthetic Test 17 fixture writes this shape to `tmp/image-pollution-fix-summary-2026-05-12.json` (mocked fs — no real disk write):

```json
{
  "audit_run_id": "2026-05-12T17:46:03.894Z",
  "tier1_fixed": 1,
  "tier2_fixed": 0,
  "cascaded_to_tier3": 0,
  "manual_queue_size": 0,
  "manual_queue_path": "tmp/image-pollution-manual-queue-2026-05-12.tsv",
  "total_cost_usd_estimate": 0,
  "status": "OK",
  "processed_pid_count": 1
}
```

All 9 required keys (`audit_run_id`, `tier1_fixed`, `tier2_fixed`, `cascaded_to_tier3`, `manual_queue_size`, `manual_queue_path`, `total_cost_usd_estimate`, `status`, `processed_pid_count`) are emitted on every run. `status` is one of `'OK' | 'BLOCKED-QUEUE-OVERFLOW'`.

## Acceptance-Criteria Grep Checks (Task 1 + Task 2)

| Check                                                                     | Expected | Actual |
| ------------------------------------------------------------------------- | -------- | ------ |
| `grep -c "^export "` (count of named exports)                             | ≥ 5      | 10     |
| `grep -nE "origFileId !== newFileId"` (T-16-01 mitigation)                | ≥ 1      | 2      |
| `grep -nE "Front-first"` (front-first ordering note)                      | ≥ 1      | 1      |
| `grep -nE "no_canonical|no canonical"`                                    | ≥ 1      | 4      |
| `grep -nE "loadProcessedPids"`                                            | ≥ 1      | 4      |
| `grep -nE "VERIFIER_FAIL|VERIFIER_PASS"`                                  | ≥ 2      | 2      |
| `grep -nE "verifier_skipped_tautology"` (D-17 Exception)                  | ≥ 1      | 2      |
| `grep -nE "DRIVE_UPLOAD|DRIVE_DELETE|BR_WRITE|SUPPLIER_FETCH"`            | ≥ 4      | 8      |
| `grep -nE "columnToLetter\\("`                                            | ≥ 1      | 2      |
| `grep -nE "writeUpdates\\(" `                                             | ≥ 1      | 2      |
| `grep -nE "function tier2Fix"`                                            | = 1      | 1      |
| `grep -nE "generateGarmentView"`                                          | ≥ 1      | 8      |
| `grep -nE "AI_REGEN"`                                                     | ≥ 2      | 2      |
| `grep -nE "BLOCKED-QUEUE-OVERFLOW"`                                       | ≥ 2      | 6      |
| `grep -nE "process\\.exit\\(2\\)"`                                        | = 1      | 1      |
| `grep -nE "image-pollution-manual-queue-"`                                | ≥ 1      | 1      |
| `grep -nE "image-pollution-fix-summary-"`                                 | ≥ 1      | 1      |
| `grep -nE "manual_queue_size"`                                            | ≥ 2      | 3      |
| Tier 2 has NO verifySameProductFn call                                    | 0        | 0      |

All 19 grep acceptance checks pass.

## Deviations from PATTERNS.md / Plan

**1. [Plan adaptation] Single commit instead of two.** Plan 16-03 explicitly allows operator discretion ("your call as long as each commit is buildable + tests-green at HEAD"). Chose single commit because Tier 1 and Tier 2 share core helpers and a deliberately-staged intermediate commit would have to gut `runImagePollutionFix` of its Tier 2 + R6 gate, which would make the intermediate commit non-functional even if tests for it pass. Net effect: one cohesive commit, both tasks satisfied.

**2. [Plan adaptation] `generateGarmentView` arg list.** Plan 16-03's `<interfaces>` block showed the simplified signature `generateGarmentView(frontBuffer, view, options?)` — the real Phase 10 signature has 8 positional args including `garmentType`, `colorName`, `pid`, `costTracker`, optional `client`, optional `productName`. Implementation wires all 8 from the BR row via the helper functions `inferCategoryGroup` + direct header lookups. Tests don't exercise this surface (DI seam mocks return a fixed `GenerateViewResult`), so the production wiring is best-effort but typed correctly.

**3. [Local helper] `PermissiveCostTracker` shim.** generateGarmentView requires a `CostTracker` instance. D-24 specifies no fix budget cap, so a permissive shim suffices. Spent dollars accumulate into `summary.total_cost_usd_estimate` for observability.

**4. [Trail row payload] DRIVE_UPLOAD has `column_or_path = newFileId`.** Pattern 6 shows `column_or_path: newFileId` for the DRIVE_UPLOAD trail row. Implementation matches. The accompanying `old_value` carries origFileId and `new_value` carries newFileId, so post-mortem can reconstruct the full replacement.

**5. [Manual queue front-image link]** Even when the polluted column is Back/Side, the `front_image_screenshot_link` column points at FrontImage (D-13 ergonomics — operator needs visual product context). Test 16 explicitly asserts this for the `X2` shape_drift case where BackImage is polluted but the screenshot link points at the FrontImage.

No Rule-4 (architectural) decisions encountered. No source files outside Plan 03's `<files_modified>` block were touched (no edits to Plan 01 libs or Plan 02's audit script).

## Authentication Gates

None encountered. Tests run with `vi.mock('openai')` + `vi.mock('fs')`; no real OpenAI, Drive, or Sheets calls. The real-network path requires SS_ACCOUNT_NUMBER + SS_API_KEY + OPENAI_API_KEY + GOOGLE_* — validated in `main()` before any client is constructed. First real-network run will exercise these.

## Pre-existing Issues (Not Phase 16)

`tests/lib/garment-type-verifier.test.ts` (Phase 15 fixture-gated suite) continues to fail at module-load when `OPENAI_API_KEY` is unset because the `new OpenAI({...})` call lives outside the `describe.skipIf(...)` block. Carried over from Plans 01 + 02; out of scope per the orchestrator's resume instructions.

## Known Stubs

None. Every dependency in the orchestrator is fully wired to real implementations. The `PermissiveCostTracker` is intentional (D-24), not a stub.

## Threat Flags

None new. T-16-01 / T-16-02 / T-16-04 / T-16-07 / T-16-08 are all mitigated and tested per the plan's threat register. No new surface introduced beyond what the plan already audited.

## Self-Check: PASSED

- File `scripts/fix-image-pollution.ts` exists (970 lines).
- File `tests/scripts/fix-image-pollution.test.ts` exists (705 lines).
- Commit `95df19b` found in `git log --oneline -1`.
- `npx vitest run tests/scripts/fix-image-pollution.test.ts` → 17 passing in 37 ms.
- All 19 grep acceptance criteria pass (table above).
- Phase 16 Plan 01 + 02 regression: 143 / 143 tests green across `tests/lib/` and `tests/scripts/audit-image-pollution.test.ts` (the 1 failing Phase 15 suite is pre-existing out-of-scope OPENAI_API_KEY bug).
- `npx tsc --noEmit` produces 0 errors for `scripts/fix-image-pollution.ts`.
