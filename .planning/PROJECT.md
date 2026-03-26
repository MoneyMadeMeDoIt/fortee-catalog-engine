# Fortee Catalog Engine

## What This Is

A centralized product catalog system for Fortee, a custom apparel business. It transforms a Google Sheet into a complete product configuration engine — extracting supplier data (Canada Sportswear, S&S Canada), defining decoration rules and pricing per garment category, standardizing images with garment-aware detection, auto-generating size guide metaobjects, and pushing fully-formed products to Shopify via a single command.

## Core Value

One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, size guides, and all customer-facing content — no manual Shopify admin work needed.

## Requirements

### Validated

- ✓ Scrape supplier product pages (Canada Sportswear, S&S Canada) for images, size charts, descriptions, fabric composition, specs — v1.0
- ✓ Enrich Google Sheet rows with scraped supplier data automatically — v1.0
- ✓ Define decoration rules (allowed methods + placements) by garment category — v1.0
- ✓ Define pricing logic per product using the sell price calculator model — v1.0
- ✓ Generate Shopify-ready product data from enriched sheet (variants, metafields, images, descriptions) — v1.0
- ✓ Push products to Shopify via API with correct template assignment, print area metaobjects, and variant structure — v1.0
- ✓ Garment-aware image standardization with dynamic print area coordinate detection — v1.0
- ✓ Auto-create and link size guide metaobjects from spec sheet data — v1.0

### Active

- [ ] Handle 100+ products at scale (dry-run, batch processing, error reporting) — deferred from v1.0
- [ ] Live inventory sync from suppliers via OneSource API — deferred from v1.0

### Out of Scope

- Building the Dawn builder wizard theme — partially built separately
- Cart Transform Function development — separate deployment
- Real-time automatic sync between sheet and Shopify — manual script trigger for v1
- Draft order webhook app — separate concern
- Regios volume discount configuration — already handled in Shopify

## Context

Shipped v1.0 with ~12,137 LOC TypeScript across 6 completed phases in 7 days.
Tech stack: TypeScript ESM, Shopify GraphQL Admin API (2025-01), Google Sheets API, sharp (image processing), Zod v4, cheerio (HTML parsing), p-queue (rate limiting).

**Current state:** Single-product push works end-to-end. Batch processing and dry-run mode planned but deferred. Image standardization uses garment detection (not hardcoded coords). Size guides auto-generated from spec sheets.

**Known tech debt:**
- Phase 05 (Scale & Reliability) plans exist but unexecuted — no batch mode or dry-run yet
- Phase 06 (Live Inventory Sync) not yet planned

## Constraints

- **Data source**: Google Sheets (xlsx exports or Google Sheets API)
- **Target platform**: Shopify (Admin API for product creation, metafields, metaobjects)
- **Supplier data**: Web scraping for Canada Sportswear, REST API for S&S Canada
- **Variant model**: Color x Size only, decoration pricing via Print Area metaobjects
- **Scale**: Single-product push in v1.0; batch mode deferred
- **Execution**: Manual script trigger, not automated sync

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Category-based decoration rules | Simpler than per-product rules; can add overrides later | ✓ Good — 38 placements codified, pricing verified |
| Manual script trigger over auto-sync | Simpler architecture, operator control | ✓ Good — reliable single-product flow |
| New variant structure (Color x Size only) | Matches Dawn builder wizard, fewer variants | ✓ Good — ~98 variants per product |
| Garment-aware image detection over hardcoded coords | Dynamic per-product accuracy | ✓ Good — sharp.trim() approach works reliably |
| Non-fatal size guide enrichment | Missing spec data shouldn't block product push | ✓ Good — graceful skip with warning |
| Defer batch/dry-run to v2.0 | Prioritize image automation workflow | — Pending |

---
*Last updated: 2026-03-26 after v1.0 milestone*
