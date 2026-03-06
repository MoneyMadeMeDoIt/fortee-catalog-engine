# Phase 3: Decoration Rules and Pricing - Research

**Researched:** 2026-03-06
**Domain:** Business rules engine (category-based decoration mapping + pricing calculator)
**Confidence:** HIGH

## Summary

Phase 3 is a pure data-transformation phase with no new external APIs or libraries. The two reference spreadsheets (`Print_Areas_Placement_Guide_FULL.xlsx` and `Calculateur pour IA.xlsx`) contain all the business rules that need to be codified into TypeScript data structures. The Print Areas guide defines 38 decoration placements across 2 decoration types (Print/DTF and Embroidery) and 6 body categories (Front, Back, Sleeve, Hoodie, Pants, Headwear). The pricing calculator defines a sell price formula: `MSRP = 2x garment cost`, then add decoration costs ($10/print, $6/additional print, $20/embroidery under 8000 stitches, $10 + $0.80/1000 stitches for embroidery over 8000), apply a volume discount, and arrive at the final per-item sell price.

The architecture is straightforward: define static decoration rule data as TypeScript constants (sourced from the spreadsheet), implement the pricing formula as a pure function, then extend the existing enrichment pipeline to write decoration and pricing columns to the sheet.

**Primary recommendation:** Codify both spreadsheets as typed TypeScript constants/functions in `src/decoration/` -- no database, no dynamic config files. The data is small (38 rows of placements, one pricing formula) and changes infrequently.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DECOR-01 | System defines allowed decoration methods and placements per garment category | Print Areas Placement Guide has 38 rows mapping decoration types to categories/placements. Codify as a typed `DECORATION_RULES` constant, keyed by garment category. |
| DECOR-02 | Decoration rules are sourced from the Print Areas Placement Guide | The XLSX has been fully parsed (see Architecture Patterns). All 38 entries are documented with fields: Decoration Type, Category, Placement Name, Common Sizes, Max Size, reference points, notes. |
| PRICE-01 | System calculates full sell price per product (garment cost + decoration cost + margin) | Pricing calculator formula fully reverse-engineered (see Pricing Formula section). Pure function with inputs: garment cost, number of print areas, number of embroidery areas, stitch count. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.x | Type-safe business rules | Already in project |
| Zod | 4.x | Schema validation for decoration/pricing inputs | Already in project, used for all validation |
| vitest | 4.x | Unit testing decoration rules and pricing math | Already in project, 63 existing tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| googleapis | 171.x | Write decoration/pricing columns to sheet | Already in project, reuse existing writer |
| xlsx (SheetJS) | N/A | NOT needed | Reference spreadsheets are already parsed; rules become static code |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Static TS constants | JSON config files | TS constants give type safety, IDE autocomplete, and co-locate with validation schemas. JSON adds a file to maintain with no benefit for 38 rows. |
| Static TS constants | Reading XLSX at runtime | Adds xlsx dependency, runtime parsing, error surface. Data is static and small -- codify once. |

**Installation:**
```bash
# No new packages needed -- all dependencies already installed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── decoration/
│   ├── types.ts           # DecorationRule, PricingInput, PricingResult interfaces + Zod schemas
│   ├── rules.ts           # DECORATION_RULES constant (from Print Areas guide)
│   ├── category-map.ts    # Maps supplier baseCategory strings to canonical garment categories
│   ├── pricing.ts         # calculateSellPrice() pure function
│   └── index.ts           # Public API: getDecorationRulesForCategory(), calculateSellPrice()
├── sheets/
│   ├── enrich-decoration.ts  # Extends enrichment pipeline to write decoration + pricing columns
│   └── types.ts              # Add new columns (decorationMethods, decorationPlacements, sellPrice)
└── scripts/
    └── enrich-decoration.ts  # CLI entry point: tsx scripts/enrich-decoration.ts [--dry-run]
```

### Pattern 1: Static Rule Data as Typed Constants

