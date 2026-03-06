# Requirements: Fortee Catalog Engine

**Defined:** 2026-03-05
**Core Value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, and all customer-facing content.

## v1 Requirements

### Supplier Data Extraction

- [x] **SUPP-01**: System can extract product data (images, descriptions, specs, size charts, fabric composition) from Canada Sportswear via Shopify JSON endpoints and HTML parsing
- [x] **SUPP-02**: System can fetch product data from S&S Canada via their official REST API (api.ssactivewear.com/V2/)
- [x] **SUPP-03**: System validates extracted supplier data and reports missing/invalid fields before enrichment

### Google Sheets

- [x] **SHEET-01**: System can read product rows from Google Sheets via API (service account auth)
- [x] **SHEET-02**: System can write enriched data back to Google Sheets
- [x] **SHEET-03**: System automatically merges supplier data into the correct sheet columns per product

### Decoration & Pricing

- [x] **DECOR-01**: System defines allowed decoration methods and placements per garment category (hoodies, t-shirts, caps, etc.)
- [x] **DECOR-02**: Decoration rules are sourced from the Print Areas Placement Guide
- [x] **PRICE-01**: System calculates full sell price per product (garment cost + decoration cost + margin) based on the pricing calculator model

### Shopify Product Push

- [ ] **SHOP-01**: System creates products in Shopify via GraphQL productSet mutation
- [ ] **SHOP-02**: System generates Color x Size variants (~98 per product) with correct base pricing
- [ ] **SHOP-03**: System creates Print Area metaobjects with decoration method, placement, and pricing data
- [ ] **SHOP-04**: System assigns metafields to products referencing the correct Print Area metaobjects
- [ ] **SHOP-05**: System downloads supplier images and uploads them to Shopify via staged uploads
- [ ] **SHOP-06**: System assigns the correct Dawn builder template to each product based on category
- [ ] **SHOP-07**: System is idempotent — re-running updates existing products instead of creating duplicates

### Operational

- [ ] **OPS-01**: System supports dry-run mode showing exactly what would be created/updated before pushing
- [ ] **OPS-02**: System can batch-process 100+ products with progress reporting
- [ ] **OPS-03**: System reports per-product success/failure status with actionable error messages

## v2 Requirements

### Supplier Enrichment

- **SUPP-04**: Incremental updates — only fetch changed products from suppliers
- **SUPP-05**: AI-rewritten product descriptions for brand voice consistency

### Decoration

- **DECOR-03**: Per-product decoration rule overrides (beyond category defaults)

### Operational

- **OPS-04**: Automatic sync between Google Sheets and Shopify (webhook or polling)
- **OPS-05**: Diff-based updates — only push changed fields to Shopify

## Out of Scope

| Feature | Reason |
|---------|--------|
| Web UI / Dashboard | Single operator system — CLI with good logging is sufficient |
| Database (PostgreSQL, MongoDB) | Google Sheets IS the database by design |
| S&S Canada web scraping | S&S has sued scrapers under CFAA — use their official API |
| Real-time auto-sync | Creates race conditions, unpredictable states — manual trigger for v1 |
| Multi-channel publishing | Shopify only — architecture shouldn't preclude it later |
| Dawn builder wizard theme | Separate project, partially built |
| Cart Transform Function | Separate Shopify app deployment |
| Draft order webhook app | Separate concern |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SUPP-01 | Phase 1 | Complete |
| SUPP-02 | Phase 1 | Complete |
| SUPP-03 | Phase 1 | Complete |
| SHEET-01 | Phase 2 | Complete |
| SHEET-02 | Phase 2 | Complete |
| SHEET-03 | Phase 2 | Complete |
| DECOR-01 | Phase 3 | Complete |
| DECOR-02 | Phase 3 | Complete |
| PRICE-01 | Phase 3 | Complete |
| SHOP-01 | Phase 4 | Pending |
| SHOP-02 | Phase 4 | Pending |
| SHOP-03 | Phase 4 | Pending |
| SHOP-04 | Phase 4 | Pending |
| SHOP-05 | Phase 4 | Pending |
| SHOP-06 | Phase 4 | Pending |
| SHOP-07 | Phase 4 | Pending |
| OPS-01 | Phase 5 | Pending |
| OPS-02 | Phase 5 | Pending |
| OPS-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-03-05*
*Last updated: 2026-03-05 after roadmap creation*
