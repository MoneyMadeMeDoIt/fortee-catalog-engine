---
phase: 10-ai-image-generation
plan: 01
subsystem: ai-image-core
tags: [ai, image-generation, cost-tracking, hue-detection, prompt-templates]
dependency_graph:
  requires: []
  provides: [ai-image-types, hue-utils, cost-tracker, prompt-templates]
  affects: [10-02-ai-image-generator]
tech_stack:
  added: [openai@6.33.0]
  patterns: [TDD red-green, vitest unit tests, sharp.stats().dominant for hue extraction]
key_files:
  created:
    - src/lib/ai-image-types.ts
    - src/lib/hue-utils.ts
    - src/lib/cost-tracker.ts
    - src/lib/prompt-templates.ts
    - tests/lib/hue-utils.test.ts
    - tests/lib/cost-tracker.test.ts
    - tests/lib/prompt-templates.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "sharp.stats().dominant bins values in a 4096-bin histogram; test assertions for raw RGB values must use toBeGreaterThan/LessThan, not toBe exact"
  - "CostTracker.estimateCost(n) uses simple arithmetic: n * CANDIDATES_PER_CALL * COST_PER_IMAGE (D-08 minimum estimate, no retry cost)"
  - "Hue for pure red (rgbToHue(255,0,0)) returns 0 by HSL convention; hueDrift(10,350)=20 via circular distance"
metrics:
  duration_seconds: 193
  completed_date: "2026-03-26"
  tasks_completed: 2
  tasks_total: 2
  test_files_created: 3
  tests_total: 57
  source_files_created: 4
---

# Phase 10 Plan 01: Foundational AI Image Types, Utilities, and Prompt Templates Summary

**One-liner:** Pure-logic foundation for AI image generation — HSL hue drift detection (AIGEN-04), $200 budget-capped CostTracker with dry-run estimation (D-07/D-08), garment-type-aware prompt templates (D-01/D-02/D-04/D-05), and openai@6.33.0 installed.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Types, hue utilities, and cost tracker with tests | 0950570 | src/lib/ai-image-types.ts, src/lib/hue-utils.ts, src/lib/cost-tracker.ts, tests/lib/hue-utils.test.ts, tests/lib/cost-tracker.test.ts |
| 2 | Prompt templates with tests and OpenAI SDK install | 9dde66d | src/lib/prompt-templates.ts, tests/lib/prompt-templates.test.ts, package.json |

## What Was Built

### `src/lib/ai-image-types.ts`
Exports all constants and interfaces used across the Phase 10 pipeline:
- `AIView = 'back' | 'side'` — AI only generates these; front is sourced
- `GenerateViewResult`, `EnhanceFrontResult` interfaces
- `COST_PER_IMAGE = 0.042`, `MAX_CALLS_PER_VIEW = 6`, `CANDIDATES_PER_CALL = 3`
- `HUE_DRIFT_THRESHOLD = 15`, `ACHROMATIC_THRESHOLD = 25`, `DEFAULT_BUDGET = 200`

### `src/lib/hue-utils.ts`
HSL hue utilities for color drift detection (AIGEN-04):
- `rgbToHue(r,g,b)` — standard HSL conversion, returns 0 for achromatic
- `hueDrift(hue1, hue2)` — circular angular distance, correctly wraps at 360
- `isAchromatic({r,g,b})` — true when max-min < 25 (ACHROMATIC_THRESHOLD)
- `extractDominantHue(buffer)` — uses `sharp(buffer).stats().dominant`; returns `{hue, achromatic, rgb}`

### `src/lib/cost-tracker.ts`
In-memory cost tracker enforcing global $200 budget cap (D-07):
- `canAfford(cost)` — pre-call budget check (non-strict, exact budget allowed)
- `record(cost)` — accumulates spend
- `estimateViewCost()` — 3 × $0.042 = $0.126 per API call
- `estimateCost(viewsNeeded)` — D-08 dry-run: viewsNeeded × 3 × $0.042

### `src/lib/prompt-templates.ts`
Garment-type-aware prompt templates for all CategoryGroup × AIView combinations:
- `PROMPT_TEMPLATES` — initial generation prompts with `{color}` placeholder
- `RETRY_PROMPT_TEMPLATES` — stronger retry prompts with doubled `{color}` emphasis (D-04)
- `CLEANUP_PROMPT` — front image enhancement prompt (D-05)
- `buildPrompt(garmentType, view, colorName)` — replaces all `{color}` occurrences
- `buildRetryPrompt(garmentType, view, colorName)` — same for retry templates

## Test Results

57 tests total across 3 new test files. All pass.

| File | Tests | Result |
|------|-------|--------|
| tests/lib/hue-utils.test.ts | 20 | PASS |
| tests/lib/cost-tracker.test.ts | 15 | PASS |
| tests/lib/prompt-templates.test.ts | 22 | PASS |

Full suite: 307 tests, 0 failures (no regressions).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed overly strict RGB assertion for extractDominantHue test**
- **Found during:** Task 1 GREEN phase
- **Issue:** Test asserted `result.rgb.r === 255` but sharp's 4096-bin histogram bins the dominant color, returning 248 for a pure red 1x1 pixel
- **Fix:** Changed to `toBeGreaterThan(240)` / `toBeLessThan(20)` range assertions — still validates the dominant color is clearly red, just not pixel-exact
- **Files modified:** tests/lib/hue-utils.test.ts
- **Commit:** 0950570 (included in same commit)

## Known Stubs

None. All exports are fully implemented with real logic.

## Self-Check: PASSED

Files confirmed present:
- src/lib/ai-image-types.ts: FOUND
- src/lib/hue-utils.ts: FOUND
- src/lib/cost-tracker.ts: FOUND
- src/lib/prompt-templates.ts: FOUND
- tests/lib/hue-utils.test.ts: FOUND
- tests/lib/cost-tracker.test.ts: FOUND
- tests/lib/prompt-templates.test.ts: FOUND

Commits confirmed:
- 0950570: FOUND
- 9dde66d: FOUND
