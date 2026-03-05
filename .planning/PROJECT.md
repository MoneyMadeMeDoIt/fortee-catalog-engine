# Fortee Catalog Engine

## What This Is

A centralized product catalog system for Fortee, a custom apparel business. It transforms a Google Sheet from a basic supplier list into a complete product configuration engine — scraping supplier data (Canada Sportswear, S&S Canada), defining decoration rules and pricing per garment category, and pushing fully-formed products to Shopify via scripts. The Shopify store becomes the output of the sheet, not the place where products are manually built.

## Core Value

One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, and all customer-facing content — no manual Shopify admin work needed.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Scrape supplier product pages (Canada Sportswear, S&S Canada) for images, size charts, descriptions, fabric composition, specs
- [ ] Enrich Google Sheet rows with scraped supplier data automatically
- [ ] Define decoration rules (allowed methods + placements) by garment category
- [ ] Define pricing logic per product using the sell price calculator model
- [ ] Generate Shopify-ready product data from enriched sheet (variants, metafields, images, descriptions)
- [ ] Push products to Shopify via API with correct template assignment, print area metaobjects, and variant structure (Color x Size only, new system)
- [ ] Handle 100+ products at scale

### Out of Scope

- Building the Dawn builder wizard theme — partially built separately
- Cart Transform Function development — separate deployment
- Real-time automatic sync between sheet and Shopify — manual script trigger for v1
- Draft order webhook app — separate concern
- Regios volume discount configuration — already handled in Shopify

## Context

- **Existing Shopify store** running a custom apparel workflow with print areas, decoration methods (DTF, embroidery), and a multi-step builder wizard (partially built on Dawn theme)
- **Old system** used Kalles/T4S theme with Color x Size x # of Decoration Areas variants (~196 per product). New system uses Color x Size only (~98 variants) with decoration pricing from Print Area metaobject Price fields
- **Two suppliers**: Canada Sportswear and S&S Canada — data scraped from their websites
- **Google Sheet** (`Master_Product_Variants_Media.xlsx`) already exists with one row per variant (color/size combo), containing basic supplier info
- **Pricing calculator** (`Calculateur pour IA.xlsx`) defines full sell price logic (garment + decoration + margin)
- **Print areas placement guide** (`Print_Areas_Placement_Guide_FULL.xlsx`) defines available decoration placements
- **Decoration rules** will be defined by garment category (hoodies get X placements, t-shirts get Y) rather than per individual product for v1
- **Migration docs** exist showing old-to-new system differences

## Constraints

- **Data source**: Google Sheets (xlsx exports or Google Sheets API)
- **Target platform**: Shopify (Admin API for product creation, metafields, metaobjects)
- **Supplier data**: Web scraping (no APIs available from Canada Sportswear or S&S Canada)
- **Variant model**: New system — Color x Size only, decoration pricing via Print Area metaobjects
- **Scale**: Must handle 100+ products with multiple variants each
- **Execution**: Manual script trigger, not automated sync

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Category-based decoration rules | Simpler to start with than per-product rules; can add overrides later | — Pending |
| Manual script trigger over auto-sync | Simpler architecture, gives operator control over when products go live | — Pending |
| New variant structure (Color x Size only) | Matches the new Dawn builder wizard system, fewer variants to manage | — Pending |

---
*Last updated: 2026-03-05 after initialization*
