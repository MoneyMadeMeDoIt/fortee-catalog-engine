# Roadmap: Fortee Catalog Engine

## Milestones

- ✅ **v1.0 MVP** — Phases 01-04.1, 07 (shipped 2026-03-26) — [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0 Image Automation** — Phases 08-16 (shipped 2026-05-13)
- 🔄 **v3.0 Catalog Data Completion** — Phases 18-19 (in progress)

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
- [x] **16-01-PLAN.md** — Foundations: image-pollution-trail.ts (fsync + resume), verify-same-product.ts (gpt-4o-mini same-product Vision), supplier-canonical.ts (S&S + CSW + KNOWN_SUPPLIER_PREFIXES dispatcher), Drive helpers (download/trash/metadata/extract-id). 36/36 tests. (completed 2026-05-12, commits b475ba6/13b2ac5/e11a07c/fa2d40f) (R3, R7, R8, R9, R11)
- [x] **16-02-PLAN.md** — Audit script: scripts/audit-image-pollution.ts (981 lines) — 3-pass detection (Pass 1 shared_url + invalid_image_format structural; Pass 2 AI content + model_pollution; Pass 3 AI shape via Phase 15 verifier). Read-only static invariant enforced. 15/15 tests. (completed 2026-05-12, commits 5afa023/66895de/b3a3f39) (R1, R2)
- [x] **16-03-PLAN.md** — Fix orchestrator: scripts/fix-image-pollution.ts (970 lines) — Tier 1 supplier fetch with verifier-after-fix + T-16-01 compare-before-trash, Tier 2 AI regen via Phase 10 generateGarmentView. R6 hard cap → exit 2 on overflow verified both ways (19 ok / 21 blocked). 17/17 tests. (completed 2026-05-12, commits 95df19b/a6f3502) (R3, R4, R6, R7, R8, R9, R11)
- [x] **16-04-PLAN.md** — Manual CLI + operator checkpoint: scripts/fix-image-pollution-manual.ts (1040 lines) — interactive readline walkthrough with literal DELETE/FORCE confirmations + --re-audit for R10 phase-close. Task 1 (CLI + 21 tests) shipped commit f976173. Task 2 (blocking human-verify checkpoint) approved 2026-05-13 via scripts/seed-checkpoint-test-data.ts + scripts/drive-checkpoint.ts + scripts/cleanup-checkpoint-test-data.ts — 7/8 plan criteria verified live on disposable CHECKPOINT-TEST-001/-002 pids, abort path covered by unit tests. (R5, R10, R11)

### Phase 17: Catalog Image Pollution Fix

**Goal:** Convert Phase 16's working-but-narrow audit/fix tooling into something that resolves the real pollution pattern surfaced by the first production audit on 2026-05-14 (213 polluted pids / 453 detections; 1 fully-fixed in Tier 1 vs 36 estimated). Close the audit-hang Drive timeout, route adidas/Bella/Gildan via S&S, add per-color supplier-canonical filtering, build a Model* image rebuild tool (69% of detected pollution), and patch three latent bugs (--dry-run trash gate, cleanup MANUAL/ blind spot, OpenAI billing-hard-limit short-circuit). Phase closes per Phase 16's R10 OR-path.
**Requirements**: R17-01, R17-02, R17-03, R17-04, R17-05, R17-06, R17-07, R17-08 (see 17-RESEARCH.md §Phase Requirements)
**Depends on:** Phase 16
**Plans:** 8 plans
**Validation:** [.planning/phases/17-catalog-image-pollution-fix/17-VALIDATION.md](phases/17-catalog-image-pollution-fix/17-VALIDATION.md)

Plans:
- [ ] **17-01-PLAN.md** — Drive fetch timeout (B-1): 30s gaxios timeout + 2-retry on all 4 Drive helpers. Wave 1 (blocking pre-req). (R17-01)
- [ ] **17-02-PLAN.md** — Per-color supplier-canonical: extend resolveSupplierCanonical(pid, colorName?) with S&S exact-match + CSW filename-substring + wasFallback flag. Wave 2. (R17-02)
- [ ] **17-03-PLAN.md** — Model image rebuild tool: NEW scripts/fix-model-images.ts (per D-17-01), 10-pid sample-test gate (per D-17-02) before full 213-pid run. tier=4 trail rows. Wave 3. (R17-03)
- [ ] **17-04-PLAN.md** — Prefix dispatcher widening: routesViaSS(pid) routes adidas A*/CE* + 19 KNOWN_SUPPLIER_PREFIXES brand pids through the existing S&S branch. No new scrapers (per RESEARCH Findings 1+2). Wave 3. (R17-04)
- [ ] **17-05-PLAN.md** — Manual triage residue via existing scripts/fix-image-pollution-manual.ts. Wave 4 (operator-driven). (R17-05)
- [ ] **17-06-PLAN.md** — B-2: gate trashDriveFile behind !args.dryRun at both manual CLI sites. Wave 1. (R17-06)
- [ ] **17-07-PLAN.md** — B-3: cleanup-checkpoint-test-data.ts also scans MANUAL/CHECKPOINT-TEST-*/. Wave 1. (R17-07)
- [ ] **17-08-PLAN.md** — B-4: detect OpenAI billing_hard_limit_reached once; widen TrailOperation with TIER2_BUDGET_EXHAUSTED; surface 'BILLING_LIMIT_HIT' in summary. Wave 1. (R17-08)

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
- [x] **Phase 16: Catalog Image Pollution Audit & Fix** - Tiered audit + auto-fix for identity pollution (wrong product images, shared URLs, mixed brands) across BR catalog (completed 2026-05-13)

---

### v3.0 Catalog Data Completion

**Milestone Goal:** Complete every Bestsellers-Ready row with standardized Drive image links and consumer-style categories + keywords, so each product is fully data-ready for store push.

## Phases

- [ ] **Phase 18: Drive to BR Image Linker** - Overwrite all 8 BR image columns with canonical Drive URLs; add 5 new columns; dry-run diff + backup before any apply
- [ ] **Phase 19: AI Category & Keyword Generation** - One gpt-4o-mini structured-output call per product fills baseCategory (controlled vocab), categories (Shopify taxonomy path), and keywords (consumer tags); checkpointed for usage-cap resilience

## Phase Details

### Phase 18: Drive to BR Image Linker
**Goal**: Every Bestsellers-Ready row has its image cells overwritten with the correct canonical Drive URL for that (productId, colorName) pair, 5 new image columns are added safely, and no existing valid link is silently destroyed
**Depends on**: Nothing (unblocked — v2.0 finalize confirmed 452/452 pid folders at plan=0)
**Requirements**: IMG-01, IMG-02, IMG-03, IMG-04, OPS-02, OPS-03
**Success Criteria** (what must be TRUE):
  1. Running `scripts/link-br-images.ts --dry-run` produces a TSV showing old→new per changed cell with no changes applied to the sheet
  2. Running `--apply` overwrites FrontImage, BackImage, DirectSideImage, and the 5 new columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack) with canonical `{Brand}-{pid}-{Color}-{Role}.png` Drive URLs for every matched (productId, colorName) pair
  3. A (pid, colorName) pair with no matching Drive file leaves the existing cell value unchanged and appears in the miss log — no empty string is ever written to a previously-populated cell
  4. Hyphenated-brand pids (e.g. Q-Tees H08050) produce the correct color token without brand-name leaking into the color — all Drive filenames are parsed pid-anchored, role-anchored
  5. Re-running `--apply` a second time produces zero net changes (idempotent)