**What:** Define decoration rules as a typed `Record<GarmentCategory, DecorationRule[]>` constant, not loaded from files at runtime.
**When to use:** When the dataset is small (<100 entries), changes infrequently, and benefits from type checking.
**Example:**
```typescript
// src/decoration/types.ts
export type DecorationMethod = 'Print' | 'Embroidery';

export type GarmentCategory =
  | 'T-Shirt'
  | 'Hoodie'
  | 'Cap'
  | 'Beanie'
  | 'Pants'
  | 'Long Sleeve'
  | 'Jacket';

export interface DecorationPlacement {
  method: DecorationMethod;
  placementName: string;
  commonSizes: string;
  maxSize: string;
  verticalRef: string;
  horizontalRef: string;
  notes: string;
}

// src/decoration/rules.ts
export const DECORATION_RULES: Record<GarmentCategory, DecorationPlacement[]> = {
  'T-Shirt': [
    {
      method: 'Print',
      placementName: 'Left Chest',
      commonSizes: '3.5x3.5',
      maxSize: '4.5x4.5',
      verticalRef: 'Center 4in below collar seam',
      horizontalRef: '3.5-4 in from centerline',
      notes: 'Primary brand logo',
    },
    // ... all placements from Print Areas guide for Front/Back/Sleeve categories
  ],
  'Hoodie': [
    // ... Hoodie-specific placements from the guide
  ],
  // ...
};
```

### Pattern 2: Pure Pricing Function

**What:** Implement the pricing calculator as a stateless pure function. No side effects, easy to test.
**When to use:** Always -- pricing logic must be deterministic and auditable.
**Example:**
```typescript
// src/decoration/pricing.ts
export interface PricingInput {
  garmentCost: number;        // From sheet costPrice column
  printAreas: number;         // Number of print/DTF decoration areas
  embroideryAreas: number;    // Number of embroidery areas
  stitchCount: number;        // Estimated stitch count (from stitch estimator or default)
  discountPercent: number;    // Volume discount (e.g., 0.45 for 45%)
}

export interface PricingResult {
  msrp: number;               // 2x garment cost
  printCost: number;          // First print $10, each additional $6
  embroideryCost: number;     // Under 8000 stitches: $20/area, over: ($10 + $0.80/1000st)/area
  totalDecorationCost: number;
  priceBeforeDiscount: number;
  discount: number;
  sellPrice: number;          // Final per-item price
  grossMargin: number;        // Percentage
}

export function calculateSellPrice(input: PricingInput): PricingResult {
  const msrp = input.garmentCost * 2;

  // Print cost: first area $10, additional areas $6 each
  let printCost = 0;
  if (input.printAreas > 0) {
    printCost = 10 + Math.max(0, input.printAreas - 1) * 6;
  }

  // Embroidery cost: depends on stitch count
  let embroideryCost = 0;
  if (input.embroideryAreas > 0) {
    if (input.stitchCount <= 8000) {
      embroideryCost = 20 * input.embroideryAreas;
    } else {
      embroideryCost = (10 + 0.80 * (input.stitchCount / 1000)) * input.embroideryAreas;
    }
  }

  const totalDecorationCost = printCost + embroideryCost;
  const priceBeforeDiscount = msrp + totalDecorationCost;
  const discount = priceBeforeDiscount * input.discountPercent;
  const sellPrice = priceBeforeDiscount - discount;
  const grossMargin = (sellPrice - input.garmentCost) / sellPrice;

  return {
    msrp,
    printCost,
    embroideryCost,
    totalDecorationCost,
    priceBeforeDiscount,
    discount,
    sellPrice: Math.round(sellPrice * 100) / 100,
    grossMargin: Math.round(grossMargin * 10000) / 10000,
  };
}
```

### Pattern 3: Category Mapping (Supplier Categories to Canonical Categories)

