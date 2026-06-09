# Phase 17 — Deferred test failures

Pre-existing test failures observed during Plan 17-07 execution. Confirmed
present on master before 17-07 started (verified by running the same tests
against pristine master). NOT caused by 17-07 changes; explicitly out of
scope per the executor scope-boundary rule.

## Failing tests (9 total in 4 files)

### tests/lib/garment-type-verifier.test.ts
- Whole file failed (transform/load error or top-level failure).

### tests/lib/ai-image-generator.test.ts — 6 failures
- generateGarmentView — Phase 15 type-match > R1: returns the only type-passing candidate even when others have higher quality
- generateGarmentView — Phase 15 type-match > R3a: strict AND triggers round 2 when no candidate passes both hue AND type
- generateGarmentView — Phase 15 type-match > R3b: no retry when one candidate passes BOTH hue and type
- generateGarmentView — Phase 15 type-match > R4: writes to rejects TSV and returns null when ALL 6 candidates fail type-match
- generateGarmentView — Phase 15 type-match > R5: CostTracker.record is called only by images.edit — never by the verifier
- generateGarmentView — Phase 15 type-match > verifier API failure: candidate is treated as type-passing (fallback match=true)

### tests/lib/audit-runner.test.ts — 2 failures
- auditProductImages > Test 2 (missing-back): sources back view when BackImage is empty
- auditProductImages > Test 4 (ai-generation): calls generateGarmentView when sourceImages returns null for back

### tests/shopify/metaobjects.test.ts — 1 failure
- getExistingPrintAreaGids > calls metaobjectByHandle for front-dtf and back-print with type print_area
  - Expected `type: 'print_area'`, received `type: 'print_areas'` (singular vs plural string mismatch — pre-existing source/test drift, NOT something 17-07 touched).

## Why deferred

- These tests are in files not touched by Plan 17-07.
- Failures reproduce on pristine master (verified before starting Task 1).
- Root cause likely belongs to Phase 15 (garment-type / AI generator) and an
  unrelated Shopify metaobjects refactor — out of scope for this B-3 patch.

## Recommendation

Open a follow-up plan or sweep to address these failures separately. They are
NOT regressions from 17-07.

---

## Update from Plan 17-04 execution (2026-05-14)

Full suite (`npx vitest run --exclude '.claude/worktrees/**'`) reported:
- 525 tests passing
- 2 suite-level failures, both pre-existing and unrelated to 17-04:

### tests/scripts/fix-model-images.test.ts
- Cannot find module `scripts/fix-model-images.js` — this test file ships ahead
  of its production source. Plan 17-03 (running in parallel) creates that
  script; once 17-03 lands the import resolves.
- NOT caused by 17-04 (which only touches `src/lib/supplier-canonical.ts` and
  `tests/lib/supplier-canonical.test.ts`).

### tests/lib/garment-type-verifier.test.ts
- Same pre-existing failure documented above (missing `OPENAI_API_KEY` env at
  module-load time).

Both deferred — out of scope for 17-04.