**Plans**: TBD

### Phase 19: AI Category & Keyword Generation
**Goal**: Every product in Bestsellers-Ready has its baseCategory normalized to a controlled vocabulary, its categories column filled with a Shopify Standard Taxonomy leaf path, and its keywords column filled with consumer-style tag tokens — all produced by one structured-output call per unique productId, checkpointed so a mid-batch OpenAI usage-cap halt can resume without re-spending
**Depends on**: Phase 18 (categories column benefits from clean image state; baseCategory uses garment-type context from Drive filenames)
**Requirements**: CAT-01, CAT-02, CAT-03, KW-01, KW-02, KW-03, OPS-01, OPS-02
**Success Criteria** (what must be TRUE):
  1. Every product's `baseCategory` resolves to one of the 15 allowed garment-type vocabulary values; no product retains a generic supplier value (e.g. "Tops", "Sport Shirts") after the run
  2. Every product's `categories` column contains a valid Shopify Standard Taxonomy leaf-node path (e.g. "Apparel & Accessories > Clothing > Tops > T-Shirts"); no free-form or hallucinated paths are written
  3. Every product's `keywords` column contains 10-15 lowercase-hyphenated consumer tag tokens with zero color names, size names, style numbers, GSM values, or wholesale jargon present
  4. If the script is interrupted mid-batch (simulated by stopping after 50 products), re-running resumes from the checkpoint and completes the remaining ~241 products without duplicating any AI calls or overwriting already-written rows
  5. All 24,175 BR rows for a given productId receive the same baseCategory, categories, and keywords values — no per-row variance for the same product
**Plans**: TBD
**UI hint**: no

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
| 16. Catalog Image Pollution Audit & Fix | v2.0 | 4/4 | Complete    | 2026-05-13 |
| 18. Drive to BR Image Linker | v3.0 | 0/? | Not started | - |
| 19. AI Category & Keyword Generation | v3.0 | 0/? | Not started | - |
