# Feature Research

**Domain:** Consumer apparel e-commerce — product categorization and keyword/tag generation for Shopify
**Researched:** 2026-06-09
**Confidence:** HIGH
**Milestone:** v3.0 Catalog Data Completion

---

## Scope

Three new features for the Bestsellers-Ready sheet (~291 products, ~24,175 rows):

1. **Drive image linker** — overwrite image cells with canonical Drive URLs; add 5 new columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack).
2. **AI category inference** — fill `categories`; refine generic `baseCategory` values (e.g. "Tops" → "T-Shirts").
3. **AI keyword/tag generation** — consumer-style search terms into `keywords`.

The image linker is deterministic and blocked by nothing. Categories and keywords require OpenAI calls.

---

## Background: How Shopify Uses These Fields

Understanding the distinction between Shopify's four related fields is critical before defining features:

| Field | What it is | How it's used | Indexed by Google? |
|-------|------------|---------------|-------------------|
| **Product Category** (Shopify Standard Taxonomy) | Hierarchical path from Shopify's open-source taxonomy (e.g. `Apparel & Accessories > Clothing > Clothing Tops > T-Shirts`) | Used by Shopify for tax rules, Google/Meta feed attributes, category metafields; NOT surfaced directly in storefront nav | No direct ranking signal |
| **Product Type** | Single free-text label per product | Powers automated collections; appears in product URLs; used for storefront nav and filtering | Collection pages rank; product type itself does not |
| **Tags** | Multiple free-text labels per product (up to 250; practical max 10–15) | Power automated collections, faceted filtering on collection pages, on-site search; admin organization | No — tags are not crawled by Google |
| **Keywords / meta keywords** | Custom metafield (`seo.keywords` namespace) or page title/description content | Meta keywords tag is ignored by Google (deprecated since ~2009); real SEO value lives in product title + description content | Only title + description content ranks |

**Critical implication for this milestone:** The `keywords` column in BR is consumed downstream as **Shopify product tags** (collection filtering, on-site search, admin automation) — not as HTML meta keywords. AI-generated keywords must be written as short, filter-friendly tag tokens (e.g. `fleece-hoodie`, `mens`, `heavyweight`), not as prose SEO copy. The distinction matters for what to generate and how to format it.

---

