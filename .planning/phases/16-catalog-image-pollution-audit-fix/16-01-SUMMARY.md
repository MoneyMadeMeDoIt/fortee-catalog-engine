---
phase: 16-catalog-image-pollution-audit-fix
plan: 01
subsystem: foundations
tags: [phase-16, foundations, trail-tsv, vision-verifier, supplier-canonical, drive-helpers]
dependency_graph:
  requires: []
  provides:
    - "image-pollution-trail library (TrailRow, appendTrailRow, getOrCreateTrailRunId, loadProcessedPids)"
    - "verify-same-product library (verifySameProduct, SAME_PRODUCT_SYSTEM_PROMPT)"
    - "supplier-canonical library (resolveSupplierCanonical, CanonicalResult)"
    - "Drive helpers on src/sheets/drive.ts (extractFileId, downloadFromDrive, trashDriveFile, getDriveFileMetadata)"
  affects:
    - "16-02 (audit script) consumes all 4 foundations"
    - "16-03 (fix orchestrator) consumes trail + verifier + supplier-canonical + Drive helpers"
    - "16-04 (manual CLI) consumes trail (loadProcessedPids) + verifier + Drive helpers"
tech_stack:
  added: []
  patterns:
    - "TSV append-only with fsync-per-write durability gate (D-15)"
    - "Sanitize 4 unsafe fields before tab-join (T-16-06, mirrors src/lib/rejects-tsv.ts:63-65)"
    - "OpenAI gpt-4o-mini Vision verifier with json_object response_format + detail:'low' + false-accept-on-error (T-16-02)"
    - "Per-source module-global lastRequestAt throttle (T-16-05)"
    - "S&S Basic auth + 503 retry-once (mirrors scripts/fetch-ss-images-fixed.ts)"
    - "CSW Shopify search-suggest + products.json scrape (mirrors scripts/scrape-csw-product.ts)"
key_files:
  created:
    - src/lib/image-pollution-trail.ts
    - src/lib/verify-same-product.ts
    - src/lib/supplier-canonical.ts
    - tests/lib/image-pollution-trail.test.ts
    - tests/lib/verify-same-product.test.ts
    - tests/lib/supplier-canonical.test.ts
    - tests/sheets/drive.test.ts
  modified:
    - src/sheets/drive.ts
decisions:
  - "Trail TSV is a SIBLING of rejects-tsv.ts (verbatim pattern copy, no import) per 16-RESEARCH.md line 295."
  - "fsync block runs even on first write (writeFileSync path), not just on append — matches the unconditional D-15 durability gate intent."
  - "loadProcessedPids treats VERIFIER_PASS / SUPPLIER_FETCH / DRIVE_UPLOAD as NON-terminal (per RESEARCH Pitfall 8); only BR_WRITE / MANUAL_SKIP / MANUAL_ACCEPT count as 'done'."
  - "verify-same-product uses candidate-first prompt order (BR image first, supplier reference second) — opposite of Phase 15's reference-first verifier. Reflects the audit mental model: audited thing leads, truth source follows."
  - "Color-blind by default in SAME_PRODUCT_SYSTEM_PROMPT (per CONTEXT Claude's Discretion): different color of same style = match=true."
  - "supplier-canonical NEVER exposes colorSideImage as canonical — only colorFrontImage. Per user memory feedback_strict_side_profile + scripts/fetch-ss-images-fixed.ts:132-138."
  - "Per-source module-global throttle timestamps (ssLastRequestAt + cswLastRequestAt) — keeps the two scrapers independent so a slow CSW call cannot stall S&S throughput."
metrics:
  duration_minutes: ~25
  completed_date: 2026-05-12
  tests_added: 36
  tests_per_suite:
    image-pollution-trail: 10
    verify-same-product: 8
    supplier-canonical: 9
    drive: 9
  files_created: 7
  files_modified: 1
---

# Phase 16 Plan 01: Foundations Summary

