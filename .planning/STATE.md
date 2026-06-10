---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Catalog Data Completion
status: Phase 18 in progress — Plan 18-01 complete
stopped_at: 18-01 (br-image-parser pure module + tests) complete. Next: 18-02 (Drive→BR linker script).
last_updated: "2026-06-10T08:00:00.000Z"
last_activity: 2026-06-10 — Phase 18-01 shipped (pid/role-anchored parser, 29 tests green)
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 3
  completed_plans: 1
  percent: 17
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-09)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** v3.0 Catalog Data Completion — roadmap defined (Phases 18-19), ready to plan Phase 18.

## Current Position

Phase: 18
Plan: 01 complete / 02 next
Status: Phase 18 in progress — Plan 18-01 complete
Last activity: 2026-06-10 — 18-01 shipped: pid/role-anchored br-image-parser + 29-test regression suite

Progress: [█░░░░░░░░░] 17% (0/2 phases complete, 1/3 plans complete)

## Accumulated Context

### Roadmap Evolution

- Phase 14 added (2026-05-08): Imagery cleanup — reconcile BR Drive store consistency for cap-bound and partial-data products. Triggered by partial mid-execution failures during ad-hoc cleanup that should have been planned formally.
- Phase 14 complete (2026-05-08, all 3 plans + allowlist follow-up):
  - **14-01 Foundations:** `resolveStoreProduct` helper (throws on >1 match — closes silent-pick bug class), `KNOWN_SUPPLIER_PREFIXES` allowlist, dedupe `STRAY_PATTERNS` extension. 142 supplier-original Drive duplicates trashed.
  - **14-02 BR↔Drive↔Store reconciliation:** pid 5000 orphan-color reap (60 store media + 43 backfill), pid 168 duplicate-side dedupe, 742-row cross-pollution classification TSV.
  - **14-03 Cross-pollution apply + BAD-ALT + verification:** 19 MOVE + 170 TRASH on Drive, 13 BAD-ALT visual-triaged (8 deletes + 5 renames), 14-VERIFICATION.md.
  - **Allowlist follow-up:** 18 new (pid, brand) entries → CROSS-POLLUTION 553 → 2 (only protected SIZE_CHART PDFs).