## Feature Landscape

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Drive image linker — front/back/side URLs in BR | The canonical Drive library exists; BR is the source of truth for push; image cells must point to Drive, not stale CSW/S&S URLs | LOW | Purely mechanical: scan Drive per pid, match `{Brand}-{pid}-{Color}-{Role}.png`, write URL to matching BR row |
| 5 new image columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack) | Current BR only has FrontImage/BackImage/DirectSideImage; v2.0 generated side and model views that have no home in the sheet | LOW | Append columns; script must not clobber existing data |
| AI-inferred `baseCategory` refinement | Current `baseCategory` values from supplier scrape are generic ("Tops", "Bottoms") — a consumer storefront needs specific garment types ("T-Shirts", "Fleece Hoodies") | MEDIUM | Per-product inference; use `productName` + `description` as primary signals |
| AI-populated `categories` column | Shopify Standard Taxonomy path needed for tax, feed attributes, and category metafields | MEDIUM | Must map to a valid Shopify taxonomy leaf node; free-form values break Shopify's taxonomy system |
| AI-generated `keywords` written as Shopify tags | Tags power faceted filtering and automated collections; empty tags = no filtering | MEDIUM | Produce 8–15 tokens per product; consistent format (lowercase, hyphens for multi-word) |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Consumer-voice keyword generation (not wholesale jargon) | Small-business customers search "men's fleece hoodie" not "mid-weight 8.0 oz 50/50 blend crewneck"; consumer phrasing drives on-site search hits | MEDIUM | Prompt must explicitly prohibit wholesale language (GSM values, style numbers, supplier names as search terms) |
| Audience-aware category paths (men's / women's / unisex / youth) | Shopify taxonomy separates `Clothing > Men's Clothing` from `Clothing > Women's Clothing`; getting this right enables gender-filtered collection pages | MEDIUM | Use `gender` BR column as authoritative signal; AI confirms or refines |
| Occasion/use-case tags (not just garment-type tags) | "corporate-gift", "team-uniform", "gym-wear", "casual-everyday" tags match the B-to-small-B buyer intent — small businesses order for specific occasions | MEDIUM | AI must infer use-case from garment type + fit + weight; cannot rely on a field that exists in BR |
| `baseCategory` values that double as Product Type | If `baseCategory` is clean and consistent, it maps directly to Shopify Product Type, powering automated collections without extra mapping | LOW | Enforce a controlled vocabulary of ~15 values (see taxonomy section below) |
| Batch processing with per-row idempotency | 291 products × OpenAI calls; must be resumable, not re-process rows that already have values | MEDIUM | Skip rows where `categories` and `keywords` are non-empty; dry-run flag |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| HTML meta keywords tag stuffing | "More keywords = better SEO" intuition | Google has ignored meta keywords since 2009; stuffing them creates noise with zero ranking benefit | Put SEO value in product title and description (already done); use tags for on-site filtering only |
| Deep taxonomy nesting beyond 4 levels | "More specific = more useful" intuition | Shopify's taxonomy stops at 4 levels (e.g. `Apparel & Accessories > Clothing > Clothing Tops > T-Shirts`); going deeper creates unmapped custom paths that break feed exports | Use attributes (size, color, material, gender) for further specificity, not deeper categories |
| Over-tagging (20+ tags per product) | AI naturally generates many tokens | Tag pages (filtered collection URLs) get indexed by Google — 500+ tag pages = duplicate content penalty; 20 tags × 291 products = 5,820 tag-filtered pages | Cap at 10–15 tags per product; use only tags that serve filtering or automation |
| Synonym explosion (t-shirt + tshirt + tee + shirt + top) | "Cover all search variants" | Creates hundreds of near-duplicate tags; each variant becomes a separate filteraable token; breaks the tag taxonomy | Pick one canonical form per concept; rely on Shopify's on-site search stemming for variant matching |
| Supplier-style numbers or brand codes as tags | "Complete data" | BC3001, G64000 are wholesale references; consumers do not search by style number; they pollute the tag namespace | Tags are consumer-facing; style numbers belong in `styleID`/`partNumber` columns, not tags |
| Generating both tags AND meta keywords separately | "Belt and suspenders" approach | Duplicates work; meta keywords have no value; two AI calls for the same semantic content | One AI call → one list of consumer tags; reuse them in both `keywords` column and Shopify tags on push |
| Per-color or per-size keyword variation | "More coverage" | BR has 24,175 rows; colors/sizes are variants, not separate products; duplicate tags across all variants of the same product are wasteful and create noise | Generate once per `productId` (style-level); write the same keywords to all BR rows sharing that `productId` |

---

## Recommended Category Taxonomy

### Shopify Standard Product Taxonomy (the right choice)

Use Shopify's Standard Product Taxonomy as the canonical source for `categories`. It is:
- Open source and machine-readable (GitHub: `shopify/product-taxonomy`, releases through 2026-02)
- Directly recognized by Shopify Admin for tax calculation, Google/Meta product feeds, and category metafields
- Already aligned with Google Product Taxonomy (auto-mapped by Shopify)
- 4-level maximum depth — matches the "classify by function, not material" principle

**Key paths for the Fortee catalog (291 products):**

| Garment Type | Shopify Taxonomy Path |
|---|---|
| T-Shirts | `Apparel & Accessories > Clothing > Clothing Tops > T-Shirts` |
| Sweatshirts / Crew Neck Fleece | `Apparel & Accessories > Clothing > Clothing Tops > Sweatshirts` |
| Hoodies | `Apparel & Accessories > Clothing > Clothing Tops > Hoodies & Sweatshirts` |
| Polo Shirts | `Apparel & Accessories > Clothing > Clothing Tops > Polo Shirts` |
| Long Sleeve T-Shirts | `Apparel & Accessories > Clothing > Clothing Tops > Shirts` |
| Tank Tops | `Apparel & Accessories > Clothing > Clothing Tops > Tank Tops` |
| Shorts | `Apparel & Accessories > Clothing > Clothing Bottoms > Shorts` |
| Sweatpants / Joggers | `Apparel & Accessories > Clothing > Clothing Bottoms > Sweatpants & Joggers` |
| Jackets / Softshells | `Apparel & Accessories > Clothing > Outerwear > Jackets & Coats` |
| Vests | `Apparel & Accessories > Clothing > Outerwear > Vests` |
| Caps / Baseball Hats | `Apparel & Accessories > Clothing Accessories > Hats > Baseball Caps` |
| Beanies | `Apparel & Accessories > Clothing Accessories > Hats > Beanies` |
| Bags | `Apparel & Accessories > Handbags, Wallets & Cases > Bags` |
| Youth T-Shirts | `Apparel & Accessories > Clothing > Clothing Tops > T-Shirts` (with age-group attribute, not a separate path) |

