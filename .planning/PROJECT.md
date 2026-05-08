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
- ✓ Image quality scoring (sharp blur/resolution detection, calibrated thresholds) — v2.0 phase 08
- ✓ Image sourcing fallback chain (OMG → CSW → S&S Canada) — v2.0 phase 09
- ✓ AI image generation for missing back/side views via OpenAI images.edit — v2.0 phase 10
- ✓ Image standardization to 2000x2000 with uniform 85% garment height + Drive upload — v2.0 phase 11
- ✓ Per-product audit runner orchestrating scorer → source → generate → standardize → upload — v2.0 phase 12
- ✓ CLI entry point `audit-images.ts` with --style-id, --all, --dry-run flags — v2.0 phase 13
- ✓ Audit + reconciliation tooling for BR ↔ Drive ↔ Store imagery (resolveStoreProduct, cross-pollution classification, BAD-ALT triage) — v2.0 phase 14

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

**Current state:** v2.0 Image Automation milestone complete (phases 08–13 + ad-hoc Phase 14 imagery cleanup). 460 bestseller products live on test store with full audit hygiene. Catalog curation in progress — 283 fully complete, 179 with data gaps being filled.

**Phase 14 imagery cleanup (shipped 2026-05-08):** Reconciled BR ↔ Drive ↔ Store imagery state across 460 products. Audit dropped 973 → 25 issues; remaining 25 all documented or deferred. Reusable tooling shipped covering safe pid resolution, store cleanup, Drive dedupe, cross-pollution classification, and alt triage.

**Key scripts (catalog curation):**
- `scripts/refresh-bestsellers.ts` — Master sync: reads Catalog-Gaps user data + Drive images → updates Complete-Bestsellers + Sheet1 + refreshes gaps
- `scripts/fetch-missing-sizes.ts` — Fetches size variants from OneSource API for products missing sizes
- `scripts/fetch-ss-rest-sizes.ts` — Fetches sizes from S&S Canada REST API (resolves brand IDs → S&S styleIDs via search)
- `scripts/fetch-model-images.ts` — Downloads on-model images from S&S REST API → uploads to Google Drive (1 color per product, max 3 views)
- `scripts/write-model-urls.ts` — Scans Drive for model images → writes URLs to ModelFrontImage/ModelSideImage/ModelBackImage columns in Sheet1

**Key scripts (imagery audit + cleanup, Phase 14):**
- `scripts/audit-product-imagery.ts` — Per-pid audit covering CROSS-POLLUTION, DUPE-DRIVE, STORE-DRIFT, BAD-ALT, MODEL checks. KNOWN_SUPPLIER_PREFIXES allowlist (19 pids × 6 brands) suppresses brand-prefix false positives.
- `src/shopify/resolve-store-product.ts` — Resolves pid → live store product. Throws `MultipleStoreProductsError` on >1 match (closes the silent-pick bug class that caused tonight's 5000 orphan).
- `scripts/delete-orphan-store-colors.ts` — Color-list-driven store media reaper using resolveStoreProduct.
- `scripts/delete-duplicate-sides.ts` — Per-color side-media dedupe by Shopify CDN `?v=` timestamp.
- `scripts/dedupe-drive-duplicates.ts` — Drive folder dedupe with 3 supplier-original STRAY_PATTERNS.
- `scripts/generate-cross-pollution-tsv.ts` — Classifier producing `tmp/cross-pollution-resolution.tsv` (MOVE-TO / KEEP-WHITELIST / TRASH-ORPHAN).
- `scripts/apply-cross-pollution-resolution.ts` — TSV-driven Drive applier with `isSharedAsset(SIZE_CHART)` protection guard.
- `scripts/propose-bad-alt-mapping.ts` + `download-bad-alt-images.ts` + `apply-bad-alt-fixes.ts` — Alt triage pipeline (visual inspection → action table → dry-run/apply).

**Known tech debt:**
- Phase 05 (Scale & Reliability) plans exist but unexecuted — no batch mode or dry-run yet
- Phase 06 (Live Inventory Sync) not yet planned
- 13 CSW products not in any supplier API — manual data entry required
- S&S REST API integration is script-only (not wired into the main adapter pipeline)
- 6 DUPE-DRIVE collisions on S05772 + 4610 from Phase 14 MOVE actions — logged in `tmp/dedupe-leftovers.tsv`
- 7 MODEL-MISSING-ON-STORE pids — separate push workflow, not audit-cleanup scope
- Audit `--pids X` mode overwrites `tmp/imagery-audit.tsv` — DX bug; downstream TSV-readers must re-run full audit first

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
| S&S Canada REST API (api-ca.ssactivewear.com) for sizes + model images | OneSource SOAP doesn't have all products; REST API has model images | ✓ Good — 236 products got model images, 9 got sizes via REST |
| Model images separate from garment images | Garment-only for mockups, on-model for customer display | ✓ Good — 3 new columns, 700 images in Drive |
| Catalog-Gaps as user-editable working sheet | User fills real data (not just Y/N) in gaps sheet, script merges | ✓ Good — merge-based refresh preserves manual edits |
| `resolveStoreProduct` throws on >1 match (Phase 14) | Silent `first: 1` lookup picked stale orphan and dropped 15 colors from BR while keeping them on store | ✓ Good — fail-loud semantics close the bug class; smoke-tested against pid 5000 |
| `KNOWN_SUPPLIER_PREFIXES` per-pid allowlist over global rule (Phase 14) | Brand-prefix files (`Richardson_168_*`, `BELLA_+_CANVAS_6110_*`) are correct but fail naive prefix check | ✓ Good — 19 entries × 6 brands → CROSS-POLLUTION 553 → 2 |
| TSV-driven Drive mutation (Phase 14) | Classify all rows into MOVE/KEEP/TRASH first, review, then apply — beats per-folder ad-hoc cleanup | ✓ Good — 191 mutations, 0 errors, every action explainable |
| `isSharedAsset(SIZE_CHART)` protection guard (Phase 14) | Multi-pid SIZE_CHART PDFs fail strict pid-prefix rule but are intentionally placed | ✓ Good — 2 charts saved from incorrect TRASH classification |
| Visual inspection over vision-AI inference for BAD-ALT (Phase 14) | 13 images had wrong alts; needed actual content review to decide rename vs delete | ✓ Good — auditable per-row reason; 8 deletes + 5 renames produced cleaner state than blind whitelist would |

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
*Last updated: 2026-05-08 — Phase 14 imagery cleanup shipped. Audit 973→25; reusable tooling for BR↔Drive↔Store reconciliation in place.*
