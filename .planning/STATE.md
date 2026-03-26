---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: active
stopped_at: "Roadmap created — ready to plan Phase 08"
last_updated: "2026-03-26"
last_activity: 2026-03-26
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** v2.0 Image Automation — Phase 08 (Image Quality Scorer)

## Current Position

Phase: 08 of 13 (Image Quality Scorer)
Plan: — (not yet planned)
Status: Ready to plan
Last activity: 2026-03-26 — v2.0 roadmap created, 6 phases defined

Progress: [░░░░░░░░░░] 0%

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Key decisions for v2.0:
- Quality scorer operates on trimmed garment region (not full canvas) — mandatory to avoid false rejects on white-background images
- Supplier re-fetch before AI generation — OMG → CSW → S&S fallback chain exhausted before spending AI budget
- AI generation produces 3 candidates per view; quality scorer selects best — never auto-accept first output
- Use `productCreateMedia` / `productDeleteMedia` for surgical replacement — never re-push full `productSet` with images (destroys existing GIDs)
- Only new npm dependency: `openai` v6.33.0 — all other stack components exist in v1.0

### Pending Todos

None yet.

### Blockers/Concerns

- OMG API catalog access scope unknown — verify which CSW/S&S styles are accessible before building Phase 09 (flagged for research-phase)
- AI prompt quality uncertain for hoodies/polos/jackets — plan for 1-2 prompt refinement cycles in Phase 10 (flagged for research-phase)
- Print Area metaobject `media` field population status unconfirmed in v1.0 — verify before Phase 12 GID update logic (flagged for research-phase)

## Session Continuity

Last session: 2026-03-26
Stopped at: Roadmap written — all 16 v2.0 requirements mapped across Phases 08-13
Resume file: None
