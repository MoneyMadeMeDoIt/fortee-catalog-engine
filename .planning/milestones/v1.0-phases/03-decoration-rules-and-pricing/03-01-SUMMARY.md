---
phase: 03-decoration-rules-and-pricing
plan: 01
subsystem: business-rules
tags: [decoration, pricing, zod, vitest, typescript]

requires:
  - phase: 01-supplier-data-extraction
    provides: "Supplier product data with baseCategory field"
provides:
  - "DecorationPlacement type and 38 placement rules from Print Areas guide"
  - "calculateSellPrice pure function with verified pricing formula"
  - "resolveCategory function mapping supplier categories to canonical garment categories"
  - "PricingInputSchema Zod validation"
  - "estimateStitchCount helper"
affects: [03-02-decoration-enrichment, 04-shopify-product-creation]

tech-stack:
  added: []
  patterns: ["Static business rules as typed constants", "Pure pricing function with no side effects", "Category alias normalization layer"]

key-files:
  created:
    - src/decoration/types.ts
    - src/decoration/rules.ts
    - src/decoration/category-map.ts
    - src/decoration/pricing.ts
    - src/decoration/index.ts
    - tests/decoration/rules.test.ts
    - tests/decoration/category-map.test.ts
    - tests/decoration/pricing.test.ts
  modified: []

key-decisions:
  - "38 placements codified as typed constants from Print Areas Placement Guide XLSX"
  - "Body location mapping: garment categories map to body location groups (Front/Back/Sleeve/Hoodie/Pants/Headwear)"
  - "Embroidery threshold at 8000 stitches: flat $20 below, formula-based above"

patterns-established:
  - "Static rule data as typed TypeScript constants in src/decoration/"
  - "Pure functions for business calculations (no side effects, easy to test)"
  - "TDD workflow: RED (failing tests) -> GREEN (implementation) -> verify"

requirements-completed: [DECOR-01, DECOR-02, PRICE-01]

duration: 4min
completed: 2026-03-06
---

# Phase 3 Plan 1: Decoration Rules and Pricing Summary

**38 decoration placements from Print Areas guide codified as typed constants, pricing calculator verified against reference case ($14.08), and supplier category resolver with 20+ aliases**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-06T11:08:56Z
- **Completed:** 2026-03-06T11:12:54Z
- **Tasks:** 2
- **Files created:** 8

## Accomplishments
- All 38 decoration placements from the Print Areas Placement Guide encoded as typed TypeScript constants with body location tagging
- Pricing calculator produces correct sell price for reference case ($7.80 garment, 1 print, 45% discount = $14.08 sell price, 44.6% gross margin)
- Category resolver maps 20+ supplier baseCategory strings to 7 canonical garment categories
- 37 decoration-specific tests + 100 total tests passing with zero regressions

## Task Commits

Each task was committed atomically (TDD: test then feat):

1. **Task 1: Types, decoration rules, and category map**
   - `a51adaa` (test: failing tests for rules and category map)
   - `61d951f` (feat: implement types, rules, category map)
2. **Task 2: Pricing calculator and barrel export**
   - `1f08bfd` (test: failing tests for pricing calculator)
   - `8e80ab3` (feat: implement pricing calculator and barrel export)

## Files Created/Modified
- `src/decoration/types.ts` - DecorationMethod, GarmentCategory, DecorationPlacement, PricingInput, PricingResult types + Zod schema
- `src/decoration/rules.ts` - ALL_PLACEMENTS (38 entries), CATEGORY_TO_BODY_LOCATIONS mapping, getDecorationRulesForCategory function
- `src/decoration/category-map.ts` - CATEGORY_ALIASES (20+ entries), resolveCategory function
- `src/decoration/pricing.ts` - calculateSellPrice pure function, estimateStitchCount helper
- `src/decoration/index.ts` - Barrel export for public API
- `tests/decoration/rules.test.ts` - 9 tests for decoration rule lookup by category
- `tests/decoration/category-map.test.ts` - 11 tests for category resolution
- `tests/decoration/pricing.test.ts` - 17 tests for pricing formula + validation

## Decisions Made
- Body location groups mapped per garment category (e.g., T-Shirt gets Front+Back+Sleeve, Hoodie adds Hoodie-specific placements) per research Pattern 3 and Pitfall 2
- Embroidery cost threshold at exactly 8000 stitches (inclusive) uses flat $20/area rate
- Stitch estimator formula uses 1200 stitches per square inch at configurable coverage percentage

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Decoration rules module ready for Plan 02 to extend the enrichment pipeline
- Plan 02 will use getDecorationRulesForCategory + resolveCategory to populate sheet columns
- Plan 02 will use calculateSellPrice to write pricing data to the sheet

---
*Phase: 03-decoration-rules-and-pricing*
*Completed: 2026-03-06*
