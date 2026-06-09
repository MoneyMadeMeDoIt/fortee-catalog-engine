---
phase: 17-catalog-image-pollution-fix
type: phase-validation
created: 2026-05-14
---

# Phase 17 — Validation Matrix

Maps each phase-17 requirement to the plan(s) that implement it, the must_have truths/artifacts/key_links inside those plans that PROVE delivery, and the automated/manual verification path.

## Requirement → Plan Coverage

| Req ID | Description | Source | Owning Plan(s) | Verification |
|--------|-------------|--------|----------------|--------------|
| R17-01 | All 4 Drive helpers (`downloadFromDrive`, `getDriveFileMetadata`, `trashDriveFile`, `uploadToDrive`) timeout at 30s and retry up to 2 times on timeout | 17-RESEARCH.md §Phase Requirements; PRODUCTION-AUDIT-FINDINGS.md B-1 | **17-01** | `npx vitest run tests/sheets/drive.test.ts` (11 tests). Manual smoke: re-run audit `--all` against the 449-pid corpus — must complete in bounded time. |
| R17-02 | `resolveSupplierCanonical(pid, colorName)` returns the per-color canonical (S&S exact-match, CSW filename-substring) with `wasFallback: true` when colorName provided but unmatched | 17-RESEARCH.md §Phase Requirements; PRODUCTION-AUDIT-FINDINGS.md §"Why Tier 1/2 yield was much lower" | **17-02** | `npx vitest run tests/lib/supplier-canonical.test.ts -t "17-02"` (12 tests). Manual smoke: re-run `scripts/fix-image-pollution.ts --tier1-only` against the 2026-05-14 audit TSV — at least 1 of the 11 previously-rejected color-mismatch pids should now produce a BR_WRITE row. |
| R17-03 | `scripts/fix-model-images.ts` rebuilds polluted Model* slots via Tier 1 (S&S `colorOnModel*`) + Tier 2 (`generateModelImage`) with verifier-after-fix gates | 17-RESEARCH.md §Phase Requirements; PRODUCTION-AUDIT-FINDINGS.md §"Model* columns are 72% of all pollution" | **17-03** | Task 1: `npx vitest run tests/scripts/fix-model-images.test.ts` (18 tests). Task 2: operator sample-test gate (≥ 7/10 verifier pass). Task 3: full 213-pid run + `--re-audit` showing `model_fail_after_count < 50`. |
| R17-04 | `supplier-canonical` dispatches adidas (A*/CE*) + KNOWN_SUPPLIER_PREFIXES brands (Bella, Gildan, Next Level, Comfort Colors, American Apparel, Richardson) through the existing S&S branch — no new scrapers | 17-RESEARCH.md Findings 1+2; PRODUCTION-AUDIT-FINDINGS.md §"714 of 1012 Tier 1 attempts logged 'no canonical for tier 1'" | **17-04** | `npx vitest run tests/lib/supplier-canonical.test.ts -t "17-04 prefix routing"` (18 tests). Manual smoke: count "no canonical" trail rows post re-run; expected drop from 714 to ≤ 100. |
| R17-05 | Operator walks the manual queue residue via the existing `scripts/fix-image-pollution-manual.ts` interactive CLI; manual queue size ≤ 20 (R6 hard cap from Phase 16) | 17-CONTEXT.md; 17-RESEARCH.md §"Plan 17-05" | **17-05** | Task 1: operator confirms manual queue size ≤ 20 from a fresh audit + fix run. Task 2: operator walks every queue pid via the CLI; final residue ≤ 5 deferred pids documented in SUMMARY. |
| R17-06 (B-2) | `--dry-run` flag gates the `trashDriveFile` call at both manual CLI sites (delete handler + replace handler) | PRODUCTION-AUDIT-FINDINGS.md B-2 | **17-06** | `npx vitest run tests/scripts/fix-image-pollution-manual.test.ts -t "17-06 B-2"` (5 tests). |
| R17-07 (B-3) | `scripts/cleanup-checkpoint-test-data.ts` also scans `MANUAL/CHECKPOINT-TEST-*/` and trashes orphan files; never touches `MANUAL/<real-pid>/` data | PRODUCTION-AUDIT-FINDINGS.md B-3 | **17-07** | `npx vitest run tests/scripts/cleanup-checkpoint-test-data.test.ts` (7 tests — new test file). |
| R17-08 (B-4) | Tier 2 loop detects `OpenAI.BadRequestError.code === 'billing_hard_limit_reached'` once, short-circuits remaining pids, writes `TIER2_BUDGET_EXHAUSTED` trail rows, surfaces `status: 'BILLING_LIMIT_HIT'` in JSON summary | PRODUCTION-AUDIT-FINDINGS.md B-4 | **17-08** | `npx vitest run tests/scripts/fix-image-pollution.test.ts -t "17-08 B-4"` (6 tests) + `npx vitest run tests/lib/image-pollution-trail.test.ts -t "17-08 TIER2_BUDGET_EXHAUSTED"` (3 tests). |

