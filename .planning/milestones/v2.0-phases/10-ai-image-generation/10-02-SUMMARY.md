---
phase: 10-ai-image-generation
plan: 02
subsystem: ai-image-generator
tags: [ai, image-generation, openai, hue-drift, cost-tracking, retry-logic, tdd]
dependency_graph:
  requires: [10-01]
  provides: [generateGarmentView, enhanceFrontImage, callImagesEdit]
  affects: [phase-12-audit-runner]
tech_stack:
  added: []
  patterns: [TDD red-green, vitest unit tests with vi.mock, dependency injection for testability]
key_files:
  created:
    - src/lib/ai-image-generator.ts
    - tests/lib/ai-image-generator.test.ts
  modified: []
decisions:
  - "vi.clearAllMocks() in vitest 4.x clears call history but NOT mockResolvedValueOnce queues; tests using Once items must consume all queued items or avoid leaving pending ones for subsequent tests"
  - "Achromatic front images skip extractDominantHue calls for candidates entirely (not just skip comparison) — Once queue items for candidates must not be set when testing achromatic bypass"
  - "callImagesEdit accepts optional OpenAI client parameter for dependency injection (avoids mocking createOpenAIClient)"
metrics:
  duration_seconds: 858
  completed_date: "2026-03-26"
  tasks_completed: 1
  tasks_total: 1
  test_files_created: 1
  tests_total: 12
  source_files_created: 1
---

# Phase 10 Plan 02: AI Image Generator Core Functions Summary

**One-liner:** generateGarmentView() and enhanceFrontImage() using OpenAI images.edit() with 3-candidate selection, 15-degree hue drift rejection, retry logic, D-04 best-of-6 fallback, $200 budget enforcement, achromatic bypass, and content policy handling.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | generateGarmentView and enhanceFrontImage with mocked tests | b07dcf4 | src/lib/ai-image-generator.ts, tests/lib/ai-image-generator.test.ts |

## What Was Built

### `src/lib/ai-image-generator.ts`

The core AI image generation module for Phase 10. Exports two public functions:

**`generateGarmentView(frontBuffer, view, garmentType, colorName, costTracker, client?)`**
- Pre-flight budget check via `costTracker.canAfford(CANDIDATES_PER_CALL * COST_PER_IMAGE)` — returns null if exhausted (D-07)
- Extracts front image dominant hue via `extractDominantHue(frontBuffer)` for color drift comparison (AIGEN-04)
- Round 1: calls `images.edit()` with `n=3`, `buildPrompt()`, records cost, scores all candidates
- Filters by hue drift ≤ 15 degrees (`HUE_DRIFT_THRESHOLD`); picks highest-quality passing candidate (AIGEN-02/D-03)
- Achromatic front images bypass hue check entirely — candidates accepted on quality score alone
- Round 2 (retry): if all 3 candidates fail hue, retries with `buildRetryPrompt()` (D-04)
- D-04 fallback: if all 6 candidates fail, returns best-scoring candidate from all 6 regardless
- Content policy errors (`OpenAI.BadRequestError` with 'content_policy' or 'safety') return 0 candidates (not a throw)
- Input image resized to 1024x1024 PNG via sharp before API call (avoids 413 errors)

**`enhanceFrontImage(frontBuffer, costTracker, garmentType?, client?)`**
- Uses `CLEANUP_PROMPT` with `n=1` to clean up a failing front image (D-05)
- Budget check before call; returns null if exhausted
- Returns `EnhanceFrontResult` with scored buffer

**`callImagesEdit(client, inputBuffer, prompt, n)` (internal)**
- Resizes to 1024x1024, calls `images.edit()` with ONLY: model, image, prompt, n, size, quality
- No `response_format`, `input_fidelity`, or `output_format` (per research anti-patterns)
- Handles partial results (`filter(img => img.b64_json != null)`)
- Content policy → empty array; other errors → re-throw

### `tests/lib/ai-image-generator.test.ts`

12 unit tests with fully mocked OpenAI client. No real API calls.

| Test | Covers |
|------|--------|
| AIGEN-01 basic generation | images.edit() called, buffer returned with correct callCount/usedRetry |
| AIGEN-02 highest-score | Score=90 selected over 60 and 70 |
| AIGEN-02 hue rejection | Candidate with drift=25 skipped; best of remaining returned |
| AIGEN-04 retry on all-fail | usedRetry=true, callCount=2, retry candidate returned |
| D-04 best-of-6 fallback | All 6 fail hue; best-scored returned regardless |
| D-07 budget exhaustion | Returns null; images.edit never called |
| Achromatic bypass | Hue check skipped; best quality candidate returned |
| Content policy error | 0 candidates from both calls; returns null |
| AIGEN-03 enhanceFrontImage | n=1, scored buffer returned |
| enhanceFrontImage budget | Returns null when budget insufficient |
| Cost tracking | record() called once with 3*0.042=0.126 |
| API params | No response_format/input_fidelity/output_format in call args |

## Test Results

12 tests in new file. Full suite: 319 tests, 0 failures.

| File | Tests | Result |
|------|-------|--------|
| tests/lib/ai-image-generator.test.ts | 12 | PASS |
| Full suite (all 26 test files) | 319 | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed vitest 4.x mock contamination via leftover mockResolvedValueOnce queue**
- **Found during:** TDD GREEN phase (cost tracking test failing — `record` called twice)
- **Issue:** The achromatic bypass test set `mockResolvedValueOnce × 4` (for front + 3 candidates) but only consumed 1 (front), leaving 3 pending `Once` items. `vi.clearAllMocks()` clears call HISTORY but not the `onceMockImplementations` queue. These 3 leftovers caused subsequent `extractDominantHue` calls in the cost tracking test to return unexpected hues, failing hue checks and triggering the retry round.
- **Fix:** Changed achromatic test to only set `mockResolvedValueOnce` for the front call. Candidates' hue extraction is skipped when front is achromatic — no candidate `Once` items needed.
- **Files modified:** tests/lib/ai-image-generator.test.ts
- **Commit:** b07dcf4 (included in same commit)

**2. [Rule 1 - Bug] Fixed OpenAI mock constructor — vi.fn() is not a constructor**
- **Found during:** TDD GREEN phase (first test run after creating implementation)
- **Issue:** `vi.mock('openai')` factory used `vi.fn().mockImplementation(() => ({...}))` for the OpenAI class. `vi.fn()` creates a regular function, not a constructor. `new OpenAI(...)` in the implementation throws "not a constructor".
- **Fix:** Changed mock to use a proper `class OpenAI { ... }` declaration with `images` property and `static BadRequestError`.
- **Files modified:** tests/lib/ai-image-generator.test.ts
- **Commit:** b07dcf4 (included in same commit)

## Known Stubs

None. Both exported functions are fully implemented with real logic. The OpenAI client is created with `process.env.OPENAI_API_KEY` (no hardcoded credentials).

## Self-Check: PASSED

Files confirmed present:
- src/lib/ai-image-generator.ts: FOUND
- tests/lib/ai-image-generator.test.ts: FOUND

Commits confirmed:
- b07dcf4: FOUND