- Phase 17 added (2026-05-14): Catalog Image Pollution Fix. Triggered by the first production audit run on 2026-05-14, which surfaced 213 polluted pids and a structural mismatch between Phase 16's design (Tier 1 = supplier-canonical-by-style) and real catalog state (per-color rows + Model* pollution = 72% of fails). Scope captured in .planning/research/phase17-prep/PRODUCTION-AUDIT-FINDINGS.md.
- Phase 16 added (2026-05-12): Catalog Image Pollution Audit & Fix. Triggered by Phase 15 fixture work surfacing identity pollution (8882=5200=CE520L=NE220 all share the same Adidas hoodie image; 6110's FrontImage is a baby onesie). Different problem class from Phase 14 (structural BR↔Drive↔Store reconciliation) and Phase 15 (shape drift in NEW AI gens). This phase audits + fixes IDENTITY of stored images: is the image in slot X actually a picture of product X?
- Phase 15 added (2026-05-08): Garment Type Verification — post-generation classifier rejecting AI back/side images that drift garment shape.
- Phase 15 SHIPPED 2026-05-11 (4/4 plans):
  - **15-01** Foundations: `verifyGarmentTypeMatch()` helper, `appendRejectRow()` TSV writer, fixture scaffold
  - **15-02** In-pipeline: strict AND filter at filter sites, skip+log replacing D-04 fallback, pid threading through audit-runner + fill-missing-info
  - **15-03** Read-only retro audit CLI (`scripts/audit-garment-types.ts`) mirroring `audit-images.ts` DI seam
  - **15-04** 13-pid fixture set + real-API test (gated on OPENAI_API_KEY); 100% recall on 6 good fixtures
  - Key finding: verifier catches GARMENT-SHAPE drift, not IDENTITY pollution (wrong-product images, shared URLs). A343 reference pid was a placeholder, not a real product. This finding triggered Phase 16.
- v2.0 complete (2026-06-09): Complete-Bestsellers Drive finalize done (452/452, plan=0). All pid folders at canonical {Brand}-{pid}-{Color}-{Role}.png naming. v3.0 roadmap defined.
- v3.0 roadmap (2026-06-09): 2 phases (18-19) covering 13 requirements. Phase 18 is unblocked (deterministic, no AI). Phase 19 requires OpenAI usage cap raised first.

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

Key decisions for Phase 18 (2026-06-10):

- D-07: pid-anchored + role-anchored substring extraction in parseCanonicalFilename — never split on every `-`/`_`; color is strictly the text between `-{pid}-` and `-{Role}.png` boundaries
- LeftSide maps to the existing DirectSideImage BR column (D-04); no new LeftSide column is added
- normalizeColor keeps Grey≠Gray distinct — a spelling mismatch is a miss, never a wrong match

Key decisions for v3.0 roadmap (2026-06-09):

- Phases 18-19 (not 1-2): v3.0 continues phase numbering from v2.0; v2.0 ended at Phase 17
- CAT + KW combined into Phase 19: research confirmed one gpt-4o-mini structured-output call per product returns baseCategory + taxonomyPath + keywords[] — halves API calls from ~582 to ~291 vs. separate scripts
- OPS-01 (checkpoint) → Phase 19 (AI phase); OPS-02 (idempotency) → both phases; OPS-03 (header-drift safety) → Phase 18 (image linker)
- Phase 18 depends on nothing and is unblocked today; Phase 19 requires OpenAI usage cap raised (external gate)

### Pending Todos

**Catalog curation (separate from phase work):**

- 13 Canada Sportswear products need manual size entry (not in any API): H08355, H08360, L00450, L00570, L01205, S01225, S04605, S04606, S05980, S05982, S05985, S07200, S07241
- 179 bestseller products still have data gaps (see Catalog-Gaps tab)
- 60 SS Canada products have no model images available from API

**Phase 14 follow-ups (deferred, not blocking):**

- 6 new DUPE-DRIVE collisions from 14-03 MOVE actions (S05772 sides + 4610) — logged in `tmp/dedupe-leftovers.tsv`
- 7 MODEL-MISSING-ON-STORE pids (L07260, L07261, L09270, L09271, S04600, S05650, S05652) — distinct push workflow, not audit-cleanup scope
- Audit `--pids X` mode overwrites `tmp/imagery-audit.tsv` — DX bug; possible follow-up: write narrow audits to a separate path

**Phase 19 gate:**

- OpenAI monthly usage cap must be raised before Phase 19 can run (~291 calls, ~12 cents actual cost; set CostTracker cap to $5 for headroom)
- DirectSideImage = LeftSide mapping assumption should be verified before Phase 18 --apply run (check that existing DirectSideImage cells contain left-side URLs, not right-side)
- Drive public permission state: files moved via UI may lack reader/anyone permission; Phase 18 plan should include sample validation (10 random HTTP HEAD requests after link)

### Blockers/Concerns

- Phase 19 blocked on OpenAI usage cap (external) — Phase 18 can ship independently
- 13 CSW products not in OneSource API — sizes must be entered manually
- 3 products could not be resolved in S&S REST API (6501, LCB112, M858LW)

## Session Continuity

Last session: 2026-06-10 (active)
Stopped at: 18-01 complete (br-image-parser pure module + tests). Next: execute 18-02.
Resume file: `.planning/phases/18-drive-to-br-image-linker/18-01-SUMMARY.md`

Project pushed to remote: https://github.com/MoneyMadeMeDoIt/fortee-catalog-engine (master branch)

## Operator Next Steps

- Execute Phase 18-02: `/gsd-execute-phase 18` (Drive→BR linker script)
- Raise OpenAI usage cap before running Phase 19