## Plan must_have → Phase Validation

The truths/artifacts/key_links in each plan's frontmatter `must_haves` MUST be observable after the plan ships. The table below maps each plan's must_haves to a phase-level invariant.

### 17-01: Drive timeout
- All 4 helpers abort within ~30s on a hung gaxios call → R17-01 ✓
- Non-timeout errors propagate immediately (404, 403, 5xx) → R17-01 corollary ✓
- Audit `--all` completes in bounded time → R17-01 phase-level smoke ✓

### 17-02: Per-color supplier-canonical
- `resolveSupplierCanonical(pid, colorName)` filters S&S response → R17-02 ✓
- Backward compat (no colorName arg) preserved → R17-02 corollary ✓
- All 3 call sites (audit, fix, manual) thread colorName → R17-02 integration ✓
- ≥ 1 BR_WRITE on re-run of 2026-05-14 verifier-rejected color-mismatch pids → R17-02 yield ✓

### 17-03: Model image rebuild
- Standalone script (NOT a Tier 4 inside fix-image-pollution.ts) → D-17-01 ✓
- 10-pid sample-test gate ≥ 7/10 verifier pass → D-17-02 ✓
- Full 213-pid run produces `model_fail_after_count < 50` → R17-03 acceptance ✓
- T-16-01 compare-before-trash on every Drive write → safety invariant ✓
- `tier=4` trail rows distinguishable from Phase 16 → operator observability ✓

### 17-04: Prefix dispatcher widening
- adidas A* / CE* + KNOWN_SUPPLIER_PREFIXES pids route via S&S → R17-04 ✓
- H08 invariant preserved (D-22 — headwear out of scope) → safety ✓
- 714 "no canonical" trail rows → ≤ 100 → R17-04 yield ✓
- Existing S* + L* routing unchanged → backward compat ✓

### 17-05: Manual triage
- Manual queue size ≤ 20 (R6 hard cap honored) → R17-05 ✓
- Operator walks every queue pid → R17-05 completeness ✓
- Phase closes per Phase 16 R10 OR-path → phase-level ✓
- Residue ≤ 5 truly unresolvable pids documented → operational ✓

### 17-06: B-2 dry-run trash gate
- `--dry-run` blocks both delete-handler + replace-handler Drive trash → R17-06 ✓
- Live mode unchanged → backward compat ✓
- Logger info announces would-have-trashed → operator observability ✓

### 17-07: B-3 cleanup MANUAL/ scan
- Cleanup scans both CHECKPOINT-TEST/ AND MANUAL/CHECKPOINT-TEST-*/ → R17-07 ✓
- Real operator MANUAL/<production-pid>/ data untouched (exact-name match) → safety ✓
- MANUAL/ root folder NEVER trashed → safety ✓
- Idempotent re-run → operational ✓

### 17-08: B-4 OpenAI billing-limit short-circuit
- First billing-hit detection sets `__billingExhausted` once → R17-08 ✓
- Subsequent pids short-circuit, no API call → R17-08 ✓
- TIER2_BUDGET_EXHAUSTED rows per skipped pid → trail observability ✓
- `status: 'BILLING_LIMIT_HIT'` in JSON summary → operator signal ✓
- TIER2_BUDGET_EXHAUSTED non-terminal → resume retry-eligibility (Open Question 6) ✓

## Wave Execution Order

Reflects the dependency graph + file-conflict rules. Wave-N plans run in parallel within the wave; Wave N+1 waits for all Wave N to complete.

