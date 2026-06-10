# Requirements: Fortee Catalog Engine — v3.0 Catalog Data Completion

**Defined:** 2026-06-09
**Core Value:** One command turns an enriched sheet row into a live Shopify product with correct decoration options, placements, pricing, standardized images, and all customer-facing content.

## v1 Requirements

Requirements for the v3.0 milestone. Each maps to a roadmap phase.

### Image Linking (IMG)

- [x] **IMG-01**: Operator can populate every Bestsellers-Ready image cell from the standardized Drive library, overwriting existing values, joined by (productId, colorName) — Phase 18
- [x] **IMG-02**: The linker maps Drive LeftSide → the existing `DirectSideImage` column and adds 4 new BR columns — RightSide, ModelFront, ModelSide, ModelBack — filling each from its matching Drive role — Phase 18
- [x] **IMG-03**: Filenames are parsed pid-anchored (no hyphenated-brand color leak); a color with no matching Drive file is logged and the existing cell is left unchanged, never guessed — Phase 18
- [x] **IMG-04**: Operator gets a dry-run diff (old→new per changed cell) and a TSV backup of current image cells before any overwrite is applied — Phase 18

### Categories (CAT)

- [ ] **CAT-01**: System refines each product's `baseCategory` to a controlled garment-type vocabulary (one value per product)
- [ ] **CAT-02**: System fills `categories` with a consumer-facing Shopify Standard Product Taxonomy leaf path inferred per product
- [ ] **CAT-03**: AI category output is schema-constrained to the allowed taxonomy enum (temperature 0); unresolvable products are flagged, not silently mislabeled

### Keywords (KW)

- [ ] **KW-01**: System generates consumer-style keywords/tags per product into `keywords` (lowercase-hyphenated, ≤15, drawn from audience/garment/material/fit/use-case)
- [ ] **KW-02**: Keywords exclude color names, size names, style numbers, GSM values, and wholesale jargon
- [ ] **KW-03**: baseCategory refinement + categories + keywords are produced in one structured-output call per product (~291 calls), fanned out to all that product's variant rows

### Operations & Safety (OPS)

- [ ] **OPS-01**: AI generation is checkpointed per product so an OpenAI usage-cap halt or crash resumes without re-spending on completed products
- [ ] **OPS-02**: All v3.0 scripts are idempotent — re-running produces stable output and skips already-completed work
- [x] **OPS-03**: New BR columns are written by re-reading the header row immediately before the data write (no header-drift corruption on the shared 24k-row sheet) — Phase 18

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Shopify Push Wiring (PUSH)

- **PUSH-01**: Product push writes the Shopify Standard Product Taxonomy category (numeric categoryId) and product tags from the completed BR data
- **PUSH-02**: Setting the taxonomy category enables/populates the `target gender` category metafield

## Out of Scope

| Feature | Reason |
|---------|--------|
| Pushing completed products to the store | v3.0 completes the BR *data*; store push is a separate existing workflow |
| AI-generated keywords as SEO/meta-keyword ranking signals | Meta keywords are ignored by search engines; tags are for on-site filtering/collections only |
| Per-variant (color/size) AI calls | Categories/keywords are product-level; per-variant calls waste 24k× the cost with no benefit |
| Free-form / over-granular category strings | Break Shopify + Google/Meta feed exports; must resolve to a taxonomy leaf |
| Color names, size names, style numbers as tags | Generate near-duplicate filterable pages; not consumer search terms |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| IMG-01 | Phase 18 | Complete |
| IMG-02 | Phase 18 | Complete |
| IMG-03 | Phase 18 | Complete |
| IMG-04 | Phase 18 | Complete |
| CAT-01 | Phase 19 | Pending |
| CAT-02 | Phase 19 | Pending |
| CAT-03 | Phase 19 | Pending |
| KW-01 | Phase 19 | Pending |
| KW-02 | Phase 19 | Pending |
| KW-03 | Phase 19 | Pending |
| OPS-01 | Phase 19 | Pending |
| OPS-02 | Phase 18 + Phase 19 | In Progress (Phase 18 done) |
| OPS-03 | Phase 18 | Complete |

**Coverage:**
- v1 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-06-09*
*Last updated: 2026-06-09 — traceability filled after roadmap creation*
