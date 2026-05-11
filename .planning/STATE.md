---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Ready to execute
stopped_at: Phase 15 SPEC + CONTEXT captured. Verifier design + retro mechanism + mechanical defaults all locked. Ready for `/gsd-plan-phase 15`.
last_updated: "2026-05-11T13:20:59.784Z"
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 16
  completed_plans: 12
  percent: 75
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-01)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Bestseller catalog curation — filling data gaps for 467 curated products before go-live

## Current Position

v2.0 phases + Phase 14 imagery cleanup all shipped. Phase 15 (Garment Type Verification) in planning — SPEC.md + CONTEXT.md committed; ready for `/gsd-plan-phase 15`. Catalog curation work continues separately (not phase-tracked):

- 283/467 bestsellers fully complete
- 179 with gaps remaining (mostly missing descriptions, size charts, categories)
- 2 products still not in Sheet1

**Phase 15 status (2026-05-08):**

- SPEC.md committed — 6 requirements, ambiguity 0.18 (gate ≤ 0.20)
- CONTEXT.md committed — 11 implementation decisions locked
- Verifier: side-by-side gpt-4o-mini, coarse CategoryGroup match
- Retro: scan-all back/side regardless of source (~$0.06/pass)
- Tests: mocked-OpenAI unit + real-API fixture test gated on OPENAI_API_KEY
- Next: /gsd-plan-phase 15

**Imagery audit state (2026-05-08):**

- 25 issues across 460 audited pids (down from 973 baseline)
- 0 STORE-DRIFT, 0 STORE-EXTRA-COLOR, 0 BAD-ALT
- 2 CROSS-POLLUTION (intentional protected SIZE_CHARTs)
- 15 DUPE-DRIVE deferred (logged in `tmp/dedupe-leftovers.tsv`)
- 7 MODEL-MISSING-ON-STORE (separate push workflow)
- 1 MODEL-DUPLICATED accepted variance (L01250)

## Accumulated Context

### Roadmap Evolution

- Phase 14 added (2026-05-08): Imagery cleanup — reconcile BR Drive store consistency for cap-bound and partial-data products. Triggered by partial mid-execution failures during ad-hoc cleanup that should have been planned formally.
- Phase 14 complete (2026-05-08, all 3 plans + allowlist follow-up):
  - **14-01 Foundations:** `resolveStoreProduct` helper (throws on >1 match — closes silent-pick bug class), `KNOWN_SUPPLIER_PREFIXES` allowlist, dedupe `STRAY_PATTERNS` extension. 142 supplier-original Drive duplicates trashed.
  - **14-02 BR↔Drive↔Store reconciliation:** pid 5000 orphan-color reap (60 store media + 43 backfill), pid 168 duplicate-side dedupe, 742-row cross-pollution classification TSV.
  - **14-03 Cross-pollution apply + BAD-ALT + verification:** 19 MOVE + 170 TRASH on Drive, 13 BAD-ALT visual-triaged (8 deletes + 5 renames), 14-VERIFICATION.md.
  - **Allowlist follow-up:** 18 new (pid, brand) entries → CROSS-POLLUTION 553 → 2 (only protected SIZE_CHART PDFs).
- Phase 15 added (2026-05-08): Garment Type Verification — post-generation classifier rejecting AI back/side images that drift garment shape. Triggered by A343 regression (crewneck → hoodie drift in generated views).
- Phase 15 planning in progress (2026-05-08):
  - **15-SPEC.md** — 6 requirements locked. Ambiguity 0.18. R6 ⚠ flag resolved by D-04 (scan-all retro). Three-round Socratic interview captured the source-of-truth (front image), strict AND retry predicate, and skip-on-total-fail policy.
  - **15-CONTEXT.md** — 11 implementation decisions across Vision verifier design, retro identification, TSV format, fixture set, and test strategy.

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

**Catalog curation (separate from phase work):**

- 13 Canada Sportswear products need manual size entry (not in any API): H08355, H08360, L00450, L00570, L01205, S01225, S04605, S04606, S05980, S05982, S05985, S07200, S07241
- 179 bestseller products still have data gaps (see Catalog-Gaps tab)
- 60 SS Canada products have no model images available from API

**Phase 14 follow-ups (deferred, not blocking):**

- 6 new DUPE-DRIVE collisions from 14-03 MOVE actions (S05772 sides + 4610) — logged in `tmp/dedupe-leftovers.tsv`
- 7 MODEL-MISSING-ON-STORE pids (L07260, L07261, L09270, L09271, S04600, S05650, S05652) — distinct push workflow, not audit-cleanup scope
- Audit `--pids X` mode overwrites `tmp/imagery-audit.tsv` — DX bug; possible follow-up: write narrow audits to a separate path

**Next planned phase:**

- Phase 15 (Garment Type Verification) — SPEC + CONTEXT committed; ready for `/gsd-plan-phase 15`. Source: `project_garment_classifier.md` memory + A343 regression case.

### Blockers/Concerns

- 13 CSW products not in OneSource API — sizes must be entered manually
- 3 products could not be resolved in S&S REST API (6501, LCB112, M858LW)

## Session Continuity

Last session: 2026-05-08T19:00:00.000Z
Stopped at: Phase 15 SPEC + CONTEXT captured. Verifier design + retro mechanism + mechanical defaults all locked. Ready for `/gsd-plan-phase 15`.
Resume file: `.planning/phases/15-garment-type-verification/15-CONTEXT.md`
