# Architecture Patterns: Catalog Curation System

**Domain:** Product curation/filtering for wholesale apparel catalog
**Researched:** 2026-03-31
**Question:** How to reduce 941 styles (43,130 rows) to a curated ~250-style catalog using available sheet data?

---

## Recommended Architecture

### Pipeline Overview

```
Google Sheet (43,130 rows)
    |
    v
[1. Reader] -- readAllRows() (existing)
    |
    v
[2. Aggregator] -- Group rows by styleID → 941 StyleProfile objects
    |
    v
[3. Scorer] -- Compute composite score per StyleProfile
    |
    v
[4. Bestseller Overlay] -- Boost known industry bestsellers
    |
    v
[5. Quota Engine] -- Select top styles per category/brand within quotas
    |
    v
[6. Output] -- Write curated list to new sheet tab or CSV
```

### Component Boundaries

| Component | Responsibility | Input | Output |
|-----------|---------------|-------|--------|
| `aggregateStyles()` | Group 43K rows into 941 style profiles | `SheetRow[]` | `Map<string, StyleProfile>` |
| `scoreStyle()` | Compute composite score for one style | `StyleProfile` | `ScoredStyle` (style + score + breakdown) |
| `applyBestsellerBonus()` | Add score bonus for known popular styles | `ScoredStyle[]` | `ScoredStyle[]` (mutated scores) |
| `selectWithQuotas()` | Pick top-N styles respecting category/brand/gender/price quotas | `ScoredStyle[]`, `QuotaConfig` | `CuratedStyle[]` (keep/drop + reason) |
| `writeCurationOutput()` | Export results | `CuratedStyle[]` | Sheet tab or CSV file |

### Data Flow

**Step 1: Aggregation** -- Transform row-level data into style-level profiles.

```typescript
interface StyleProfile {
  styleID: string;
  brandName: string;
  productName: string;
  baseCategory: string;
  gender: string;
  fit: string;
  supplierCode: string;
  // Computed metrics
  colorCount: number;           // COUNT(DISTINCT colorName)
  colorFamilies: string[];      // DISTINCT colorFamily values
  sizeNames: string[];          // DISTINCT sizeName values (ordered)
  sizeRangeSpan: number;        // Numeric: how many standard sizes covered
  totalStock: number;           // SUM(Qty) across all color/size combos
  avgCostPrice: number;         // AVG(costPrice) across sizes
  minCostPrice: number;         // MIN(costPrice)
  maxCostPrice: number;         // MAX(costPrice)
  priceTier: 'budget' | 'mid' | 'premium'; // Derived from avgCostPrice
  hasImages: boolean;           // FrontImage is non-empty
  rowCount: number;             // Total rows for this style
}
```

**Step 2: Scoring** -- Apply weighted formula to each StyleProfile.

```typescript
interface ScoredStyle {
  profile: StyleProfile;
  totalScore: number;           // 0-100 composite score
  breakdown: {
    colorScore: number;         // 0-30 (weight: 30%)
    sizeScore: number;          // 0-25 (weight: 25%)
    stockScore: number;         // 0-20 (weight: 20%)
    imageScore: number;         // 0-10 (weight: 10%)
    bestsellerBonus: number;    // 0-15 (bonus for known bestsellers)
  };
  reason: string;               // Human-readable explanation
}
```

**Step 3: Quota Selection** -- Enforce category/brand/gender/price constraints.

```typescript
interface QuotaConfig {
  totalTarget: number;                    // e.g., 250
  categoryQuotas: Record<string, {
    min: number;                          // Minimum styles in this category
    max: number;                          // Maximum styles in this category
  }>;
  brandMinimum: number;                   // At least N styles per brand (if brand has enough)
  genderMinimum: Record<string, number>;  // At least N per gender per category
  priceTierMinimum: number;               // At least N per tier per category
}

interface CuratedStyle extends ScoredStyle {
  decision: 'keep' | 'drop';
  selectionReason: string;      // "Top scorer in T-Shirts/BELLA+CANVAS" or "Dropped: quota full for T-Shirts"
}
```

### Scoring Formula (Proposed)

```
TOTAL_SCORE = colorScore + sizeScore + stockScore + imageScore + bestsellerBonus

Where:
  colorScore (0-30):
    40+ colors → 30
    30-39      → 25
    20-29      → 20
    15-19      → 15
    10-14      → 10
    5-9        → 5
    <5         → 0

  sizeScore (0-25):
    XS-5XL or wider → 25
    XS-4XL          → 20
    S-3XL           → 15
    S-2XL           → 10
    S-XL            → 5
    Other           → 0

  stockScore (0-20):
    Top quartile (75th+ percentile of total stock across all styles) → 20
    Second quartile (50th-75th) → 15
    Third quartile (25th-50th)  → 10
    Bottom quartile (<25th)     → 5

  imageScore (0-10):
    Front + Back + Side all present → 10
    Front + one other              → 7
    Front only                     → 4
    No images                      → 0

  bestsellerBonus (0-15):
    Known industry bestseller (hardcoded list) → 15
    Not on list                                → 0
```

