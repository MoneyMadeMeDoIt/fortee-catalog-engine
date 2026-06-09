# Milestones

## v2.0 Image Automation (Shipped: 2026-06-09)

**Phases completed:** 10 phase dirs (08–17). 7 roadmap-tracked (08–13, 15) + 14/16/17 added ad-hoc during the milestone.

**Key accomplishments:**

- **Image quality scorer (08)** — sharp-based blur/resolution/blank-garment detection; QUALITY_THRESHOLDS calibrated against 243 real supplier images, cutting the false-reject rate from 100% to near-zero.
- **Image sourcing (09)** — parallel three-supplier sourcer (OMG OneSource, CSW Shopify storefront, S&S Canada REST) with quality-score winner selection and graceful credential degradation.
- **AI image generation (10)** — `generateGarmentView()` / `enhanceFrontImage()` via OpenAI images.edit() with 3-candidate selection, 15° hue-drift rejection, best-of-6 fallback, and a $200 budget-capped CostTracker.
- **Standardization & safe upload (11)** — fixed 85% garment-height on 2000×2000 canvas; writes standardized CDN URLs to Sheets without mutating store products.
- **Audit runner + CLI (12–13)** — `auditProductImages(styleID)` orchestrates score→source→generate→standardize→write; `audit-images.ts` exposes `--style-id`/`--all`/`--dry-run`.
- **Imagery cleanup & reconciliation (14)** — BR↔Drive↔Store reconciliation, `resolveStoreProduct` fail-loud helper, cross-pollution classification, BAD-ALT triage; audit dropped 973→25.
- **Garment-type verification (15)** — post-generation classifier rejecting AI views that drift garment shape (catches shape drift, not identity pollution).
- **Catalog image pollution audit + fix (16–17)** — 3-pass identity-pollution audit + tiered fix toolchain (supplier fetch / AI regen) with operator checkpoint; per-color + Model* handling.
- **Complete-Bestsellers Drive finalize (2026-06-09)** — standardized every pid folder to `{Brand}-{pid}-{Color}-{Role}.png`; verified complete (452/452, plan=0).

---

## v1.0 MVP (Shipped: 2026-03-26)

**Phases completed:** 8 phases, 17 plans, 22 tasks

**Key accomplishments:**

- TypeScript ESM project with SupplierProduct Zod validation gate, 7 passing tests, and test fixtures for both suppliers
- Cheerio-based body_html parser extracting fabric composition (gsm + percentages) and size chart PDF URLs, with paginated Shopify JSON fetch mapping to SupplierProduct
- S&S Canada REST API adapter with three-endpoint merge, HTML fabric parsing via cheerio, and 55 req/60s rate limiting via p-queue
- Google Sheets typed reader with service account auth, 36-column SheetRow mapping, and ragged-row handling via googleapis
- Fill-gaps-only merge logic with batch writer and enrichment CLI that populates empty sheet cells from supplier data without overwriting existing values
- 38 decoration placements from Print Areas guide codified as typed constants, pricing calculator verified against reference case ($14.08), and supplier category resolver with 20+ aliases
- Decoration enrichment pipeline connecting category-based rules and pricing calculator to Google Sheets with fill-gaps-only writes
- 3-option variant builder with category-based print_area_position metafields, simplified quick-order template, and Crewneck category support
- sharp-based image pipeline: download, resize to 2000x2000 with white background, upload via Shopify staged uploads with print-area alt text
- pushProduct wires variant builder, image standardizer, and metaobject lookup into complete Shopify push pipeline with 3-option products, print area metafields, and MOQ
- Garment-aware image standardizer using sharp.trim() to detect bounds, place at reference canvas ratio, and derive per-product print area percentage coordinates
- Removed hardcoded PRINT_AREA_COORDINATES constant, replaced with garment-detection-derived coords flowing from processProductImages through buildLinkedVariants to variant metafields
- One-liner:
- pushProduct now auto-creates and links a size_guides metaobject per product using spec sheet data, gated by SPEC_SHEET_GOOGLE_SPREADSHEET_ID env var, with non-fatal error handling so missing specs never break a product push.

### Known Gaps (Deferred)

- **OPS-01**: Dry-run mode — deferred to future milestone
- **OPS-02**: Batch processing 100+ products — deferred to future milestone
- **OPS-03**: Per-product error reporting — deferred to future milestone
- **Phase 05** (Scale & Reliability): 2 plans created but not executed — deferred
- **Phase 06** (Live Inventory Sync): Not planned — deferred

### Stats

- **Timeline:** 7 days (2026-03-05 → 2026-03-11)
- **Lines of code:** ~12,137 TypeScript
- **Files modified:** 288

---
