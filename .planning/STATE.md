---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
stopped_at: Completed 04.1-01-PLAN.md (Core image pipeline)
last_updated: "2026-03-11T10:51:25.431Z"
last_activity: 2026-03-09 -- Completed 04-03-PLAN.md (Product push orchestrator)
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 15
  completed_plans: 12
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-05)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, and all customer-facing content.
**Current focus:** Phase 4 complete. All 3 plans executed. Ready for Phase 5.

## Current Position

Phase: 4 of 5 (Shopify Product Push) -- COMPLETE
Plan: 3 of 3 in current phase -- COMPLETE
Status: Phase 4 Complete
Last activity: 2026-03-09 -- Completed 04-03-PLAN.md (Product push orchestrator)

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**
- Total plans completed: 11
- Average duration: 2.8min
- Total execution time: 0.42 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Supplier Data Extraction | 4 | 10min | 2.5min |
| 2. Google Sheets Integration | 2 | 6min | 3min |
| 3. Decoration Rules & Pricing | 2 | 7min | 3.5min |
| 4. Shopify Product Push | 3 | 8min | 2.7min |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 03 P01 | 4min | 2 tasks | 8 files |
| Phase 03 P02 | 3min | 2 tasks | 5 files |
| Phase 04 P01 | 2min | 2 tasks | 10 files |
| Phase 04 P02 | 2min | 2 tasks | 3 files |
| Phase 04 P02 | 2min | 1 tasks | 4 files |
| Phase 04 P01 | 4min | 2 tasks | 11 files |
| Phase 04 P03 | 4min | 2 tasks | 7 files |
| Phase 04.1 P01 | 3min | 1 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Category-based decoration rules (not per-product) for v1
- Manual script trigger (not auto-sync) for v1
- Color x Size variants only (decoration pricing via Print Area metaobjects)
- Zod v4 used instead of v3 (backward-compatible API for safeParse usage)
- p-queue v9 used (ESM-only, compatible with project ESM setup)
- Cheerio for body_html parsing (robust HTML handling vs regex-only)
- 55 req/60s rate limit for S&S API (buffer under 60 req/min cap)
- customerPrice preferred over piecePrice for S&S variant pricing
- Sequential extraction order: CSW first (no rate limits), then S&S
- 38 columns in SheetRow (expanded from 36 with sellPrice, decorationPlacements)
- googleapis for Sheets API (official Google client, CJS handled by tsx)
- [Phase 02]: Image fields map positionally: images[0]=Front, images[1]=Back, images[2]=Side
- [Phase 02]: Size chart stored as structured text not URLs
- [Phase 02]: Supplier product lookup keyed by adapter:styleNumber for cross-supplier uniqueness
- [Phase 03]: 38 placements codified from Print Areas Placement Guide as typed constants
- [Phase 03]: Body location mapping: garment categories -> body location groups (Front/Back/Sleeve/Hoodie/Pants/Headwear)
- [Phase 03]: Embroidery cost threshold at 8000 stitches (flat $20 below, formula-based above)
- [Phase 03]: Print areas default to 1 for base pricing (most common single-area decoration)
- [Phase 03]: Embroidery areas set to 0 for base pricing (order-specific, not pre-calculated)
- [Phase 03]: Default discount 45% matching business pricing model
- [Phase 04]: API version 2025-01 for Shopify Admin API client
- [Phase 04]: Pure function builders with no API calls for independent testability
- [Phase 04]: URL deduplication via Set in buildFiles for cross-row image collection
- [Phase 04]: Deterministic metaobject handles via category-method-placement concatenation
- [Phase 04]: Partial success acceptable for upsertPrintAreas (log errors, continue)
- [Phase 04]: Already-exists errors handled gracefully in setup for idempotent re-runs
- [Phase 04]: sharp with fit:contain and white background for consistent 2000x2000 output
- [Phase 04]: Individual image failures skip gracefully without failing entire product push
- [Phase 04]: Crewneck as standalone GarmentCategory mapping to tops coordinate group
- [Phase 04]: Same SKU for 1-area and 2-area variants (ProductId-Color-Size)
- [Phase 04]: Front Print / Back Print alt text matches print_area_position JSON keys
- [Phase 04]: Metaobjects looked up by handle (front-dtf, back-print) instead of created per-push
- [Phase 04]: buildProductSetInput returns null for unsupported categories, pushProduct throws
- [Phase 04]: Print Areas and MOQ metafields set via separate metafieldsSet call after productSet
- [Phase 04.1-01]: detectGarmentBounds falls back to full image dimensions when trim removes >70% (safety threshold)
- [Phase 04.1-01]: standardizeImage categoryGroup param defaults to 'tops' for backward compat; processProductImages wiring deferred to Plan 02
- [Phase 04.1-01]: Print area coords use garment-relative fractions (not fixed canvas coords) enabling per-product dynamic derivation

### Pending Todos

None yet.

### Roadmap Evolution

- Phase 04.1 inserted after Phase 4: Image Standardization & Print Area Detection (URGENT) — simple resize doesn't match garment proportions, fixed coordinates misaligned on different garment shapes

### Blockers/Concerns

- S&S Canada adapter implemented -- requires SS_ACCOUNT_NUMBER and SS_API_KEY in .env for live API testing
- Canada Sportswear body_html parsing implemented -- fabric composition and size chart PDF URLs extracted successfully
- Shopify GraphQL mutations for metaobject creation need phase-specific research

## Session Continuity

Last session: 2026-03-11T10:51:25.428Z
Stopped at: Completed 04.1-01-PLAN.md (Core image pipeline)
Resume file: None
