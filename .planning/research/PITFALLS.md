# Domain Pitfalls: Catalog Curation System

**Domain:** Product curation/filtering for wholesale apparel catalog
**Researched:** 2026-03-31

## Critical Pitfalls

Mistakes that produce a visibly wrong or commercially damaging curated catalog.

### Pitfall 1: Brand Monopoly in Curated Output
**What goes wrong:** Raw score ranking produces a catalog dominated by 2-3 brands (typically Gildan + BELLA+CANVAS + Next Level) because they have the most colorways, widest size ranges, and highest stock. Smaller brands like Columbia, Under Armour, Devon & Jones are completely absent.
**Why it happens:** High-volume commodity brands naturally score highest on color count, size range, and stock -- the three largest scoring dimensions. Premium/specialty brands offer fewer colors (6-15 vs 30-50) but charge more and serve different customer segments.
**Consequences:** The curated catalog fails to serve corporate/premium customers who want Columbia jackets or Under Armour polos. The catalog loses its "full product line across all brands" value proposition.
**Prevention:** Enforce a per-brand minimum quota (e.g., at least 3 styles per brand if the brand has 5+ styles in the dataset). Apply brand-diversity bonus: each brand's Nth style gets a diminishing-returns penalty (1st style: no penalty, 5th style from same brand: -5 penalty, 10th: -10).
**Detection:** After scoring, check: does every brand in the input appear in the output? If any brand is completely absent, the quotas are too weak.

### Pitfall 2: Category Collapse
**What goes wrong:** The curated list is 60% t-shirts, 15% hoodies, and tiny representation of everything else. Categories like bags, headwear, outerwear, and bottoms are dropped entirely or have 1-2 styles.
**Why it happens:** T-shirts are the dominant category in wholesale apparel (~48% of market). They score highest because they have the most styles, most colors, most stock, and the most well-known bestsellers. Accessories and outerwear have fewer styles with lower raw scores.
**Consequences:** A customer looking for embroidered jackets or branded bags cannot find options. The catalog appears narrow and amateurish despite having 250 styles.
**Prevention:** Define explicit per-category quotas that guarantee minimum representation. Use the target breakdown from FEATURES.md (40-50 tees, 30-40 hoodies, 20-25 polos, etc.). Selection happens within categories, not across them.
**Detection:** Count styles per category in the output. If any category has fewer than its minimum quota, the engine has a bug.

### Pitfall 3: Price Tier Blindness
**What goes wrong:** The scoring formula favors high-stock, high-color-count styles, which tend to be budget/commodity items ($2-4 wholesale). Premium styles ($8-15) with fewer colors and sizes are systematically excluded.
**Consequences:** The catalog has no premium options. Corporate clients who want Under Armour or Columbia cannot buy. The business cannot upsell. Average order value drops.
**Prevention:** Within each category, enforce at least 1 style per price tier (budget/mid/premium). Define tiers based on the category's own price distribution (percentiles), not absolute dollar amounts -- a $4 t-shirt is "mid" but a $4 jacket is "budget."
**Detection:** For each category in the output, check: are budget, mid, and premium tiers all represented?

### Pitfall 4: Stale Bestseller List
**What goes wrong:** The hardcoded industry bestseller list references styles that no longer exist in the dataset or have been discontinued by the supplier. Styles get a +15 bonus but are actually unavailable.
**Why it happens:** Supplier catalogs change. Gildan renumbered many styles (5000 vs G500). Styles get closeout'd. The bestseller list is not validated against the actual dataset.
**Consequences:** Phantom styles appear in the curated list with "bestseller" tags but zero stock. Or closeout'd styles are promoted when they should be deprioritized.
**Prevention:** At runtime, validate the bestseller list against the actual styleIDs in the dataset. Log any bestseller styles not found. Also check the S&S API `closeout` flag -- a bestseller that is being closed out should lose its bonus.
**Detection:** Log: "Bestseller style X not found in dataset" and "Bestseller style Y is marked as closeout."

