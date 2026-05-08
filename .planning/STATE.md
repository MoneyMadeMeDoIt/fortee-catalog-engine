---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Phase 14 imagery cleanup in progress (1/3 plans complete)
stopped_at: 14-01-PLAN.md complete — resolveStoreProduct helper shipped, KNOWN_SUPPLIER_PREFIXES added to audit, 142 supplier-original Drive duplicates trashed
last_updated: "2026-05-08T13:56:05.155Z"
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 15
  completed_plans: 11
  percent: 73
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-01)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Bestseller catalog curation — filling data gaps for 467 curated products before go-live

## Current Position

v2.0 phases complete. Currently in catalog curation work (not phase-tracked):

- 283/467 bestsellers fully complete
- 179 with gaps remaining (mostly missing descriptions, size charts, categories)
- 2 products still not in Sheet1

## Accumulated Context

### Roadmap Evolution

- Phase 14 added (2026-05-08): Imagery cleanup — reconcile BR Drive store consistency for cap-bound and partial-data products. Triggered by partial mid-execution failures during ad-hoc cleanup that should have been planned formally.
- Phase 14 Plan 01 complete (2026-05-08): resolveStoreProduct helper, KNOWN_SUPPLIER_PREFIXES allowlist, dedupe STRAY_PATTERNS extension. 142 supplier-original Drive duplicates trashed; DUPE-DRIVE 92 → 9. Helper smoke-tested against pid 5000.

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Key decisions for v2.0 phases: (see PROJECT.md)

Key decisions for catalog curation (2026-04-01):

- S&S Canada REST API base URL is `https://api-ca.ssactivewear.com/v2/` (NOT `api.ssactivewear.com`) — Canadian endpoint
- S&S REST API uses Basic auth with SS_ACCOUNT_NUMBER + SS_API_KEY
- Brand style IDs (e.g. Bella+Canvas 6110) differ from S&S internal styleIDs — must use `/styles/?search=` to resolve, then fetch products by S&S styleID
- Model images stored as separate files in Drive (model-front.png, model-side.png, model-back.png) — NOT replacing garment-only images
- 3 new Sheet1 columns added: ModelFrontImage, ModelSideImage, ModelBackImage (columns AN, AO, AP)
- Catalog-Gaps tab is user-editable — NEVER delete+recreate, always read existing data first and merge
- User enters actual data (descriptions, size charts, categories) into Catalog-Gaps "Has X" columns, not just Y/N flags

### Pending Todos

- 13 Canada Sportswear products need manual size entry (not in any API): H08355, H08360, L00450, L00570, L01205, S01225, S04605, S04606, S05980, S05982, S05985, S07200, S07241
- 179 bestseller products still have data gaps (see Catalog-Gaps tab)
- 60 SS Canada products have no model images available from API

### Blockers/Concerns

- 13 CSW products not in OneSource API — sizes must be entered manually
- 3 products could not be resolved in S&S REST API (6501, LCB112, M858LW)

## Session Continuity

Last session: 2026-05-08T13:55:00.000Z
Stopped at: 14-01-PLAN.md complete — see .planning/phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/14-01-SUMMARY.md. Next: 14-02-PLAN.md
Resume file: None
