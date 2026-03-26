# Milestones

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
