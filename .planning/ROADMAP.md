# Roadmap: Fortee Catalog Engine

## Overview

The Fortee Catalog Engine follows a natural ETL pipeline: extract supplier data, load it into Google Sheets, enrich it with decoration rules and pricing, push fully-formed products to Shopify, then harden for scale. Each phase delivers a complete, testable capability that unblocks the next. The end state is a single command that turns an enriched sheet row into a live Shopify product.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Supplier Data Extraction** - Build API clients for Canada Sportswear and S&S Canada that reliably pull product data (completed 2026-03-05)
- [ ] **Phase 2: Google Sheets Integration** - Read, write, and merge supplier data into the master Google Sheet
- [x] **Phase 3: Decoration Rules and Pricing** - Define decoration methods/placements per category and calculate sell prices (completed 2026-03-06)
- [ ] **Phase 4: Shopify Product Push** - Create complete Shopify products from enriched sheet data via GraphQL API (old store format)
- [ ] **Phase 4.1: Image Standardization & Print Area Detection** - Detect garment boundaries, standardize images, derive print area coordinates (INSERTED)
- [ ] **Phase 5: Scale and Reliability** - Handle 100+ products with dry-run mode, batch processing, and error reporting

## Phase Details

### Phase 1: Supplier Data Extraction
**Goal**: Operator can pull complete product data from both suppliers into a structured format ready for sheet enrichment
**Depends on**: Nothing (first phase)
**Requirements**: SUPP-01, SUPP-02, SUPP-03
**Success Criteria** (what must be TRUE):
  1. Running the Canada Sportswear extractor returns product images, descriptions, specs, size charts, and fabric composition for a given product
  2. Running the S&S Canada extractor returns equivalent product data via their REST API
  3. Extracted data is validated and any missing/invalid fields are reported before downstream use
**Plans**: 4 plans

Plans:
- [ ] 01-01-PLAN.md -- Project setup, types, Zod validation schemas, test fixtures (SUPP-03)
- [ ] 01-02-PLAN.md -- Canada Sportswear extractor with body_html parsing (SUPP-01)
- [x] 01-03-PLAN.md -- S&S Canada API client with rate limiting (SUPP-02)
- [ ] 01-04-PLAN.md -- Unified extraction entry point and CLI script (integration)

### Phase 2: Google Sheets Integration
**Goal**: System can read product rows from the master sheet, write enriched data back, and merge supplier data into the correct columns automatically
**Depends on**: Phase 1
**Requirements**: SHEET-01, SHEET-02, SHEET-03
**Success Criteria** (what must be TRUE):
  1. System connects to Google Sheets via service account and reads all product rows from the master sheet
  2. System can write enriched fields (supplier data, computed values) back to the sheet without corrupting existing data
  3. Running the enrichment merge on a product row populates the correct columns with supplier-extracted data
**Plans**: 2 plans

Plans:
- [x] 02-01-PLAN.md -- Types, column mapping, Sheets client, and row reader (SHEET-01)
- [ ] 02-02-PLAN.md -- Merge logic, batch writer, and enrichment CLI (SHEET-02, SHEET-03)

### Phase 3: Decoration Rules and Pricing
**Goal**: Every product in the sheet has correct decoration methods, placements, and calculated sell prices based on its garment category
**Depends on**: Phase 2
**Requirements**: DECOR-01, DECOR-02, PRICE-01
**Success Criteria** (what must be TRUE):
  1. Each garment category (hoodies, t-shirts, caps, etc.) has defined allowed decoration methods and placements sourced from the Print Areas Placement Guide
  2. Running the pricing calculator on a product produces the correct sell price (garment cost + decoration cost + margin) matching the pricing calculator spreadsheet
  3. Decoration rules and pricing are written to the sheet alongside supplier data for each product
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md -- Decoration types, rules from Print Areas guide, category map, and pricing calculator (DECOR-01, DECOR-02, PRICE-01)
- [ ] 03-02-PLAN.md -- Sheet integration: write decoration and pricing data to the master sheet (DECOR-01, DECOR-02, PRICE-01)

### Phase 4: Shopify Product Push
**Goal**: One command creates a complete Shopify product for the old store -- with Color x Size x # of Print Areas variants, standardized 2000x2000 images, print area metafields, existing metaobject linking, and quick-order template
**Depends on**: Phase 3
**Requirements**: SHOP-01, SHOP-02, SHOP-03, SHOP-04, SHOP-05, SHOP-06, SHOP-07
**Success Criteria** (what must be TRUE):
  1. Running the push command creates a Shopify product with Color x Size x # of Print Areas variants (3 options) and correct pricing per area count
  2. Products link to existing Print Area metaobjects (front-dtf, back-print) and have Minimum Order Quantity metafield set to "0"
  3. Supplier images are standardized to 2000x2000px and uploaded via staged uploads with correct alt text ("Front Print" / "Back Print")
  4. product.quick-order template is assigned to all supported categories (T-Shirt, Long Sleeve, Crewneck, Hoodie)
  5. Re-running the push on an existing product updates it instead of creating a duplicate
**Plans**: 3 plans

Plans:
- [ ] 04-01-PLAN.md -- Types, mutations, template-map, category-map, variant builder with 3-option support (SHOP-01, SHOP-02, SHOP-06, SHOP-07)
- [ ] 04-02-PLAN.md -- Image standardizer: sharp resize to 2000x2000 + staged uploads (SHOP-05)
- [ ] 04-03-PLAN.md -- Metaobject lookup, product push orchestrator, CLI update (SHOP-01 through SHOP-07)

### Phase 4.1: Image Standardization & Print Area Detection (INSERTED)

**Goal:** Automatically detect garment boundaries in supplier images, standardize to 2000x2000px with consistent garment-to-canvas ratio, and derive accurate print area coordinates from detected garment shape
**Requirements**: SHOP-05
**Depends on:** Phase 4
**Success Criteria** (what must be TRUE):
  1. Garment boundaries are detected in supplier images and the garment is scaled to a consistent proportion within the 2000x2000 canvas
  2. Print area coordinates are derived from the detected garment shape (not hardcoded) and accurately position the decoration zone
  3. The standardized images and derived coordinates integrate with the existing pushProduct flow
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd:plan-phase 04.1 to break down)

### Phase 5: Scale and Reliability
**Goal**: The full pipeline handles 100+ products in a single batch run with visibility into what will happen, what is happening, and what went wrong
**Depends on**: Phase 4
**Requirements**: OPS-01, OPS-02, OPS-03
**Success Criteria** (what must be TRUE):
  1. Dry-run mode outputs exactly what would be created/updated in Shopify without making any changes
  2. Batch processing handles 100+ products with a progress indicator showing current product and completion percentage
  3. Each product reports success or failure with actionable error messages, and failures do not halt the entire batch
**Plans**: 2 plans

Plans:
- [ ] 05-01-PLAN.md -- Dry-run preview module and pushProduct refactor for batch use (OPS-01)
- [ ] 05-02-PLAN.md -- Batch push orchestrator with error isolation, progress reporting, and CLI (OPS-02, OPS-03)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 4.1 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Supplier Data Extraction | 4/4 | Complete   | 2026-03-05 |
| 2. Google Sheets Integration | 1/2 | In progress | - |
| 3. Decoration Rules and Pricing | 2/2 | Complete   | 2026-03-06 |
| 4. Shopify Product Push | 0/3 | In Progress (replanned) |  |
| 4.1. Image Standardization & Print Area Detection | 0/0 | Not started | - |
| 5. Scale and Reliability | 0/2 | Not started | - |
