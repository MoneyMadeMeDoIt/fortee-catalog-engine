---
phase: 12-audit-runner
plan: "01"
subsystem: lib/audit-runner
tags: [orchestration, pipeline, tdd, integration]
dependency_graph:
  requires:
    - src/shopify/image-scorer.ts
    - src/lib/image-sourcer.ts
    - src/lib/ai-image-generator.ts
    - src/shopify/image-standardizer.ts
    - src/sheets/writer.ts
    - src/shopify/variants.ts
    - src/lib/cost-tracker.ts
  provides:
    - auditProductImages()
    - AuditResult type
    - ViewAuditResult type
  affects:
    - Phase 13 CLI (will call auditProductImages directly)
tech_stack:
  added: []
  patterns:
    - TDD red-green with vitest 4.x mocks
    - Linear pipeline orchestration (Score → Source → Generate → Standardize → Write)
    - CostTracker dependency injection (never created internally)
    - Per-view non-fatal error handling with graceful continuation
key_files:
  created:
    - src/lib/audit-runner.ts
    - tests/lib/audit-runner.test.ts
  modified: []
decisions:
  - "sourceImages called at most once per product (not once per view) — source all missing/failing in a single batch"
  - "Default mocks for sourceImages/generateGarmentView/enhanceFrontImage added to setupDefaultMocks() to prevent undefined returns from breaking unrelated tests"
  - "Front buffer resolution is separate from back/side because back/side AI generation requires the resolved front buffer"
metrics:
  duration: "~4 minutes"
  completed_date: "2026-03-27"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase 12 Plan 01: Audit Runner Pipeline Summary

**One-liner:** Linear audit orchestrator wiring Phase 08-11 modules (score → source → generate/enhance → standardize → write) with per-view non-fatal error handling and budget-aware AI generation.

## What Was Built

`src/lib/audit-runner.ts` — the core integration function that Phase 13 CLI calls for each product row.

`auditProductImages()` implements the D-01 linear pipeline:
1. **Category resolution** — `getCategoryGroup()` with 'tops' fallback for unsupported categories; logs warning
2. **Score existing** — downloads each view URL from the SheetRow, calls `scoreImageQuality()`; download errors treated as missing (non-fatal)
3. **Source missing/failing** — `sourceImages()` called once per product (not per view) when any view needs it
4. **Resolve best buffer per view** — decision tree: pass-existing → sourced-pass → enhance (front) or generate (back/side) → sourced-fail fallback
5. **Standardize all** — `standardizeImage()` + `uploadStagedImage()` for every view that has a buffer (D-02: always re-standardize)
6. **Write CDN URLs** — `buildStandardizationUpdates()` + `writeUpdates()` to Google Sheets (D-04: no Shopify mutations)

## Tests

8 integration tests covering all orchestration behaviors:
- All-passing: standardize existing without sourcing/generating
- Missing back: sourceImages called, back sourced
- Failing front: enhanceFrontImage called, status 'enhanced'
- AI generation: generateGarmentView called when sourced returns null for back
- Budget exhausted: null from AI → status 'skipped', no throw
- Sheet write: correct sheetName, 0-based rowIndex, CDN URLs passed
- Null category: defaults to 'tops' with warning, no error
- Download error: existing URL failure → treated as missing, sourceImages called

Full test suite: 339 tests, all pass (no regressions).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing default sourceImages mock caused Test 3 to fail**
- **Found during:** Task 2 (GREEN phase) — first run
- **Issue:** `setupDefaultMocks()` didn't mock `sourceImages`, `generateGarmentView`, or `enhanceFrontImage`. Test 3 (failing-front) triggers sourcing, which returned `undefined`, causing a catastrophic error: `TypeError: Cannot read properties of undefined (reading 'front')`
- **Fix:** Added default mocks for all three AI/sourcing functions to `setupDefaultMocks()` — `sourceImages` returns `{ front: null, back: null, side: null }`, AI functions return `null` by default. Tests that need specific behavior override these defaults.
- **Files modified:** `tests/lib/audit-runner.test.ts`
- **Commit:** 0468b94 (included in the GREEN phase commit)

## Known Stubs

None — `auditProductImages()` is fully implemented and all behaviors are tested.

## Self-Check

- [x] `src/lib/audit-runner.ts` exists
- [x] `tests/lib/audit-runner.test.ts` exists with 8 tests
- [x] Commits 94f2ab6 (RED) and 0468b94 (GREEN) exist
- [x] All 8 tests pass
- [x] Full 339-test suite passes with no regressions
