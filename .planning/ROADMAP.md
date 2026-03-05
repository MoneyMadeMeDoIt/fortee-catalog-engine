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
- [ ] **Phase 3: Decoration Rules and Pricing** - Define decoration methods/placements per category and calculate sell prices
- [ ] **Phase 4: Shopify Product Push** - Create complete Shopify products from enriched sheet data via GraphQL API
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
**Plans**: TBD

Plans:
- [ ] 03-01: TBD

### Phase 4: Shopify Product Push
**Goal**: One command creates a complete Shopify product from an enriched sheet row -- with variants, images, metafields, metaobjects, and template assignment
**Depends on**: Phase 3
**Requirements**: SHOP-01, SHOP-02, SHOP-03, SHOP-04, SHOP-05, SHOP-06, SHOP-07
**Success Criteria** (what must be TRUE):
  1. Running the push command on an enriched product creates it in Shopify via GraphQL with Color x Size variants and correct base pricing
  2. Print Area metaobjects are created with the correct decoration method, placement, and pricing data, and linked to the product via metafields
  3. Supplier images are downloaded and uploaded to Shopify via staged uploads, appearing on the product
  4. The correct Dawn builder template is assigned based on the product's garment category
  5. Re-running the push on an existing product updates it instead of creating a duplicate
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 5: Scale and Reliability
**Goal**: The full pipeline handles 100+ products in a single batch run with visibility into what will happen, what is happening, and what went wrong
**Depends on**: Phase 4
**Requirements**: OPS-01, OPS-02, OPS-03
**Success Criteria** (what must be TRUE):
  1. Dry-run mode outputs exactly what would be created/updated in Shopify without making any changes
  2. Batch processing handles 100+ products with a progress indicator showing current product and completion percentage
  3. Each product reports success or failure with actionable error messages, and failures do not halt the entire batch
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Supplier Data Extraction | 4/4 | Complete   | 2026-03-05 |
| 2. Google Sheets Integration | 1/2 | In progress | - |
| 3. Decoration Rules and Pricing | 0/? | Not started | - |
| 4. Shopify Product Push | 0/? | Not started | - |
| 5. Scale and Reliability | 0/? | Not started | - |
