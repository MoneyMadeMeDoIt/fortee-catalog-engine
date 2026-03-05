# Feature Landscape

**Domain:** Product catalog enrichment pipeline for custom apparel
**Researched:** 2026-03-05
**Confidence:** HIGH

## Table Stakes

Features the operator expects. Missing these = the system is not usable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Canada Sportswear data extraction | Primary supplier -- need images, descriptions, specs, size charts | Med | Site is Shopify-based. Use `/products.json` for structured data, Cheerio for HTML specs |
| S&S Canada data fetching | Second supplier -- need same data categories | Low | Official REST API at `api.ssactivewear.com/V2/`. JSON format. Requires account+API key |
| Google Sheets read/write | The sheet IS the product database; system is useless without it | Low | google-spreadsheet 4.x with service account auth |
| Sheet row enrichment with supplier data | Core pipeline function -- merge supplier data into sheet columns | Med | Map supplier fields to sheet columns, handle missing data gracefully |
| Decoration rules by garment category | Determines which print methods/placements each product gets | Med | Category-based (hoodies, t-shirts, etc.) from Print_Areas_Placement_Guide_FULL.xlsx |
| Pricing calculation per product | Sell price = garment cost + decoration cost + margin | Med | Must implement the pricing calculator logic from Calculateur pour IA.xlsx |
| Shopify product creation via GraphQL API | The output of the entire system | High | `productSet` mutation for product + variants + metafields in one call |
| Variant generation (Color x Size only) | New variant model per project constraints (~98 per product) | Med | Must match the new system structure, not the old 196-variant model |
| Metafield and metaobject creation | Decoration pricing lives in Print Area metaobjects, not variants | High | Create metaobjects before products. Reference via metafields |
| Image download and upload | Products need supplier images in Shopify CDN, not external URLs | Med | Download from supplier, upload via Shopify staged uploads |
| Idempotent product push | Running script twice must not create duplicates | Med | Match on handle. Use `productSet` create-or-update semantics |
| Error reporting with per-product status | Operator must know what failed and why across 100+ products | Low | Structured logging with product-level success/failure |

## Differentiators

Features that add significant value beyond basic functionality.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Category-based decoration rule engine | One rule set per garment category instead of per-product config -- massive time savings | Med | Define once: "hoodies get Front, Back, Left Chest with DTF and Embroidery." Apply to all hoodies |
| Pricing calculator as code | Translating Excel model into deterministic code means prices are always correct | Med | Eliminates manual price entry errors. Can validate before push |
| Dry-run / preview mode | See exactly what would be created in Shopify before pushing | Low | JSON output of planned API calls. Catches errors before production |
| Batch processing with progress | Process 100+ products with clear progress and per-product status | Low | Show which products succeeded, failed, and why |
| Data validation layer | Catch missing images, invalid prices, incomplete specs before Shopify API calls | Med | zod schemas at each pipeline boundary |
| Product template auto-assignment | Assign correct Dawn builder wizard template based on category | Low | No manual template selection in Shopify admin |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Real-time auto-sync | Creates race conditions, unpredictable product states, makes review impossible | Manual script trigger with dry-run preview |
| Web UI / Dashboard | Single operator system. CLI with good logging is faster to build and sufficient | CLI scripts with structured logging |
| Database (PostgreSQL, MongoDB) | Google Sheets IS the database by design. Adding another creates sync issues | Keep Sheets as single source of truth |
| Per-product decoration rules (v1) | Too granular for 100+ products. Category-based covers 90% of cases | Category-based with per-product overrides later |
| S&S Canada web scraping | S&S has sued scrapers under CFAA. Legal risk is real and documented | Use their official REST API |
| AI-generated descriptions | Supplier descriptions exist. AI adds review burden and LLM dependency for v1 | Use supplier descriptions as-is. Add AI rewriting in v2 |
| Multi-channel publishing | Scope creep. Fortee uses Shopify only | Build for Shopify. Architecture shouldn't preclude multi-channel later |
| Webhook-driven updates | Inverts data flow. Sheet is source of truth, not Shopify | One-way: Sheet -> Script -> Shopify |

## Feature Dependencies

```
S&S API Client ──────────────┐
                              v
Canada Sportswear Scraper ──> Sheet Enrichment ──> Data Validation ──> Shopify Product Push
                              ^                                        |
Sheet Schema Design ──────────┘                                        ├── Image Upload
                                                                       ├── Metafield Assignment
Decoration Rules ──> Sheet Enrichment                                  ├── Variant Generation
                                                                       └── Template Assignment
Pricing Calculator ──> Sheet Enrichment

Metaobject Setup ──> Shopify Product Push (metaobjects must exist before products reference them)
```

## MVP Recommendation

Prioritize:
1. **Supplier data extraction** (both suppliers) -- unlocks everything downstream
2. **Sheet enrichment** with decoration rules + pricing -- the core value transformation
3. **Shopify product creation** with variants, metafields, and metaobjects -- the output
4. **Batch processing** for 100+ products -- the scale requirement

Defer:
- **Incremental updates**: First version can recreate products. Optimize later
- **Dry-run mode**: Valuable but not blocking for first 10 product test
- **Image optimization**: Push supplier images directly first, optimize later

## Sources

- [PROJECT.md](../../.planning/PROJECT.md) -- project requirements and constraints (HIGH confidence)
- [S&S Activewear API](https://api.ssactivewear.com/V2/Products.aspx) -- official API for supplier data (HIGH confidence)
- [S&S Activewear lawsuit](https://members.asicentral.com/news/industry-news/september-2025/ss-activewear-files-lawsuit-accuses-promohunt-of-illegally-accessing-data/) -- legal risk of scraping (HIGH confidence)
- [Canada Sportswear](https://canadasportswear.com/) -- confirmed Shopify platform (HIGH confidence)
- [Shopify productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) -- product creation (HIGH confidence)

---
*Feature research for: Fortee Catalog Engine*
*Researched: 2026-03-05*