**What:** Supplier `baseCategory` values (e.g., "Fleece", "T-Shirts", "Caps & Hats") must map to canonical `GarmentCategory` values used by the decoration rules. This is a normalization layer.
**When to use:** Between reading sheet data and looking up decoration rules.
**Example:**
```typescript
// src/decoration/category-map.ts
const CATEGORY_ALIASES: Record<string, GarmentCategory> = {
  // T-Shirt variants
  't-shirts': 'T-Shirt',
  'tees': 'T-Shirt',
  'tank tops': 'T-Shirt',

  // Hoodie variants
  'fleece': 'Hoodie',
  'hoodies': 'Hoodie',
  'sweatshirts': 'Hoodie',

  // Long Sleeve variants
  'long sleeve': 'Long Sleeve',
  'henleys': 'Long Sleeve',

  // Headwear variants
  'caps': 'Cap',
  'caps & hats': 'Cap',
  'headwear': 'Cap',
  'beanies': 'Beanie',

  // Pants
  'pants': 'Pants',
  'joggers': 'Pants',
  'shorts': 'Pants',
};

export function resolveCategory(baseCategory: string): GarmentCategory | null {
  const normalized = baseCategory.toLowerCase().trim();
  return CATEGORY_ALIASES[normalized] ?? null;
}
```

### Pattern 4: Extending the Enrichment Pipeline

**What:** Reuse the existing `writeUpdates()` and `readAllRows()` functions. Add a new `enrich-decoration.ts` that reads each row, resolves its category, looks up decoration rules, calculates pricing, and writes new columns.
**When to use:** This follows the exact same pattern as Phase 2's `enrich.ts`.
**Example:**
```typescript
// New columns to add to the sheet (appended after existing 36 columns)
// or populate existing embroideryAvailable/dtfAvailable columns + new price columns
```

### Anti-Patterns to Avoid
- **Runtime XLSX parsing:** Do not read the reference spreadsheets at runtime. They are reference data that should be codified once as TypeScript constants.
- **Per-product decoration rules in v1:** The decision is category-based. Do not build infrastructure for per-product overrides (that is DECOR-03, v2).
- **Floating point arithmetic without rounding:** Always round currency values to 2 decimal places at the output boundary, not intermediate steps.
- **Hardcoded discount percentage:** The 45% discount in the calculator is a parameter, not a constant. Make it configurable per product or globally.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Stitch count estimation | Custom image analysis | Static lookup or user input | The calculator has a stitch estimator (length x width x coverage x 1200 stitches/sq inch) but this requires logo dimensions which vary per order. For v1, use a default stitch count or make it a parameter. |
| Currency formatting | Custom number formatters | `Intl.NumberFormat` or simple `toFixed(2)` | Built into JS/TS |
| Sheet column management | New column discovery logic | Extend existing `SHEET_COLUMNS` and `SheetRow` type | Already solved in Phase 2 |

**Key insight:** This phase is primarily about encoding business knowledge into code. There is no complex algorithmic problem -- the challenge is accurate transcription of the spreadsheet rules and correct formula implementation.

## Common Pitfalls

### Pitfall 1: Category Mismatch Between Supplier Data and Decoration Rules
**What goes wrong:** Supplier `baseCategory` values don't match the decoration rule categories. Products get no decoration rules assigned.
**Why it happens:** S&S and CSW use different category taxonomies. The Print Areas guide uses its own categories (Front, Back, Sleeve, Hoodie, Pants, Headwear).
**How to avoid:** Build the `CATEGORY_ALIASES` map by first extracting all unique `baseCategory` values from the sheet (there are ~1,110 unique styleIDs across ~49,034 rows, but far fewer unique categories). Map every observed category to a canonical one.
**Warning signs:** Products with `null` resolved category after running the enrichment.

### Pitfall 2: Print Areas Guide Category vs Body Location Confusion
**What goes wrong:** The "Category" column in the Print Areas guide is NOT the garment category -- it's the BODY LOCATION (Front, Back, Sleeve, Hoodie, Pants, Headwear). Most body locations apply to multiple garment types.
**Why it happens:** The guide mixes garment-specific locations (Hoodie placements like "Pouch Pocket Center") with generic ones (Front, Back, Sleeve).
**How to avoid:** Define which body-location categories apply to each garment category. For example, T-Shirt gets Front + Back + Sleeve placements. Hoodie gets Front + Back + Sleeve + Hoodie-specific placements.
**Warning signs:** Caps getting "Full Front" placement, or Hoodies missing "Pouch Pocket Center."