Wave 1 foundations shipped: trail TSV writer with fsync durability + resume helper, same-product Vision verifier (sibling to Phase 15's family-level verifier), supplier-canonical resolver (S&S + CSW dispatcher with rate limits and the colorSideImage caveat baked in), and 4 new Drive helpers appended to `src/sheets/drive.ts`. Every downstream Phase 16 plan (audit, fix orchestrator, manual CLI) now has its primitive libs in place.

## Commits

| Task | Commit  | Message                                    |
| ---- | ------- | ------------------------------------------ |
| T1   | b475ba6 | feat(16-01-T1): trail TSV writer + drive helpers |
| T2   | 13b2ac5 | feat(16-01-T2): same-product Vision verifier |
| T3   | e11a07c | feat(16-01-T3): supplier-canonical resolver |

Each commit was TDD-driven: failing tests written first, implementation written next, vitest run green before committing.

## Files Created / Modified

### Created (7)

| Path                                             | Purpose                                            |
| ------------------------------------------------ | -------------------------------------------------- |
| src/lib/image-pollution-trail.ts                 | 9-column trail TSV writer + resume helper          |
| src/lib/verify-same-product.ts                   | gpt-4o-mini same-specific-product Vision verifier  |
| src/lib/supplier-canonical.ts                    | pid → supplier image URL prefix dispatcher         |
| tests/lib/image-pollution-trail.test.ts          | 10 mocked-fs tests covering D-14, T-16-06, D-15    |
| tests/lib/verify-same-product.test.ts            | 8 mocked-OpenAI tests covering T-16-02 + prompt order |
| tests/lib/supplier-canonical.test.ts             | 9 mocked-fetch tests covering dispatch + rate-limit |
| tests/sheets/drive.test.ts                       | 9 mocked-drive_v3 tests for the 4 new helpers      |

### Modified (1)

| Path                  | Change                                                     |
| --------------------- | ---------------------------------------------------------- |
| src/sheets/drive.ts   | Appended 4 named exports (extractFileId, downloadFromDrive, trashDriveFile, getDriveFileMetadata) + DriveFileMetadata interface. Existing exports (createDriveClient, uploadToDrive) untouched. |

## Test Counts per Suite

| Suite                                        | Tests | Notes                                                    |
| -------------------------------------------- | ----- | -------------------------------------------------------- |
| tests/lib/image-pollution-trail.test.ts      | 10    | A-J behaviors per plan: header write, append-only, sanitize, tier=0, non-throwing, fsync block, run_id memoization, missing-trail empty, terminal-op-only resume, 9-op union exhaustive |
| tests/lib/verify-same-product.test.ts        | 8     | 1-8 per plan: happy match, mismatch, regex-rescue, no-JSON fallback, API-error fallback, empty content, request shape, candidate-first prompt order |
| tests/lib/supplier-canonical.test.ts         | 9     | 1-9 per plan: H08 short-circuit, S&S happy, S&S unknown, CSW happy, CSW no handle, allowlist log, unknown silent, colorSideImage caveat, real-time rate-limit |
| tests/sheets/drive.test.ts                   | 9     | K-P + 3 extractFileId variants: uc?id, /file/d/, empty/non-Drive, downloadFromDrive params, trashDriveFile params + log, getDriveFileMetadata fields + missing-field defaults |
| **Total**                                    | **36** | Target was ≥33 (success criteria); shipped 36.        |

Plan-level verification command (verbatim from the plan's `<verification>` block):
`npx vitest run tests/lib/image-pollution-trail.test.ts tests/lib/verify-same-product.test.ts tests/lib/supplier-canonical.test.ts tests/sheets/drive.test.ts` → **4 files passed (4) / 36 tests passed (36)**.

Phase 15 regression check (`npx vitest run tests/lib/`) reports **119 tests passing**. Phase 15's `tests/lib/rejects-tsv.test.ts` (8 tests) still green. See "Pre-existing issues" below for the one unrelated failing fixture suite.

## Deviations from PATTERNS.md Analogs

None of the deviations changed an analog's behavior; each is a small Phase-16-specific addition documented in source comments.

| # | Where                                          | Deviation                                                                                   | Why                                                                                                                                                       |
| - | ---------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | image-pollution-trail.ts fsync block           | fsync runs on BOTH writeFileSync (first write) and appendFileSync (subsequent), not only on append. | PATTERNS.md only shows fsync after the if/else — but the D-15 durability invariant ("crash loses at most one in-flight op") applies equally to the bootstrapping write. Test F enforces this. |
| 2 | image-pollution-trail.ts loadProcessedPids     | Uses `new Set<TrailOperation>(['BR_WRITE','MANUAL_SKIP','MANUAL_ACCEPT'])` for the terminal check instead of `.includes()`. | Same semantics, O(1) lookup, type-safer (compiler verifies the literal strings are valid TrailOperations). PATTERNS.md showed `.includes(operation)` which works on `string[]`; the Set form is a strict superset. |
| 3 | verify-same-product.ts logger prefix           | Warning on parse-fallback (no JSON found) uses `[verify-same-product]` prefix everywhere, including the inner-catch parse failure. | PATTERNS.md showed the prefix on the outer api-error log only. Phase 15 has the same omission internally — but Phase 16 makes all three warn paths share the prefix for grep-ability. |
| 4 | supplier-canonical.ts CSW_BASE                  | `https://www.canadasportswear.com` instead of `https://canadasportswear.com` shown in PATTERNS.md line 376. | The script analog (`scrape-csw-product.ts:13`) uses the `www.` form. PATTERNS.md was reflecting a typo. Aligned with the working analog. |
| 5 | supplier-canonical.ts module-global timestamps | Two separate timestamps (`ssLastRequestAt` + `cswLastRequestAt`) instead of one shared `lastRequestAt`. | Different rate limits (1100 vs 1000 ms); sharing a timestamp would either over-throttle CSW or under-throttle S&S. Each source needs independent throttle bookkeeping. |
| 6 | drive.ts DriveFileMetadata export              | Exported the interface alongside the function (PATTERNS.md showed inline `Promise<{mimeType,size,name}>`). | Lets downstream plans (16-02 Pass 1) reference `DriveFileMetadata` by name when typing their per-pid pollution-class enum. No behavior change. |

None of these warranted halting for Rule 4 (architectural). Two — #1 and #2 — were tightenings of the contract that the plan's `<behavior>` block already required (test F asserts unconditional fsync; test I uses a Set semantically).

## Trail Run ID

No test persisted a trail TSV to real disk — all 4 fs functions (`writeFileSync`, `appendFileSync`, `openSync`, `fsyncSync`, `closeSync`, `readFileSync`) are mocked via `vi.mock('fs')`. `getOrCreateTrailRunId()` was exercised in-memory only in Test G. No `tmp/image-pollution-fix-trail-*.tsv` artifact exists on disk; downstream plans (16-02 audit) will produce the first real trail.

## Authentication Gates

None encountered. Task 3's S&S branch reads `SS_ACCOUNT_NUMBER` + `SS_API_KEY` at call time, but the tests stub those env vars in `beforeEach`, and the real-network path is never exercised. No live API calls were made in any test.

## Pre-existing Issues (Not Phase 16)

`tests/lib/garment-type-verifier.test.ts` (Phase 15 fixture-gated suite) fails at module-load when `OPENAI_API_KEY` is unset, because the `new OpenAI({...})` call lives outside the `describe.skipIf(...)` block. This is a Phase 15 bug, not introduced by Plan 01 — the module-level constructor happens before the skip check fires. Not in scope for this plan; logged here for visibility. All other 10 suites under `tests/lib/` pass (119 tests).

## Self-Check: PASSED

- File `src/lib/image-pollution-trail.ts` exists.
- File `src/lib/verify-same-product.ts` exists.
- File `src/lib/supplier-canonical.ts` exists.
- File `src/sheets/drive.ts` modified (4 new exports appended).
- File `tests/lib/image-pollution-trail.test.ts` exists.
- File `tests/lib/verify-same-product.test.ts` exists.
- File `tests/lib/supplier-canonical.test.ts` exists.
- File `tests/sheets/drive.test.ts` exists.
- Commit `b475ba6` found in git log (Task 1).
- Commit `13b2ac5` found in git log (Task 2).
- Commit `e11a07c` found in git log (Task 3).
- All 36 tests across the 4 plan suites pass.
- Phase 15's `tests/lib/rejects-tsv.test.ts` still green (8 tests, no regression).
- All 7 acceptance-criteria grep checks pass for T1, all 7 for T2, all 9 for T3.
