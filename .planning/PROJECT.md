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

## Current Milestone: v2.0 Image Automation

**Goal:** Every product gets uniform, e-commerce-ready front/back/side images — audit existing for quality, replace bad ones, generate missing views, standardize all, and track status in Google Sheet.

**Target features:**
- Audit & standardize existing images (uniform size, ratio, quality)
- AI quality scoring — flag ugly/unusable images for replacement
- Source front images from OrderMyGear API or scrape supplier sites
- AI-generate missing AND replacement back/side views from front image
- Verify generated image quality before accepting
- Standardize all final images to uniform dimensions/ratio
- Classify and update image status back into Google Sheet

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Category-based decoration rules | Simpler than per-product rules; can add overrides later | ✓ Good — 38 placements codified, pricing verified |
| Manual script trigger over auto-sync | Simpler architecture, operator control | ✓ Good — reliable single-product flow |
| New variant structure (Color x Size only) | Matches Dawn builder wizard, fewer variants | ✓ Good — ~98 variants per product |
| Garment-aware image detection over hardcoded coords | Dynamic per-product accuracy | ✓ Good — sharp.trim() approach works reliably |
| Non-fatal size guide enrichment | Missing spec data shouldn't block product push | ✓ Good — graceful skip with warning |
| Defer batch/dry-run to v2.0 | Prioritize image automation workflow | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-26 after v2.0 milestone start*