**Granularity rule:** Always resolve to the **leaf node** (level 4). Never stop at a mid-level node like "Clothing Tops" — that path is valid but loses the specificity Shopify uses for feed attributes and tax rules.

**Gender/audience handling:** Shopify's taxonomy does NOT branch by gender at the category level (unlike Google's taxonomy which has separate paths for Men/Women). Gender is captured via a **category attribute** (`target gender` metafield) that Shopify adds automatically once the product category is set. This means: one category path per garment type, gender expressed via attribute. Use `gender` from BR as the value.

### `baseCategory` Controlled Vocabulary (~15 values)

The `baseCategory` column maps to **Shopify Product Type** on push. Product Type is a single free-text field that powers automated collections. Keep it to a controlled vocabulary so collections are predictable:

```
T-Shirts
Long Sleeve Shirts
Polo Shirts
Tank Tops
Hoodies
Sweatshirts
Jackets
Vests
Shorts
Sweatpants
Caps
Beanies
Bags
Youth T-Shirts
Youth Hoodies
```

AI refinement task: current `baseCategory` values from supplier scrape use generic supplier language ("Tops", "Sport Shirts", "Fleece"). The AI pass must normalize these to the controlled vocabulary above.

---

## Tag/Keyword Composition for Consumer Apparel

### What to generate

Each product should get 10–15 tags covering these attribute buckets:

| Bucket | Examples | Source in BR |
|--------|----------|-------------|
| Garment type | `t-shirt`, `fleece-hoodie`, `polo`, `baseball-cap` | `baseCategory` (refined) |
| Audience / gender | `mens`, `womens`, `unisex`, `youth`, `kids` | `gender` column |
| Material / fabric | `cotton`, `polyester-blend`, `fleece`, `tri-blend`, `performance` | `description` (parsed) or `weightGSM` context |
| Fit style | `relaxed-fit`, `slim-fit`, `athletic-fit`, `classic-fit` | `fit` column |
| Weight tier | `lightweight`, `midweight`, `heavyweight` | `weightGSM` (< 150g = lightweight, 150–250g = midweight, > 250g = heavyweight) |
| Decoration suitability | `screen-print-ready`, `embroidery-ready`, `dtf-ready` | `embroideryAvailable`, `dtfAvailable` columns |
| Use case / occasion | `corporate-gift`, `team-uniform`, `casual-everyday`, `gym-wear`, `outdoor` | AI-inferred from garment type + fit + brand |
| Collection signals | `bestseller`, `new-arrival` | Hardcoded on push; do NOT generate in AI pass |

### Format rules

- Lowercase only
- Hyphens for multi-word tokens (`fleece-hoodie`, not `FleeceHoodie` or `fleece hoodie`)
- No punctuation, no apostrophes, no special characters (Shopify tag constraint)
- Singular preferred over plural (`t-shirt` not `t-shirts`) — Shopify search handles plurals
- No style numbers, no supplier names, no GSM values as tags

### Count guidance

- **Minimum per product:** 8 tags (below this, filtering is too sparse)
- **Recommended per product:** 10–15 tags
- **Hard cap:** 15 tags (above this, indexed tag pages multiply fast — each tag creates a filterable URL)

### What NOT to include in tags

- Style/part numbers (`bc3001`, `g18500`) — these are admin fields, not consumer vocabulary
- Brand names unless they are genuine consumer search terms (e.g., `gildan` is low consumer search intent; `next-level` is borderline) — omit by default
- Color names — color is a variant attribute, not a tag; do not generate `color-black`, `color-red` etc.
- Size names — size is a variant attribute; never tag `size-xl` etc.
- Generic descriptors with no filtering value (`product`, `clothing`, `apparel`, `item`)

---

## Feature Dependencies

```
Drive image linker
    └── requires: canonical Drive library complete (DONE — 452/452 pids, plan=0)
    └── requires: BR columns for LeftSide/RightSide/ModelFront/ModelSide/ModelBack added

AI baseCategory refinement
    └── feeds: AI category inference (refined baseCategory is a strong signal for taxonomy path)
    └── feeds: AI keyword generation (garment-type tag comes from refined baseCategory)
    └── requires: productName + description columns populated (DONE — existing enrichment)

AI category inference (categories column → Shopify Standard Taxonomy path)
    └── requires: baseCategory refinement (strongly recommended to run first)
    └── requires: gender column populated (DONE — existing enrichment)
    └── feeds: Shopify push (category metafields, tax, feed exports)

AI keyword/tag generation (keywords column → Shopify tags)
    └── requires: baseCategory refinement (garment type bucket)
    └── requires: fit + gender columns (audience + fit buckets)
    └── requires: description column (material parsing)
    └── feeds: Shopify push (automated collections, faceted filtering)
    └── parallel-safe with category inference (same OpenAI call can produce both)
```