### Pitfall 3: Pricing Formula Misinterpretation
**What goes wrong:** The pricing calculator uses French labels and has a non-obvious layout. Easy to misread the formula.
**Why it happens:** The spreadsheet columns are: Cout de l'article (garment cost), marge (2x cost = MSRP), revente 1 impression (sell price with 1 print). The discount (Rabais) and pricing table are in separate sections.
**How to avoid:** Verify the formula with known values. The spreadsheet shows: garment cost $7.80, MSRP $15.60, with 1 print and 45% discount = $14.08 sell price. Use this as a test case.
**Warning signs:** Calculated price not matching $14.08 for the reference product.

### Pitfall 4: Missing Embroidery/DTF Available Flags
**What goes wrong:** The sheet already has `embroideryAvailable` and `dtfAvailable` columns (columns 35-36). These should be populated based on the decoration rules, not left for manual entry.
**Why it happens:** These columns exist but may be empty. The decoration rules determine what is available.
**How to avoid:** When writing decoration data, also populate these boolean flag columns based on whether the category has Embroidery/Print placements.

### Pitfall 5: The Stitch Count Is Order-Specific, Not Product-Specific
**What goes wrong:** Trying to calculate embroidery pricing per product when stitch count depends on the customer's logo.
**Why it happens:** The pricing calculator has a "STITCH ESTIMATOR" section showing logo dimensions (length x width x coverage = stitch count). This is per-order, not per-product.
**How to avoid:** For v1, the sheet-level pricing should use the base MSRP + print decoration cost. Embroidery pricing is variable and belongs in the Print Area metaobjects (Phase 4) where it is calculated at order time. OR use a default stitch count parameter for estimation.

## Code Examples

### Verified Pricing Calculation (from Calculateur pour IA.xlsx)
```typescript
// Reference case from the spreadsheet:
// Garment cost: $7.80
// MSRP (2x cost): $15.60
// Decoration: 1 print area, 0 embroidery, 160 pieces
// Print cost: $10 (first print area)
// Total before discount: $15.60 + $10.00 = $25.60
// Discount: 45% off = $25.60 * 0.45 = $11.52
// Sell price: $25.60 - $11.52 = $14.08
// Gross margin: ($14.08 - $7.80) / $14.08 = 44.6%
// Net margin: 32.21% (after other costs not modeled here)

const result = calculateSellPrice({
  garmentCost: 7.80,
  printAreas: 1,
  embroideryAreas: 0,
  stitchCount: 0,
  discountPercent: 0.45,
});
// result.sellPrice === 14.08
// result.grossMargin === 0.4460
```

### Mapping Body Locations to Garment Categories
```typescript
// The Print Areas guide groups placements by body location.
// Each garment category includes specific body location groups:
const CATEGORY_TO_BODY_LOCATIONS: Record<GarmentCategory, string[]> = {
  'T-Shirt': ['Front', 'Back', 'Sleeve'],
  'Hoodie': ['Front', 'Back', 'Sleeve', 'Hoodie'],
  'Long Sleeve': ['Front', 'Back', 'Sleeve'],
  'Cap': ['Headwear'],  // Only cap-specific headwear entries
  'Beanie': ['Headwear'], // Only beanie-specific headwear entries
  'Pants': ['Pants'],
  'Jacket': ['Front', 'Back', 'Sleeve'],
};
```

