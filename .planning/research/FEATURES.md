# Feature Landscape

**Domain:** Product curation/filtering for wholesale apparel catalog
**Researched:** 2026-03-31
**Scope:** Catalog curation system only (reducing 941 styles to ~200-300)

---

## Table Stakes

Features that are essential -- without these, the curation output is not usable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Style-level aggregation | Sheet has 43K rows (color x size combos); scoring must operate at style level (941 unique styles) | Low | Group by `styleID`, compute per-style metrics |
| Color count per style | More colors = more versatile for custom decoration = key differentiator | Low | `COUNT(DISTINCT colorName) GROUP BY styleID` |
| Size range breadth | XS-5XL beats S-XL for corporate/team orders | Low | Parse `sizeName` values, compute range span |
| Stock availability score | Styles with zero stock across many SKUs are risky to list | Low | `SUM(Qty) GROUP BY styleID` |
| Category coverage enforcement | Cannot have 200 t-shirts and 0 jackets in the curated set | Medium | Define minimum per-category quotas |
| Brand balance enforcement | Cannot over-represent Gildan and drop Under Armour entirely | Medium | Define minimum per-brand quotas |
| Price tier representation | Each category needs budget, mid, and premium options | Medium | Bucket by `costPrice` into tiers, enforce at least 1 per tier per category |
| Gender coverage | Must have men's, women's, and unisex options per category | Low | Use `gender` field; enforce minimum representation |
| Composite scoring formula | Single score per style combining all signals | Medium | Weighted formula with configurable weights |
| Output with keep/drop decisions | The user needs to see the list and manually approve before acting | Low | Write to new sheet tab or export CSV |

## Differentiators

Features that improve the quality of curation but are not strictly required.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Industry bestseller overlay | Known popular styles (BC 3001, G64000, NL 3600) get score bonuses | Low | Hardcoded list of ~30-50 known bestsellers |
| Closeout exclusion | S&S API `closeout` flag identifies dying products to exclude | Low | API call or scrape CSW closeouts page |
| Fabric composition diversity | Within a category, select across cotton/blend/poly/tri-blend | Medium | Parse `productName` or `description` for fabric type |
| Fit diversity within category | Avoid 5 identical "regular fit" selections per brand | Medium | Use `fit` field to enforce variety |
| Price tier gap analysis | Identify categories missing budget or premium options | Low | Report, not filter -- operator decides |
| "Why selected" reasoning | Each kept style includes a human-readable reason | Low | Concatenate contributing score factors |
| Re-run capability | Same script, same data, same output (deterministic) | Low | No randomness in scoring; pure function of inputs |
| Configurable weights | Operator can tune scoring weights without editing code | Medium | JSON config file validated with Zod |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Automated catalog pruning (delete from sheet) | Too destructive; no undo | Output a recommendation list; operator acts manually |
| Real-time sales data integration | No sales data exists; building the integration adds months of work | Use proxy signals (color count, stock, industry knowledge) |
| ML-based demand prediction | No training data, unpredictable behavior, hard to debug | Deterministic scoring formula with transparent weights |
| Web scraping popularity from supplier sites | Fragile, slow, signal is weak ("featured" != "popular") | Hardcoded industry bestseller list |
| Per-color/per-size scoring | Exponentially complex (43K rows vs 941 styles); not what the user asked for | Score at style level, include all colors/sizes of selected styles |
| Automated Shopify product unpublish | Irreversible in practice; needs human judgment | Output a "remove from store" recommendation list |

## Feature Dependencies

```
Style-level aggregation → Color count, Size range, Stock score, Price tier
Composite scoring formula → All per-style metrics computed
Category coverage enforcement → Composite scoring (selects within score-ranked styles)
Brand balance enforcement → Category coverage (nested constraint)
Output with keep/drop → All scoring and filtering complete
Industry bestseller overlay → Composite scoring (additive bonus)
Closeout exclusion → Style-level aggregation (pre-filter step)
```

## MVP Recommendation

Prioritize (in build order):
1. Style-level aggregation (foundation for everything)
2. Color count + Size range + Stock score computation
3. Composite scoring formula
4. Category and brand quota enforcement
5. Output list with scores and reasons

Defer:
- Fabric/fit diversity enforcement: Requires parsing unstructured text from `productName`/`description`; do manually in review for v1
- Closeout exclusion via API: Requires S&S API call; can be done manually from their website
- Configurable weights JSON: Hardcode weights first; make configurable after validating the formula works

## Target Catalog Size

Based on research into how custom apparel businesses structure their catalogs:

| Business | Approximate Catalog Size | Notes |
|----------|------------------------|-------|
| CustomInk | ~600 products | Large operation, multiple decoration methods, national reach |
| Printful | ~483 products | POD model, includes non-apparel (mugs, posters, etc.) |
| Typical small decorator | 50-150 styles | Focused on 3-5 categories, 2-4 brands |
| Fortee (recommended) | **200-300 styles** | 20 brands across all categories; needs broader selection than a typical small shop but not as wide as CustomInk |

**Recommended target: 250 styles** as the initial goal, broken down roughly as:

| Category | Approx. Target | Rationale |
|----------|---------------|-----------|
| T-Shirts (short sleeve) | 40-50 | ~48% of market; needs most options |
| Hoodies & Fleece | 30-40 | High margin, strong demand |
| Long Sleeve Tees | 15-20 | Seasonal bridge product |
| Polos | 20-25 | Corporate/uniform staple |
| Outerwear (jackets, vests) | 20-25 | High AOV, corporate demand |
| Bottoms (joggers, shorts) | 10-15 | Growing athleisure segment |
| Headwear (caps, beanies) | 15-20 | High margin accessory |
| Bags & Accessories | 10-15 | Lower volume, high margin |
| Youth | 10-15 | School/team orders |
| Tank Tops & Sleeveless | 10-15 | Seasonal but expected |
| **Total** | **~200-260** | |

**Should this be a one-time or recurring process?**
- Start as a **one-time curation** to establish the initial catalog
- Re-run **quarterly** when suppliers add new styles or discontinue old ones
- The script should be deterministic so re-running produces consistent results (only changes when data changes)

## Sources

- [CustomInk Product Catalog](https://www.customink.com/products/) -- ~600 products (MEDIUM)
- [Printful Product Catalog](https://www.printful.com/print-on-demand) -- 483 products (HIGH)
- [Hubventory: How to Curate a Retail Collection](https://hubventory.com/blog/how-to-curate-a-retail-collection-that-sells/) -- curation strategy principles (MEDIUM)
- Existing CATALOG-CURATION-REPORT.md -- market data, scoring model, category taxonomy (HIGH)

---
*Researched: 2026-03-31*
