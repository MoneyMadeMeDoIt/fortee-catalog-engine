---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Image Automation
status: Phase 16 automated portion shipped — awaiting blocking operator checkpoint
stopped_at: Phase 16 Plans 01/02/03 shipped (foundations + audit + fix orchestrator), Plan 04 Task 1 shipped (manual CLI + 21 tests). 80/80 Phase 16 tests green. Task 2 = blocking human-verify checkpoint (operator dry-run on 2 sacrificial pids against real Drive/Sheets) — outstanding. 16-PHASE-SUMMARY.md not written until checkpoint approved.
last_updated: "2026-05-12T18:00:00.000Z"
progress:
  total_phases: 9
  completed_phases: 8
  total_plans: 24
  completed_plans: 20
  percent: 83
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-01)

**Core value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.
**Current focus:** Phase 16 — Catalog Image Pollution Audit & Fix (automated portion shipped 2026-05-12, awaiting operator checkpoint)

## Current Position

Phase 15 SHIPPED 2026-05-11. Phase 16 automated portion SHIPPED 2026-05-12 — operator checkpoint pending.

**Phase 15 (Garment Type Verification) — SHIPPED 2026-05-11:**
- 4/4 plans complete: verifier helper + in-pipeline integration + retro audit CLI + fixture-gated real-API test
- 53 new tests, full suite green
- Verifier catches shape drift (crewneck→hoodie); does NOT catch identity pollution
- A343 reference pid was never a real product — used CE520L, 6110, 8882 etc. as actual cases during fixture work
- Found during fixture work: catalog has identity-pollution issues (shared URLs across pids, wrong product images, mixed brands) — triggered Phase 16

**Phase 16 (Catalog Image Pollution Audit & Fix) — AUTOMATED PORTION SHIPPED 2026-05-12:**
- 11 atomic commits (`b54b6e0` hook fix → `f976173` manual CLI). 80/80 Phase 16 tests green; no regressions in Plans 01–15.
- **Plan 16-01 (Foundations) ✓** — 4 commits, 36 tests across 4 suites. New libs: `src/lib/image-pollution-trail.ts` (fsync + resume), `src/lib/verify-same-product.ts` (gpt-4o-mini same-product verifier, candidate-first prompt), `src/lib/supplier-canonical.ts` (S* → S&S, L* → CSW, H08* → null short-circuit, `colorSideImage` banned from canonical return per feedback_strict_side_profile memory). 4 new exports on `src/sheets/drive.ts`.
- **Plan 16-02 (Audit) ✓** — 3 commits, 15 tests. `scripts/audit-image-pollution.ts` (981 lines). Read-only invariant statically enforced. 3-pass detection: Pass 1 shared_url + invalid_image_format (free), Pass 2 content_mismatch + model_pollution (Vision), Pass 3 shape_drift (Phase 15 verifier reuse). Drive metadata rate-limited at 10 req/sec with exponential backoff on 403/429. D-09 summary header confirmed.
- **Plan 16-03 (Fix orchestrator) ✓** — 2 commits, 17 tests. `scripts/fix-image-pollution.ts` (970 lines). Tier 1 supplier fetch + Tier 2 AI regen via Phase 10's `generateGarmentView` (no double-verify — Phase 15 internal). R6 hard cap verified: 19 → exit 0; 21 → exit 2 BLOCKED-QUEUE-OVERFLOW. T-16-01 compare-before-trash mitigated at every Drive write. D-17 Exception encoded (FrontImage tier-1 skips tautological verifier, logs `notes='verifier_skipped_tautology'`). Two adaptations: real `generateGarmentView` is 8-arg (plan had simplified 3-arg sig — inferred CategoryGroup from BR row); added `PermissiveCostTracker` shim because the fn requires a CostTracker and D-24 says no fix budget cap.
- **Plan 16-04 Task 1 (Manual CLI) ✓** — 1 commit, 21 tests. `scripts/fix-image-pollution-manual.ts` (1040 lines). Interactive `[r]/[s]/[a]/[d]/[v]/[q]` menu. Literal `DELETE` + `FORCE` confirmations enforced. T-16-01 mitigation re-applied to operator URL writes. R10 OR-path: `--re-audit` triggers post-fix audit AND computes BR_WRITE coverage from trail (status SATISFIED iff `pollutedCount===0 OR coveragePct===100`).
- **Plan 16-04 Task 2 (Blocking human checkpoint) — PENDING.** Operator must run `scripts/fix-image-pollution-manual.ts` on 2 sacrificial pids (NOT production) against real Drive + Sheets. 8 verification steps in 16-04-PLAN.md `<how-to-verify>`. Phase 16 cannot close until operator types `approved`. `16-PHASE-SUMMARY.md` not written until then.
- Pre-existing Phase 15 test bug surfaced (out-of-scope, ignored): `tests/lib/garment-type-verifier.test.ts` errors at module-load when `OPENAI_API_KEY` unset (new OpenAI() lives outside the describe.skipIf). Phase 15 hygiene fix, not a Phase 16 regression.
- Next: operator runs the 8-step checkpoint walkthrough → on `approved`, write `16-PHASE-SUMMARY.md`, update STATE.md status, run `--all` audit on real BR.

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

- Phase 16 (Catalog Image Pollution Audit & Fix) — automated portion SHIPPED 2026-05-12 (80/80 tests, 11 commits). Awaiting operator checkpoint (Plan 04 Task 2: live walkthrough on 2 sacrificial pids) before phase close.

### Blockers/Concerns

- 13 CSW products not in OneSource API — sizes must be entered manually
- 3 products could not be resolved in S&S REST API (6501, LCB112, M858LW)

## Session Continuity

Last session: 2026-05-12 (active)
Stopped at: Phase 16 automated portion SHIPPED — 11 commits (`b54b6e0` hook fix → `f976173` manual CLI), 80/80 Phase 16 tests green. Plans 16-01/02/03 fully closed; Plan 16-04 has Task 1 closed (CLI + tests) but Task 2 outstanding (blocking operator checkpoint — live dry-run on 2 sacrificial pids).
Resume file: `.planning/phases/16-catalog-image-pollution-audit-fix/16-04-PLAN.md` (search for `task type="checkpoint:human-verify"` — 8-step verification protocol)

Project pushed to remote: https://github.com/MoneyMadeMeDoIt/fortee-catalog-engine (master branch)
