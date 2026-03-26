---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Ready to execute
stopped_at: Completed 08-01-PLAN.md
last_updated: "2026-03-26T14:08:58.805Z"
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 2
  completed_plans: 1
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Phase 08 — image-quality-scorer

## Current Position

Phase: 08 (image-quality-scorer) — EXECUTING
Plan: 2 of 2

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Key decisions for v2.0:

- Quality scorer operates on trimmed garment region (not full canvas) — mandatory to avoid false rejects on white-background images
- Supplier re-fetch before AI generation — OMG → CSW → S&S fallback chain exhausted before spending AI budget
- AI generation produces 3 candidates per view; quality scorer selects best — never auto-accept first output
- Use `productCreateMedia` / `productDeleteMedia` for surgical replacement — never re-push full `productSet` with images (destroys existing GIDs)
- Only new npm dependency: `openai` v6.33.0 — all other stack components exist in v1.0
- [Phase 08]: Blur detection uses 30%-inset garment region for monotonic stdev decay
- [Phase 08]: sharp extract().stats() chaining bug: always toBuffer() then stats() separately
- [Phase 08]: QUALITY_THRESHOLDS placeholders (BLUR_MIN_STDEV=20, PRINT_CENTER_STDEV=30) — calibrated in Plan 02

### Pending Todos

None yet.

### Blockers/Concerns

- OMG API catalog access scope unknown — verify which CSW/S&S styles are accessible before building Phase 09 (flagged for research-phase)
- AI prompt quality uncertain for hoodies/polos/jackets — plan for 1-2 prompt refinement cycles in Phase 10 (flagged for research-phase)
- Print Area metaobject `media` field population status unconfirmed in v1.0 — verify before Phase 12 GID update logic (flagged for research-phase)

## Session Continuity

Last session: 2026-03-26T14:08:58.802Z
Stopped at: Completed 08-01-PLAN.md
Resume file: None