## Moderate Pitfalls

### Pitfall 5: Size Range Parsing Errors
**What goes wrong:** The `sizeName` field contains inconsistent values like "S", "Small", "SM", "SMALL", "S/M", "One Size", "OSFA", "YS" (youth small). Naive parsing miscounts the size range.
**Prevention:** Build a size normalization map. Map all variations to a canonical ordered list. Handle edge cases: "One Size" = 1 size (not a range), youth sizes (YS, YM, YL) are a separate scale from adult sizes, alpha sizes (S/M/L) vs numeric sizes (28, 30, 32).

### Pitfall 6: Empty/Zero Stock Misinterpretation
**What goes wrong:** The `Qty` field might contain empty strings, "0", or values that represent "check with supplier." Treating empty as zero and zero as "out of stock" may be wrong -- some suppliers show 0 for items they stock but do not pre-report inventory on.
**Prevention:** Treat empty/null Qty as "unknown" (neutral score), not as "zero stock" (penalty). Only penalize styles where ALL color/size combos explicitly have Qty = "0".

### Pitfall 7: Duplicate Style IDs Across Suppliers
**What goes wrong:** The same physical product may appear under different `styleID` values from different suppliers (SSCANADA vs CSW). Aggregation treats them as separate styles; the curated list includes both, wasting quota slots.
**Prevention:** Before aggregation, check for styles with identical `productName` + `brandName` + `baseCategory` but different `styleID` or `supplierCode`. Flag potential duplicates for manual review. Do not auto-merge -- supplier-specific pricing and stock differ.

### Pitfall 8: Gender Field Inconsistency
**What goes wrong:** The `gender` field may contain "Men's", "Mens", "Male", "M", "Unisex", "Adult", etc. Quota enforcement on gender fails when these are not normalized.
**Prevention:** Normalize gender to three canonical values: `men`, `women`, `unisex`. Treat "Adult" as `unisex`. Treat "Youth" as a separate category dimension (not a gender).

## Minor Pitfalls

### Pitfall 9: Category Naming Inconsistency
**What goes wrong:** The `baseCategory` field may use different names for the same category ("T-Shirts" vs "Tees" vs "T Shirts" vs "Short Sleeve Tee"). Category quotas fail to match.
**Prevention:** Build a category normalization map before aggregation. Map all variations to canonical names matching the taxonomy in CATALOG-CURATION-REPORT.md.

### Pitfall 10: Cost Price as String
**What goes wrong:** The `costPrice` field is typed as `string` in `SheetRow`. Comparison operations produce lexicographic ordering ("9.99" > "10.00") instead of numeric ordering.
**Prevention:** Parse `costPrice` to `number` during aggregation. Handle edge cases: empty strings, "$" prefix, comma-separated thousands.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Data Aggregation | Pitfall 5 (size parsing), Pitfall 6 (stock misinterpretation), Pitfall 10 (string costs) | Build normalization layer first; validate against 10 sample styles manually |
| Scoring | Pitfall 1 (brand monopoly), Pitfall 3 (price blindness) | Run scorer on full dataset, eyeball top-50 before building quota engine |
| Quota Selection | Pitfall 2 (category collapse), Pitfall 7 (duplicates) | Validate category distribution; check for duplicate products across suppliers |
| Bestseller Overlay | Pitfall 4 (stale list) | Validate list against actual dataset at runtime |
| Output | N/A -- low risk | Ensure output includes score breakdown for operator review |

## Sources

- Existing `SheetRow` interface analysis (`src/sheets/types.ts`) -- field types and naming
- CATALOG-CURATION-REPORT.md -- category taxonomy, scoring model
- [S&S Activewear Products API](https://api.ssactivewear.com/V2/Products.aspx) -- `closeout` field confirmed
- Industry knowledge: Gildan style number changes (5000 -> G500 migration)

---
*Researched: 2026-03-31*