### Stitch Count Estimator (from Calculator)
```typescript
// Formula from the spreadsheet STITCH ESTIMATOR section:
// STITCH COUNT = LENGTH * WIDTH * COVERAGE * 1200
// Example: 11 x 4 x 0.40 x 1200 = 21,120 stitches
export function estimateStitchCount(
  lengthInches: number,
  widthInches: number,
  coveragePercent: number = 0.40,
): number {
  return Math.round(lengthInches * widthInches * coveragePercent * 1200);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Color x Size x Decoration Areas variants (~196) | Color x Size only (~98) + Print Area metaobjects | Current project decision | Decoration pricing moves from variant-level to metaobject-level |
| Per-product decoration rules | Category-based rules (v1) | Current project decision | Simpler, ~6-8 categories vs 1,110 products |

**Not applicable for this phase:** No deprecated APIs or libraries involved. This is pure business logic encoding.

## Open Questions

1. **What are all unique `baseCategory` values in the sheet?**
   - What we know: The sheet has ~1,110 unique styleIDs from S&S Canada and CSW. Categories come from supplier data.
   - What's unclear: The exact list of category strings that need mapping to canonical categories.
   - Recommendation: First task should query the sheet for distinct `baseCategory` values and build the complete alias map. This is a 5-minute discovery step.

2. **How should the discount percentage be determined per product?**
   - What we know: The calculator uses 45% as an example. The discount may vary by order volume (160 pieces in the example).
   - What's unclear: Whether discount is a global constant, per-category, or per-order.
   - Recommendation: Make it a configurable parameter with a default of 0.45. Store in the sheet or as a CLI argument. Do not hardcode.

3. **Should embroidery pricing be calculated at the sheet level or deferred to Phase 4 metaobjects?**
   - What we know: Embroidery pricing depends on stitch count, which depends on logo dimensions (order-specific). The calculator shows it can be estimated.
   - What's unclear: Whether the user wants estimated embroidery prices in the sheet or just print pricing.
   - Recommendation: Calculate print-based sell prices in the sheet (garment cost + print decoration + discount). Document that embroidery pricing is variable and will be fully modeled in Phase 4 Print Area metaobjects.

4. **Which new columns need to be added to the sheet?**
   - What we know: `embroideryAvailable` (col 35) and `dtfAvailable` (col 36) already exist. Pricing data (sellPrice, decorationMethods, decorationPlacements) may need new columns.
   - What's unclear: Whether to add new columns or use existing empty ones.
   - Recommendation: Add minimal new columns: `sellPrice`, `decorationPlacements` (JSON or semicolon-separated list). Populate existing `embroideryAvailable` and `dtfAvailable` from rules.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.x |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run tests/decoration/` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DECOR-01 | Each garment category returns correct decoration placements | unit | `npx vitest run tests/decoration/rules.test.ts -t "category"` | No -- Wave 0 |
| DECOR-02 | Rules match Print Areas Placement Guide data | unit | `npx vitest run tests/decoration/rules.test.ts -t "placement guide"` | No -- Wave 0 |
| PRICE-01 | Pricing formula produces correct sell price | unit | `npx vitest run tests/decoration/pricing.test.ts` | No -- Wave 0 |
| PRICE-01 | Reference case ($7.80 garment, 1 print, 45% discount = $14.08) | unit | `npx vitest run tests/decoration/pricing.test.ts -t "reference"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/decoration/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/decoration/rules.test.ts` -- covers DECOR-01, DECOR-02
- [ ] `tests/decoration/pricing.test.ts` -- covers PRICE-01
- [ ] `tests/decoration/category-map.test.ts` -- covers category resolution

## Sources

### Primary (HIGH confidence)
- `Print_Areas_Placement_Guide_FULL.xlsx` -- fully parsed, 38 data rows across Print and Embroidery types
- `Calculateur pour IA.xlsx` -- fully parsed, pricing formula reverse-engineered and verified against reference values
- Existing codebase (`src/sheets/`, `src/suppliers/`) -- examined for patterns, types, and integration points

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` -- requirement IDs DECOR-01, DECOR-02, PRICE-01
- `.planning/STATE.md` -- confirmed category-based rules decision, Color x Size variant model
- `.planning/PROJECT.md` -- confirmed pricing calculator and placement guide as authoritative sources

### Tertiary (LOW confidence)
- Discount percentage interpretation (45% in example, but may vary) -- needs user confirmation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries needed, extending existing patterns
- Architecture: HIGH -- pure data encoding + pure functions, well-understood problem
- Pitfalls: HIGH -- spreadsheets fully parsed, formula verified against reference case
- Pricing formula details: MEDIUM -- discount structure and embroidery pricing edge cases may need user confirmation

**Research date:** 2026-03-06
**Valid until:** Indefinite (business rules from static spreadsheets, no API versioning concerns)