| Wave | Plans | Rationale |
|------|-------|-----------|
| **1** | 17-01, 17-06, 17-07, 17-08 | All four touch disjoint files (`drive.ts`, `fix-image-pollution-manual.ts`, `cleanup-checkpoint-test-data.ts`, `fix-image-pollution.ts` + `image-pollution-trail.ts`). 17-01 is the blocking pre-req for Waves 2-4 (audits/fixes can't run reliably without timeout). 17-06/07/08 are independent small patches that can ship anytime in Wave 1. |
| **2** | 17-02 | Depends on 17-01 (audits run as part of 17-02's verification). Modifies `supplier-canonical.ts` (file-conflict with 17-04). |
| **3** | 17-03, 17-04 | 17-03 depends on 17-01 + 17-02 (needs working Drive + per-color resolver). 17-04 depends on 17-01 + 17-02 (file-conflict with 17-02 forces sequencing) — touches `supplier-canonical.ts` AFTER 17-02 lands. 17-03 and 17-04 are parallel within Wave 3 (no file overlap: 17-03 creates a new file, 17-04 modifies supplier-canonical.ts). |
| **4** | 17-05 | Operator triage of residue. Depends on every other plan shipping so the residue is as small as possible. Manual / interactive. |

## Phase-Close Acceptance Gates (R10 OR-path from Phase 16)

Phase 17 closes when EITHER:

- **OR-A**: Final re-audit on the original 213-pid corpus reports 0 polluted pids.
- **OR-B**: Every original-polluted pid (213) has a `BR_WRITE` or `MANUAL_SKIP` or `MANUAL_ACCEPT` row in the trail TSV — i.e., every pid was processed and the operator/system made an explicit decision.

If neither holds, Phase 17 cannot close. Recommended action: run `/gsd-plan-phase 17 --gaps` to plan a residue-closure follow-up.

## Failure-Mode Recovery

| Failure | Recovery |
|---------|----------|
| 17-01 tests fail (gaxios timeout option not honored as expected) | Fall back to AbortController wrapper from `src/shopify/image-standardizer.ts:244-259` (proven pattern). |
| 17-03 Task 2 sample-test < 7/10 | STOP. Replan verifier strategy for Model* (e.g., relax `verifySameProduct` threshold for Model class; or use Phase 15's `verifyGarmentTypeMatch` instead). |
| 17-04 unexpected: adidas A* pids don't resolve via S&S `/styles/?search=` | A17-3 risk realized. Build a brand-pid → S&S-styleID mapping table inside `routesViaSS` as a manual fallback. Document in 17-04-SUMMARY. |
| Tier 2 budget exhausted mid-17-03 full run | 17-08's short-circuit kicks in; trail records TIER2_BUDGET_EXHAUSTED per skipped pid; operator tops up OpenAI billing; re-runs with `--skip-sample-gate`; `loadProcessedPids` skips already-fixed pids. |
| Manual queue > 20 after Wave 3 | R6 hard cap triggers: `scripts/fix-image-pollution.ts` exits with code 2 + `status: 'BLOCKED-QUEUE-OVERFLOW'`. Operator inspects the overflow TSV, decides whether to broaden 17-04 (add brand entries) or accept the cap miss with a documented rationale. |

## Operator-Facing Runbook (compressed)

```
# Wave 1 (parallel)
/gsd-execute-phase 17  # ships 17-01, 17-06, 17-07, 17-08

# Wave 2
/gsd-execute-phase 17  # ships 17-02

# Wave 3 (parallel)
/gsd-execute-phase 17  # ships 17-04
/gsd-execute-phase 17  # ships 17-03 Task 1 (script); pauses at Task 2 checkpoint
# Operator runs the sample-test:
NODE_OPTIONS=--use-system-ca npx tsx scripts/fix-model-images.ts --sample-only \
  --audit-file tmp/image-pollution-audit-2026-05-13.tsv --max-cost 1
# Operator reviews tmp/fix-model-images-sample-{today}.json
# If sample_pass_rate >= 0.7: resume with `approved`. Else: replan.
/gsd-execute-phase 17  # ships 17-03 Task 3 (full run)

# Wave 4 (operator-driven)
/gsd-execute-phase 17  # 17-05 Task 1: operator runs full audit + fix + model rebuild
/gsd-execute-phase 17  # 17-05 Task 2: operator walks manual queue interactively

# Phase close
# Verify R10 OR-path: either re-audit=0 or every original-polluted pid has BR_WRITE/MANUAL_SKIP/MANUAL_ACCEPT trail row.
```
