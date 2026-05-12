---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Ready to execute
stopped_at: Phase 15 SPEC + CONTEXT captured. Verifier design + retro mechanism + mechanical defaults all locked. Ready for `/gsd-plan-phase 15`.
last_updated: "2026-05-12T14:06:35.256Z"
progress:
  total_phases: 9
  completed_phases: 8
  total_plans: 20
  completed_plans: 17
  percent: 85
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-01)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Phase 16 — Catalog Image Pollution Audit & Fix (planned, ready to execute)

## Current Position

Phase 15 SHIPPED 2026-05-11. Phase 16 PLANNED 2026-05-12.

**Phase 15 (Garment Type Verification) — SHIPPED 2026-05-11:**
- 4/4 plans complete: verifier helper + in-pipeline integration + retro audit CLI + fixture-gated real-API test
- 53 new tests, full suite green
- Verifier catches shape drift (crewneck→hoodie); does NOT catch identity pollution
- A343 reference pid was never a real product — used CE520L, 6110, 8882 etc. as actual cases during fixture work
- Found during fixture work: catalog has identity-pollution issues (shared URLs across pids, wrong product images, mixed brands) — triggered Phase 16

**Phase 16 (Catalog Image Pollution Audit & Fix) — PLANNED 2026-05-12:**
- SPEC.md — 11 requirements, ambiguity 0.18
- CONTEXT.md — 24 implementation decisions (3-pass detection, per-tier batching, interactive CLI, supplier-canonical comparison, single append-only trail)
- RESEARCH.md — 1,379 lines, integration map + reuse strategy + 4th pollution class `invalid_image_format` recommended
- PATTERNS.md — 14 files mapped to analogs with line numbers
- 4 plans across 3 waves: 16-01 foundations → 16-02 audit + 16-03 fix orchestrator (parallel) → 16-04 manual CLI
- Plan checker: VERIFICATION PASSED on iteration 2 across all 12 dimensions
- HARD constraint: manual queue ≤ 20 pids (BLOCKS phase if exceeded)
- Safety rails: T-16-01 (Drive update-in-place destruction — verify-compare-then-trash mandatory), T-16-04 (delete good image — literal DELETE confirmation)
- Next: /gsd-execute-phase 16

**Catalog curation (not phase-tracked):**
- 283/467 bestsellers fully complete; 179 with data gaps remaining
- 13 CSW products need manual size entry; 60 SS Canada products without API model images

**Imagery audit state (2026-05-08, from Phase 14):**

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
- Phase 16 added (2026-05-12): Catalog Image Pollution Audit & Fix. Triggered by Phase 15 fixture work surfacing identity pollution (8882=5200=CE520L=NE220 all share the same Adidas hoodie image; 6110's FrontImage is a baby onesie). Different problem class from Phase 14 (structural BR↔Drive↔Store reconciliation) and Phase 15 (shape drift in NEW AI gens). This phase audits + fixes IDENTITY of stored images: is the image in slot X actually a picture of product X?
- Phase 15 added (2026-05-08): Garment Type Verification — post-generation classifier rejecting AI back/side images that drift garment shape.
- Phase 15 SHIPPED 2026-05-11 (4/4 plans):
  - **15-01** Foundations: `verifyGarmentTypeMatch()` helper, `appendRejectRow()` TSV writer, fixture scaffold
  - **15-02** In-pipeline: strict AND filter at filter sites, skip+log replacing D-04 fallback, pid threading through audit-runner + fill-missing-info
  - **15-03** Read-only retro audit CLI (`scripts/audit-garment-types.ts`) mirroring `audit-images.ts` DI seam
  - **15-04** 13-pid fixture set + real-API test (gated on OPENAI_API_KEY); 100% recall on 6 good fixtures
  - Key finding: verifier catches GARMENT-SHAPE drift, not IDENTITY pollution (wrong-product images, shared URLs). A343 reference pid was a placeholder, not a real product. This finding triggered Phase 16.

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

**Phase 15 shipped findings (carried into Phase 16):**

- Catalog has identity pollution: 8882=5200=CE520L=NE220 all share one Adidas hoodie fileId; 6110 FrontImage is a baby onesie
- ~20% mismatch rate observed in 100-product retro audit sample
- 1,494 CSW rows have generic baseCategory `T-shirts/Shorts/Polos` — sweeping fix deferred to its own phase
- Headwear (H08*) doesn't fit any CategoryGroup in the verifier — separate phase needed

**Next planned phase:**

- Phase 16 (Catalog Image Pollution Audit & Fix) — 4 plans across 3 waves; ready for `/gsd-execute-phase 16`. Source: Phase 15 fixture work + identity-pollution evidence.

### Blockers/Concerns

- 13 CSW products not in OneSource API — sizes must be entered manually
- 3 products could not be resolved in S&S REST API (6501, LCB112, M858LW)

## Session Continuity

Last session: 2026-05-12 (active)
Stopped at: Phase 15 SHIPPED. Phase 16 SPEC + CONTEXT + RESEARCH + PATTERNS + PLANS all committed. Plan checker passed iteration 2. Ready for `/gsd-execute-phase 16`.
Resume file: `.planning/phases/16-catalog-image-pollution-audit-fix/16-CONTEXT.md`

Project pushed to remote: https://github.com/MoneyMadeMeDoIt/fortee-catalog-engine (master branch)
