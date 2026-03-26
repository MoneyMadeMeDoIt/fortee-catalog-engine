---
phase: 09-image-sourcing
plan: "01"
subsystem: image-pipeline
tags: [image-sourcing, suppliers, omg, csw, ss-canada, quality-scoring, parallel-fetch]
dependency_graph:
  requires:
    - src/shopify/image-scorer.ts
    - src/shopify/image-standardizer.ts
    - src/lib/onesource-client.ts
    - src/lib/logger.ts
  provides:
    - src/lib/image-sourcer.ts
  affects:
    - Phase 10 (AI generation uses sourceImages output as input)
    - Phase 12 (product push calls sourceImages per color)
tech_stack:
  added: []
  patterns:
    - Promise.allSettled for parallel supplier fetch with fault isolation
    - Score-before-return pattern (download buffer, score, return URL only)
    - OMG OneSource classType ID view classification (1001/1006/1007/1008/1009/1010)
    - S&S Canada REST API (api.ssactivewear.com/v2/products/) Basic auth with graceful credential check
    - CSW Shopify storefront search + .json endpoint (front-only)
key_files:
  created:
    - src/lib/image-sourcer.ts
    - tests/suppliers/image-sourcer.test.ts
  modified: []
decisions:
  - "pickBest returns best-scoring candidate regardless of verdict — failed images returned for Phase 10 AI enhancement (D-03)"
  - "Promise.allSettled used over Promise.all — one supplier failure does not block others (D-01)"
  - "colorName optional parameter added to sourceImages() and fetchOMGImages() to support Phase 12 per-color calls (from RESEARCH.md open question)"
  - "S&S images use _fl (large) suffix by replacing _fm — maximizes resolution for scoring"
metrics:
  duration_seconds: 219
  completed_date: "2026-03-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 09 Plan 01: Image Sourcer Implementation Summary

**One-liner:** Parallel three-supplier image sourcer with quality-score winner selection using OMG OneSource classType IDs, CSW Shopify storefront search, and S&S Canada REST API with graceful credential degradation.

## What Was Built

`src/lib/image-sourcer.ts` — the `sourceImages(styleId, colorName?)` orchestrator that fetches front/back/side image candidates from all three suppliers in parallel and returns the highest-scoring candidate per view. Supporting functions `pickBest`, `fetchOMGImages`, `fetchCSWImages`, and `fetchSSCanadaImages` implement the per-supplier logic with independent error handling.

`tests/suppliers/image-sourcer.test.ts` — 27 unit tests covering all four requirement IDs (SRC-01 through SRC-04) and key decisions (D-01 through D-06), using vi.mock for all external dependencies.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create image-sourcer.ts | 2f0f3ab | src/lib/image-sourcer.ts |
| 2 | Create unit tests | 23a7a8f | tests/suppliers/image-sourcer.test.ts |

## Verification Results

1. `npx tsc --noEmit` — no errors in image-sourcer.ts (pre-existing errors in other files are out of scope)
2. `npm run test -- tests/suppliers/image-sourcer.test.ts` — 27/27 tests pass
3. `npm run test` — 250/250 tests pass (no regressions)
4. `grep -c "Promise.allSettled" src/lib/image-sourcer.ts` — returns 1
5. `grep -c "pickBest" src/lib/image-sourcer.ts` — returns 4 (definition + 3 usages in sourceImages)

## Deviations from Plan

### Auto-added: colorName parameter threading to fetchOMGImages

**Found during:** Task 1 implementation
**Reason:** The plan spec defined `sourceImages(styleId, colorName?)` with colorName, but the original fetchOMGImages stub in the action block only accepted `styleId`. Per RESEARCH.md open question 1, Phase 12 will call `sourceImages` per-color. Threading the `colorName` through to `fetchOMGImages` avoids a future breaking change.
**Fix:** `fetchOMGImages` accepts `colorName?: string` and filters media items by color field when provided.
**Files modified:** src/lib/image-sourcer.ts (already within plan scope)
**Rule:** Rule 2 (auto-add missing critical functionality)

## Known Stubs

None — all three supplier fetchers are fully implemented and wired. The S&S Canada fetcher gracefully degrades to `{}` when `SS_ACCOUNT_NUMBER`/`SS_API_KEY` are absent (by design per D-01).

## Self-Check: PASSED

- FOUND: src/lib/image-sourcer.ts
- FOUND: tests/suppliers/image-sourcer.test.ts
- FOUND: commit 2f0f3ab (feat(09-01): create image-sourcer.ts)
- FOUND: commit 23a7a8f (test(09-01): add comprehensive unit tests)
