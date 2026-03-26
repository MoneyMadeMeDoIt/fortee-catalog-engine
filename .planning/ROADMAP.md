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

---

### 🚧 v2.0 Image Automation (In Progress)

**Milestone Goal:** Every product gets uniform, e-commerce-ready front/back/side images — audit existing for quality, replace bad ones, generate missing views, standardize all, and upload to Shopify.

## Phases

- [x] **Phase 08: Image Quality Scorer** - Sharp-based blur/resolution scoring on trimmed garment region with calibrated thresholds (completed 2026-03-26)
- [ ] **Phase 09: Image Sourcing** - Fallback chain fetching front/back/side images from OMG, CSW, and S&S Canada before AI
- [ ] **Phase 10: AI Image Generation** - OpenAI images.edit() generates missing back/side views with quality-gated candidate selection
- [ ] **Phase 11: Image Standardization & Safe Upload** - Standardize all accepted images to 2000x2000 and replace Shopify media using existing GIDs
- [ ] **Phase 12: Audit Runner** - Per-product orchestrator wiring scorer → source → generate → standardize → upload into a single end-to-end function
- [ ] **Phase 13: CLI Entry Point** - audit-images.ts CLI exposing the audit runner with --style-id, --all, and --dry-run flags

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
**Plans**: TBD

### Phase 10: AI Image Generation
**Goal**: The system generates back and side garment views from a front image using OpenAI images.edit(), selects the best of multiple candidates via quality scoring, and rejects outputs with color or proportion drift
**Depends on**: Phase 08, Phase 09
**Requirements**: AIGEN-01, AIGEN-02, AIGEN-03, AIGEN-04
**Success Criteria** (what must be TRUE):
  1. `generateGarmentView(frontBuffer, view)` returns a Buffer containing a back or side garment image that passes quality scoring
  2. The generator produces 3 candidates per view and returns the one with the highest quality score — never the raw first output
  3. Generated images where mean garment hue drifts more than 15 degrees from the front image are rejected and regenerated
  4. A product whose existing front image fails quality scoring gets an AI-generated replacement that passes scoring before it is accepted
**Plans**: TBD

### Phase 11: Image Standardization & Safe Upload
**Goal**: All accepted images (sourced or generated) are standardized to 2000x2000px with the garment scaled to a fixed target proportion of the canvas (uniform max height/width across all products), then uploaded to Shopify by merging with existing media GIDs
**Depends on**: Phase 08, Phase 09, Phase 10
**Requirements**: STD-01, STD-02, OUT-02
**Success Criteria** (what must be TRUE):
  1. Every image that enters the standardizer exits as a 2000x2000px JPEG with the garment scaled to a fixed target proportion (e.g., 85% max height) — two different products appear at the same visual size on the canvas
  2. Before any Shopify media mutation, existing product image GIDs are fetched and merged with incoming replacements — no pre-existing image disappears unless explicitly replaced
  3. A new image uploaded via staged upload appears on the correct Shopify product and is visible in the product media list
  4. Side-by-side comparison of any two standardized product images shows garments at uniform scale — no product appears visually larger or smaller than another
**Plans**: TBD

### Phase 12: Audit Runner
**Goal**: A single `auditProductImages(styleID)` function orchestrates the complete per-product pipeline — score existing images, source replacements, generate missing views, standardize, and upload — with each step's result logged
**Depends on**: Phase 08, Phase 09, Phase 10, Phase 11
**Requirements**: (integration — no new requirements; wires QUAL, SRC, AIGEN, STD, OUT components)
**Success Criteria** (what must be TRUE):
  1. Calling `auditProductImages('CSW-12345')` for a product with a missing back view results in a back image uploaded to Shopify
  2. A product with a low-quality front image has that image replaced (sourced or generated) and uploaded without manual intervention
  3. A product that already has passing front/back/side images is left unchanged — the runner does not re-upload or overwrite good images
  4. Each run produces a log entry per product showing which images passed, failed, were sourced, were generated, and were uploaded
**Plans**: TBD

### Phase 13: CLI Entry Point
**Goal**: Running `npx ts-node scripts/audit-images.ts` processes one or all products through the complete image audit pipeline and reports results to the console
**Depends on**: Phase 12
**Requirements**: OUT-01
**Success Criteria** (what must be TRUE):
  1. `npx ts-node scripts/audit-images.ts --style-id CSW-12345` processes a single product end-to-end and exits with code 0 on success
  2. `npx ts-node scripts/audit-images.ts --all` iterates all sheet rows and processes each through the audit runner
  3. `npx ts-node scripts/audit-images.ts --dry-run --style-id CSW-12345` scores and logs what would happen without writing to Shopify or Sheets
  4. After a successful `--style-id` run, the target product's Shopify listing shows updated front/back/side images with correct 2000x2000px dimensions
**Plans**: TBD

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
| 09. Image Sourcing | v2.0 | 0/TBD | Not started | - |
| 10. AI Image Generation | v2.0 | 0/TBD | Not started | - |
| 11. Image Standardization & Safe Upload | v2.0 | 0/TBD | Not started | - |
| 12. Audit Runner | v2.0 | 0/TBD | Not started | - |
| 13. CLI Entry Point | v2.0 | 0/TBD | Not started | - |