**Why these weights:**
- Color count (30%) is the strongest signal. Suppliers invest in more colorways for styles that sell well. A style with 40+ colors has proven market demand -- the supplier would not stock that many colorways otherwise.
- Size range (25%) is the second strongest. Corporate and team orders frequently need 3XL+. Inclusive sizing directly expands the addressable market.
- Stock availability (20%) indicates supplier confidence and reduces order fulfillment risk.
- Image availability (10%) is a quality signal -- better-documented styles are easier to sell.
- Bestseller bonus (15%) compensates for the lack of sales data with industry knowledge.

### Known Industry Bestsellers (Initial List)

These styles are documented as top sellers across multiple industry sources:

| Brand | Style | Product | Category |
|-------|-------|---------|----------|
| BELLA+CANVAS | 3001 | Unisex Jersey Tee | T-Shirts |
| BELLA+CANVAS | 3413 | Triblend Tee | T-Shirts |
| BELLA+CANVAS | 3001CVC | CVC Tee | T-Shirts |
| BELLA+CANVAS | 3719 | Sponge Fleece Hoodie | Hoodies |
| BELLA+CANVAS | 3480 | Jersey Tank | Tank Tops |
| Gildan | 64000 / G640 | Softstyle T-Shirt | T-Shirts |
| Gildan | 5000 / G500 | Heavy Cotton Tee | T-Shirts |
| Gildan | 18500 | Heavy Blend Hoodie | Hoodies |
| Gildan | 18000 | Heavy Blend Crewneck | Fleece |
| Next Level | 3600 | Cotton Crew | T-Shirts |
| Next Level | 6210 | CVC Crew | T-Shirts |
| Next Level | 6010 | Triblend Crew | T-Shirts |
| Next Level | 9301 | French Terry Hoodie | Hoodies |
| M&O | 4800 | Gold Soft Touch T-Shirt | T-Shirts |

This list should be expanded during implementation based on which brands/styles actually exist in the 941-style dataset.

## Patterns to Follow

### Pattern 1: Aggregate-then-Score
**What:** Never score individual rows. Always aggregate to style level first, then score the aggregated profile.
**When:** Always -- the 43K rows are not 43K products; they are 941 products with many size/color combinations.
**Why:** Scoring individual rows would massively over-represent styles with many colorways (a style with 50 colors x 10 sizes = 500 rows would dominate).

### Pattern 2: Score-then-Quota (not Quota-then-Score)
**What:** Score all 941 styles first, then apply quotas to select from the scored list. Do NOT pre-filter by category before scoring.
**When:** During the selection phase.
**Why:** Pre-filtering loses the global ranking context. A mediocre t-shirt should not beat an excellent jacket just because t-shirts are processed first.

### Pattern 3: Relative Scoring for Stock
**What:** Stock availability scoring should use percentile ranking across all styles, not absolute thresholds.
**When:** Computing `stockScore`.
**Why:** Absolute thresholds (e.g., "10,000+ units = high") would fail if the supplier's overall stock levels change. Percentile ranking adapts automatically.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Per-Row Decision Making
**What:** Evaluating keep/drop at the individual row (color/size combo) level.
**Why bad:** A style is either in the catalog or out. You cannot keep "Gildan 5000 in Black S" but drop "Gildan 5000 in White M". The decision granularity is style-level.
**Instead:** Aggregate to style, score the style, keep or drop the entire style.

### Anti-Pattern 2: Greedy Top-N Selection
**What:** Sort all 941 styles by score, take the top 250.
**Why bad:** Top 250 by raw score would be almost entirely t-shirts (the category with most styles, most colors, most stock). Jackets, accessories, and niche categories would be completely absent.
**Instead:** Use quota-constrained selection: allocate slots per category, fill each category's slots with its highest-scored styles.

### Anti-Pattern 3: Binary Filtering (Hard Cutoffs)
**What:** "Exclude all styles with fewer than 10 colors."
**Why bad:** A premium Columbia jacket with 6 colors and XS-4XL sizing is more valuable than a no-name tee with 15 colors but S-XL only. Hard cutoffs lose this nuance.
**Instead:** Use continuous scoring where each dimension contributes proportionally. Low color count hurts the score but does not auto-exclude.

## File Structure

```
src/curation/
  types.ts            -- StyleProfile, ScoredStyle, CuratedStyle, QuotaConfig interfaces
  aggregator.ts       -- aggregateStyles(rows: SheetRow[]): Map<string, StyleProfile>
  scorer.ts           -- scoreStyle(profile: StyleProfile): ScoredStyle
  bestsellers.ts      -- KNOWN_BESTSELLERS list + applyBestsellerBonus()
  quota-engine.ts     -- selectWithQuotas(styles: ScoredStyle[], config: QuotaConfig): CuratedStyle[]
  index.ts            -- curateCatalog() orchestrator
scripts/
  curate-catalog.ts   -- CLI entry point with --target, --dry-run flags
```

## Sources

- Existing `src/sheets/types.ts` -- SheetRow interface with all 38 columns
- Existing `src/sheets/reader.ts` -- readAllRows() for Google Sheet access
- CATALOG-CURATION-REPORT.md -- scoring model inspiration (sections 5 and 7)
- [RushOrderTees: Bella+Canvas vs Gildan](https://www.rushordertees.com/blog/bella-canvas-vs-gildan-compare-t-shirts/) -- bestseller style numbers (MEDIUM)
- [TSport.ca: BC 3001 vs Gildan 64000](https://www.tsport.ca/blog/bella-canvas-3001-vs-gildan-64000) -- Canadian market bestsellers (MEDIUM)

---
*Researched: 2026-03-31*