### Dependency notes

- **Image linker is independent** — no OpenAI, no blocked columns; build and ship first.
- **baseCategory refinement + categories + keywords can be ONE AI call per product** — given the small number of distinct products (291), a single structured-output call producing `{ baseCategory, taxonomyPath, tags[] }` is more efficient than three separate calls. This collapses three features into one AI pass.
- **Style-level deduplication is mandatory** — BR has 24,175 rows but only 291 unique `productId` values. All AI calls operate on one row per `productId`, then fan out to all rows sharing that ID. Never call OpenAI per-row.

---

## MVP Definition

### Launch With (this milestone)

- [x] Drive image linker — overwrite FrontImage/BackImage/DirectSideImage, add 5 new columns — **no AI, ship first**
- [x] AI baseCategory refinement — normalize to controlled 15-value vocabulary
- [x] AI `categories` fill — Shopify Standard Taxonomy leaf-node path per product
- [x] AI `keywords` fill — 10–15 consumer-voice tags per product, style-level dedup

### Add After Validation (v3.x)

- [ ] `target gender` attribute propagation to Shopify category metafield — needs push script update; current push doesn't write category attributes
- [ ] Collection scaffold from tags — auto-create Shopify automated collections for key tag values (e.g. `tag:fleece-hoodie`) — separate push concern

### Future Consideration (v4+)

- [ ] Seasonal/trend tags (`season-winter`, `back-to-school`) — requires calendar logic or manual trigger; low ROI for B2B buyer
- [ ] SEO-optimized product title rewrite using keywords — out of scope for this milestone; titles already shipped (v2.0 Phase titles work)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Drive image linker | HIGH — images are blocked for push until this is done | LOW | P1 |
| AI baseCategory refinement | HIGH — gates category inference AND keyword garment-type bucket | LOW–MEDIUM | P1 |
| AI category inference (taxonomy path) | HIGH — needed for Shopify tax + feed exports | MEDIUM | P1 |
| AI keyword/tag generation | HIGH — enables collection filtering and on-site search | MEDIUM | P1 |
| Style-level dedup before AI calls | HIGH — without this, 24K API calls instead of 291 | LOW | P1 (prerequisite) |
| `target gender` metafield propagation | MEDIUM — improves feed quality | HIGH (push script change) | P2 |
| Automated collection scaffold | MEDIUM — filtering UX | MEDIUM | P2 |

---

## Sources

- [Shopify Standard Product Taxonomy (2025-09)](https://shopify.github.io/product-taxonomy/releases/2025-09/) — taxonomy paths, attribute values
- [Shopify Help: Product Category](https://help.shopify.com/en/manual/products/details/product-category) — how taxonomy integrates with tax, feeds, metafields
- [Shopify Help: Product Type](https://help.shopify.com/en/manual/products/details/product-type) — single label, collection automation
- [Shopify Tags Best Practices (Black Belt Commerce)](https://www.blackbeltcommerce.com/shopify-tags-best-practices-guide/) — 5–15 tags, lowercase-hyphen format, anti-patterns
- [Shopify Tags vs. Collections vs. Product Types (Ohavah)](https://ohavah.com/blog/shopify-product-tags-collections-types) — distinctions, filtering vs SEO
- [Shopify Product Tags SEO (Eastside Co)](https://eastsideco.com/blog/shopify-product-tags-bad-for-seo) — tag pages indexed = duplicate content risk
- [Apparel & Fashion Product Category Taxonomy (WisePIM)](https://wisepim.com/guides/product-categorization/fashion) — 4-level max depth, classify by function not material
- [Long-Tail Keywords for Fashion (Thrive Search)](https://thrivesearch.com/unlock-the-power-of-long-tail-keywords-transform-your-apparel-brands-seo-strategy/) — consumer search behavior, long-tail apparel examples

---
*Feature research for: v3.0 Catalog Data Completion — categories, keywords, Drive image linker*
*Researched: 2026-06-09*
