---
phase: 19-ai-category-keyword-generation
plan: "01"
subsystem: category-schema
tags: [tdd, pure-module, zod, keyword-validation, decoration-contract]
dependency_graph:
  requires: [src/shopify/variants.ts]
  provides: [scripts/lib/category-schema.ts]
  affects: [scripts/lib/category-schema.test.ts]
tech_stack:
  added: [zod v4 (already in deps)]
  patterns: [TDD RED/GREEN, closed-enum schema, part-split blocklist]
key_files:
  created:
    - scripts/lib/category-schema.ts
    - scripts/lib/category-schema.test.ts
  modified: []
decisions:
  - "SAFE_BASE_CATEGORIES = 9 safe controlled-vocab + Crewneck Sweatshirt + 8 SUPPORTED_CATEGORIES (18 members total, all non-null verified)"
  - "isCleanKeyword splits by hyphen to check parts against blocklists — catches size-xl (xl blocked) without digit rule"
  - "buildPrompt returns plain string; no SDK coupling in this module (wired in 19-02)"
metrics:
  duration: "~10 min"
  completed: "2026-06-10"
  tasks_completed: 2
  files_created: 2
---

# Phase 19 Plan 01: Category Schema Core Summary

Pure, network-free Zod schema + helpers proving every SAFE_BASE_CATEGORIES member resolves non-null via getCategoryGroup(), with isCleanKeyword/sanitizeForPrompt/buildPrompt for the 19-02 I/O script.

## Tasks Completed

| Task | Name | Commit |
|------|------|--------|
| RED  | Decoration-safe baseCategory enum tests + schema/keyword/sanitize/buildPrompt tests | 861f017 |
| GREEN | Implement category-schema.ts source module | 3d62b74 |

## Artifacts

- `scripts/lib/category-schema.ts` (289 lines) — exports: SAFE_BASE_CATEGORIES, TAXONOMY_LEAF_PATHS, categorySchema, isCleanKeyword, sanitizeForPrompt, buildPrompt, BLOCKED_COLORS, BLOCKED_SIZES, BLOCKED_JARGON
- `scripts/lib/category-schema.test.ts` (355 lines) — 77 tests, all passing

## Test Output

```
 ✓ scripts/lib/category-schema.test.ts (77 tests) 14ms
 Test Files  1 passed (1)
       Tests  77 passed (77)
    Duration  349ms
```

## SAFE_BASE_CATEGORIES (18 members)

All 18 members verified non-null via getCategoryGroup():

| Value | getCategoryGroup result | Source |
|-------|------------------------|--------|
| T-Shirts | tops | controlled-vocab |
| Long Sleeve Shirts | tops | controlled-vocab |
| Polo Shirts | polos | controlled-vocab |
| Tank Tops | tops | controlled-vocab |
| Hoodies | hoodies | controlled-vocab |
| Jackets | jackets | controlled-vocab |
| Vests | jackets | controlled-vocab |
| Youth T-Shirts | tops | controlled-vocab |
| Youth Hoodies | hoodies | controlled-vocab |
| Crewneck Sweatshirt | crewnecks | safe replacement for bare 'Sweatshirts' |
| T-Shirts - Premium | tops | SUPPORTED_CATEGORIES |
| T-Shirts - Core | tops | SUPPORTED_CATEGORIES |
| T-Shirts - Long Sleeve | tops | SUPPORTED_CATEGORIES |
| T-shirts/Shorts/Polos | tops | SUPPORTED_CATEGORIES |
| Fleece - Premium - Hood | hoodies | SUPPORTED_CATEGORIES |
| Fleece - Core - Hood | hoodies | SUPPORTED_CATEGORIES |
| Fleece - Premium - Crew | crewnecks | SUPPORTED_CATEGORIES |
| Fleece - Core - Crew | crewnecks | SUPPORTED_CATEGORIES |

Excluded (null-resolving): Sweatshirts, Caps, Beanies, Bags, Shorts, Sweatpants — regression guards in test suite.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. T-19-01 and T-19-02 mitigations both implemented: sanitizeForPrompt strips injection chars; categorySchema constrains baseCategory to closed enum.

## Self-Check: PASSED

- scripts/lib/category-schema.ts — FOUND
- scripts/lib/category-schema.test.ts — FOUND
- commit 861f017 — FOUND
- commit 3d62b74 — FOUND
