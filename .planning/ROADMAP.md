# Roadmap: Fortee Catalog Engine

## Milestones

- ✅ **v1.0 MVP** — Phases 01-04.1, 07 (shipped 2026-03-26) — [archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v2.0 Image Automation** — Phases 08-13 (in progress)

<details>
<summary>✅ v1.0 MVP (6 phases, 15 plans) — SHIPPED 2026-03-26</summary>

- [x] Phase 01: Supplier Data Extraction (4/4 plans) — completed 2026-03-05
- [x] Phase 02: Google Sheets Integration (2/2 plans) — completed 2026-03-05
- [x] Phase 03: Decoration Rules and Pricing (2/2 plans) — completed 2026-03-06
- [x] Phase 04: Shopify Product Push (3/3 plans) — completed 2026-03-09
- [x] Phase 04.1: Image Standardization & Print Area Detection (2/2 plans) — completed 2026-03-10
- [x] Phase 07: Size Guide Upload (2/2 plans) — completed 2026-03-11
- Deferred: Phase 05 (Scale & Reliability), Phase 06 (Live Inventory Sync)

</details>

## Deferred from v1.0

- Phase 05: Scale and Reliability (dry-run, batch processing, error reporting)
- Phase 06: Live Inventory Sync (OneSource API → Shopify stock levels)

### Phase 14: Imagery cleanup — reconcile BR Drive store consistency for cap-bound and partial-data products

**Goal:** Reconcile BR ↔ Drive ↔ Store imagery state, close the cap-bound silent-pick bug class, and clean cross-pollution / DUPE-DRIVE audit categories.
**Requirements:** R1.5000-recon, R2.sibling-invariant, R3.cap-store, R4.dupe-round2, R5.168-cross, R6.bad-alt, R10.audit-extension (see 14-SPEC.md)
**Depends on:** Phase 13
**Plans:** 3 plans (3/3 complete) ✓ Phase complete 2026-05-08
**Verification:** [.planning/phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/14-VERIFICATION.md](phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/14-VERIFICATION.md)

Plans:
- [x] **14-01: Foundations** — resolveStoreProduct helper, KNOWN_SUPPLIER_PREFIXES allowlist, dedupe STRAY_PATTERNS extension. 142 supplier-original Drive duplicates trashed. (completed 2026-05-08)
- [x] **14-02: BR ↔ Drive ↔ Store reconciliation** — pid 5000 orphan-color reap (60 store media + 43 backfill), pid 168 duplicate-side dedupe, 742-row cross-pollution classification TSV. (completed 2026-05-08)
- [x] **14-03: Cross-pollution apply + BAD-ALT + verification** — 19 MOVE + 170 TRASH on Drive, 13 BAD-ALT visual-triaged (8 deletes + 5 renames), 14-VERIFICATION.md. Audit dropped 973→576 (all remaining documented or deferred). (completed 2026-05-08)

### Phase 16: Catalog Image Pollution Audit & Fix

**Goal:** Audit every unique pid in Bestsellers-Ready for image pollution across three classes (content-mismatch, shape drift, model-image pollution) plus a 4th structural class (invalid_image_format) recommended by research. Auto-fix where a source-of-truth exists via tiered flow (Tier 1 supplier fetch → Tier 2 AI regen → Tier 3 operator manual queue). Phase closes only when zero unresolved polluted pids remain. Manual queue HARD-CAPPED at 20 — overflow BLOCKS the phase for re-planning.
**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11 (see 16-SPEC.md — 11 locked requirements; 24 context decisions in 16-CONTEXT.md)
**Depends on:** Phase 15
**Plans:** 4 plans
**Validation:** [.planning/phases/16-catalog-image-pollution-audit-fix/16-VALIDATION.md](phases/16-catalog-image-pollution-audit-fix/16-VALIDATION.md)

Plans:
- [ ] **16-01-PLAN.md** — Foundations: image-pollution-trail.ts (fsync + resume), verify-same-product.ts (gpt-4o-mini same-product Vision), supplier-canonical.ts (S&S + CSW + KNOWN_SUPPLIER_PREFIXES dispatcher), Drive helpers (download/trash/metadata/extract-id). (R3, R7, R8, R9, R11)
- [ ] **16-02-PLAN.md** — Audit script: scripts/audit-image-pollution.ts — 3-pass detection (Pass 1 shared_url + invalid_image_format structural; Pass 2 AI content + model_pollution; Pass 3 AI shape via Phase 15 verifier). Read-only static invariant enforced. (R1, R2)
- [ ] **16-03-PLAN.md** — Fix orchestrator: scripts/fix-image-pollution.ts — Tier 1 supplier fetch with verifier-after-fix + T-16-01 compare-before-trash, Tier 2 AI regen via Phase 10 generateGarmentView. R6 hard cap → exit 2 on overflow. (R3, R4, R6, R7, R8, R9, R11)
- [ ] **16-04-PLAN.md** — Manual CLI: scripts/fix-image-pollution-manual.ts — interactive readline walkthrough with literal DELETE/FORCE confirmations + --re-audit for R10 phase-close. (R5, R10, R11)

---

### v2.0 Image Automation (In Progress)

**Milestone Goal:** Every product gets uniform, e-commerce-ready front/back/side images — audit existing for quality, replace bad ones, generate missing views, standardize all, and upload to Shopify.

## Phases

- [x] **Phase 08: Image Quality Scorer** - Sharp-based blur/resolution scoring on trimmed garment region with calibrated thresholds (completed 2026-03-26)
- [x] **Phase 09: Image Sourcing** - Fallback chain fetching front/back/side images from OMG, CSW, and S&S Canada before AI (completed 2026-03-26)
- [x] **Phase 10: AI Image Generation** - OpenAI images.edit() generates missing back/side views with quality-gated candidate selection (completed 2026-03-26)
- [x] **Phase 11: Image Standardization & Safe Upload** - Standardize all accepted images to 2000x2000 with uniform 85% garment height, write CDN URLs to Google Sheets (completed 2026-03-27)
- [x] **Phase 12: Audit Runner** - Per-product orchestrator wiring scorer → source → generate → standardize → upload into a single end-to-end function (completed 2026-03-27)
- [x] **Phase 13: CLI Entry Point** - audit-images.ts CLI exposing the audit runner with --style-id, --all, and --dry-run flags (completed 2026-03-27)
- [x] **Phase 15: Garment Type Verification** - Post-generation classifier that rejects AI images where garment type doesn't match the source (completed 2026-05-11)
- [ ] **Phase 16: Catalog Image Pollution Audit & Fix** - Tiered audit + auto-fix for identity pollution (wrong product images, shared URLs, mixed brands) across BR catalog

## Phase Details

### Phase 08: Image Quality Scorer
**Goal**: A callable scorer function accurately identifies blur, low resolution, and non-blank-garment images using sharp analysis on the trimmed garment region — with thresholds calibrated against real supplier images
**Depends on**: Phase 07 (existing sharp pipeline)
**Requirements**: QUAL-01, QUAL-02, QUAL-03, QUAL-04
**Success Criteria** (what must be TRUE):
  1. `scoreImageQuality(buffer)` returns a verdict of `pass` or `fail` with reasons for any supplier image buffer passed to it
  2. A known-blurry image and a known-sharp image produce different verdicts when scored
  3. Thresholds are calibrated against 50+ real supplier images and false-reject rate on known-good samples is below 5%
  4. The scorer operates on the trimmed garment region (not full white canvas) — a white-background supplier image does not produce a false reject
  5. Images flagged as unsuitable for mockup use (low contrast, heavy watermark, non-blank garment) receive a `fail` verdict with a descriptive reason
  6. Scorer flags images where garment proportion within the canvas is outside the target range (too small or too large relative to the standard garment-to-canvas ratio)
**Plans:** 2/2 plans complete
Plans:
- [x] 08-01-PLAN.md — Scorer function with types, tests, and all 4 dimension checks
- [x] 08-02-PLAN.md — Calibration script and threshold tuning with user review

### Phase 09: Image Sourcing
**Goal**: The system fetches front, back, and side images from supplier APIs (OMG, S&S Canada, CSW) following a cheapest-first fallback chain before any AI generation is attempted
**Depends on**: Phase 08
**Requirements**: SRC-01, SRC-02, SRC-03, SRC-04
**Success Criteria** (what must be TRUE):
  1. Given a known style ID, `sourceImages()` returns at least a front image URL from the OMG OneSource API when the style is in catalog
  2. Back and side image URLs from S&S Canada's `colorBackImage` / `colorSideImage` fields are retrieved and returned for applicable styles
  3. CSW scraper returns additional image angle URLs when available for a given style
  4. When OMG returns no result for a style, the system falls back to CSW, then S&S, then the existing sheet URL — without throwing
**Plans:** 1/1 plans complete
Plans:
- [x] 09-01-PLAN.md — Types, supplier fetchers, sourceImages orchestrator, and tests

### Phase 10: AI Image Generation
**Goal**: The system generates back and side garment views from a front image using OpenAI images.edit(), selects the best of multiple candidates via quality scoring, and rejects outputs with color or proportion drift
**Depends on**: Phase 08, Phase 09
**Requirements**: AIGEN-01, AIGEN-02, AIGEN-03, AIGEN-04
**Success Criteria** (what must be TRUE):
  1. `generateGarmentView(frontBuffer, view)` returns a Buffer containing a back or side garment image that passes quality scoring
  2. The generator produces 3 candidates per view and returns the one with the highest quality score — never the raw first output
  3. Generated images where mean garment hue drifts more than 15 degrees from the front image are rejected and regenerated
  4. A product whose existing front image fails quality scoring gets an AI-generated replacement that passes scoring before it is accepted
**Plans:** 2/2 plans complete
Plans:
- [x] 10-01-PLAN.md — Types, hue utilities, cost tracker, prompt templates with tests
- [x] 10-02-PLAN.md — generateGarmentView and enhanceFrontImage with mocked OpenAI tests

### Phase 11: Image Standardization & Safe Upload
**Goal**: All accepted images (sourced or generated) are standardized to 2000x2000px with the garment scaled to a fixed 85% height target (uniform across all products), then standardized CDN URLs are written to Google Sheets (Shopify store images are not changed in this phase)
**Depends on**: Phase 08, Phase 09, Phase 10
**Requirements**: STD-01, STD-02, OUT-02
**Success Criteria** (what must be TRUE):
  1. Every image that enters the standardizer exits as a 2000x2000px PNG with the garment scaled to 85% max height (1700px) — two different products appear at the same visual size on the canvas
  2. Standardized images are uploaded via Shopify staged uploads for CDN URL generation, but NOT attached to any product
  3. Google Sheets FrontImage/BackImage/DirectSideImage columns are overwritten with standardized CDN URLs
  4. Side-by-side comparison of any two standardized product images shows garments at uniform scale — no product appears visually larger or smaller than another
**Plans:** 2/2 plans complete
Plans:
- [x] 11-01-PLAN.md — Refactor standardizeImage() to fixed 85% garment height target
- [x] 11-02-PLAN.md — standardizeImagesToSheets() with staged upload URLs and sheet write

### Phase 12: Audit Runner
**Goal**: A single `auditProductImages(styleID)` function orchestrates the complete per-product pipeline — score existing images, source replacements, generate missing views, standardize, and upload — with each step's result logged
**Depends on**: Phase 08, Phase 09, Phase 10, Phase 11
**Requirements**: (integration — no new requirements; wires QUAL, SRC, AIGEN, STD, OUT components)
**Success Criteria** (what must be TRUE):
  1. Calling `auditProductImages('CSW-12345')` for a product with a missing back view results in a back image uploaded to Shopify
  2. A product with a low-quality front image has that image replaced (sourced or generated) and uploaded without manual intervention
  3. A product that already has passing front/back/side images is left unchanged — the runner does not re-upload or overwrite good images
  4. Each run produces a log entry per product showing which images passed, failed, were sourced, were generated, and were uploaded
**Plans:** 1/1 plans complete
Plans:
- [x] 12-01-PLAN.md — Types, test scaffold, and auditProductImages pipeline implementation (TDD)

### Phase 13: CLI Entry Point
**Goal**: Running `npx tsx scripts/audit-images.ts` processes one or all products through the complete image audit pipeline and reports results to the console
**Depends on**: Phase 12
**Requirements**: OUT-01
**Success Criteria** (what must be TRUE):
  1. `npx tsx scripts/audit-images.ts --style-id CSW-12345` processes a single product end-to-end and exits with code 0 on success
  2. `npx tsx scripts/audit-images.ts --all` iterates all sheet rows and processes each through the audit runner
  3. `npx tsx scripts/audit-images.ts --dry-run --style-id CSW-12345` scores and logs what would happen without writing to Shopify or Sheets
  4. After a successful `--style-id` run, the target product's Shopify listing shows updated front/back/side images with correct 2000x2000px dimensions
**Plans:** 1/1 plans complete
Plans:
- [x] 13-01-PLAN.md — CLI script with --style-id, --all, --dry-run flags and unit tests

### Phase 15: Garment Type Verification
**Goal**: Per-candidate Vision-based garment-type verification inside `generateGarmentView()` so AI-generated back/side images that drift to a different garment shape (e.g., crewneck → hoodie on pid A343) never reach Drive or the store. Plus a one-off retro audit script that flags wrong-shape images already uploaded.
**Depends on**: Phase 10, Phase 12
**Requirements**: 6 locked in [15-SPEC.md](phases/15-garment-type-verification/15-SPEC.md) — verifier filter (R1), helper API (R2), strict AND retry predicate (R3), skip+log on total fail (R4), no budget gating (R5), retro audit script (R6).
**Success Criteria**: See SPEC.md Acceptance Criteria — 9 pass/fail checks anchored on A343 regression case + 5–10 fixture set across all CategoryGroups.
**Context**: 11 implementation decisions in [15-CONTEXT.md](phases/15-garment-type-verification/15-CONTEXT.md) — side-by-side gpt-4o-mini comparison, coarse family match, scan-all retro, mocked + fixture-gated tests.
**Plans:** 4/4 plans complete ✓ Phase complete 2026-05-11
Plans:
- [x] 15-01-PLAN.md — Foundations: verifier helper `verifyGarmentTypeMatch()` + shared rejects-TSV writer + fixture scaffold (R2)
- [x] 15-02-PLAN.md — In-pipeline integration: wire verifier into `scoreCandidates`/`generateGarmentView`, strict AND filter, skip+log on total fail; mocked tests (R1, R3, R4, R5)
- [x] 15-03-PLAN.md — Retro audit CLI: `scripts/audit-garment-types.ts` scans all back/side images, flag-only TSV output; smoke + read-only-invariant tests (R6)
- [x] 15-04-PLAN.md — Fixture-gated real-API test (13 pids: 7 bad + 6 good); 100% recall on good fixtures; documented finding that verifier catches shape drift but not identity pollution (R2)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 01. Supplier Data Extraction | v1.0 | 4/4 | Complete | 2026-03-05 |
| 02. Google Sheets Integration | v1.0 | 2/2 | Complete | 2026-03-05 |
| 03. Decoration Rules and Pricing | v1.0 | 2/2 | Complete | 2026-03-06 |
| 04. Shopify Product Push | v1.0 | 3/3 | Complete | 2026-03-09 |
| 04.1. Image Standardization & Print Area Detection | v1.0 | 2/2 | Complete | 2026-03-10 |
| 07. Size Guide Upload | v1.0 | 2/2 | Complete | 2026-03-11 |
| 08. Image Quality Scorer | v2.0 | 0/2 | Complete    | 2026-03-26 |
| 09. Image Sourcing | v2.0 | 0/1 | Complete    | 2026-03-26 |
| 10. AI Image Generation | v2.0 | 2/2 | Complete    | 2026-03-26 |
| 11. Image Standardization & Safe Upload | v2.0 | 2/2 | Complete    | 2026-03-27 |
| 12. Audit Runner | v2.0 | 1/1 | Complete    | 2026-03-27 |
| 13. CLI Entry Point | v2.0 | 1/1 | Complete    | 2026-03-27 |
| 14. Imagery Cleanup | v2.0 | 3/3 | Complete    | 2026-05-08 |
| 15. Garment Type Verification | v2.0 | 4/4 | Complete    | 2026-05-11 |
| 16. Catalog Image Pollution Audit & Fix | v2.0 | 0/4 | Planned (ready for execute) | — |
