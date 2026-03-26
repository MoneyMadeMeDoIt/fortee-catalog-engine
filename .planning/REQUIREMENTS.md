# Requirements: Fortee Catalog Engine — v2.0 Image Automation

**Defined:** 2026-03-26
**Core Value:** Every product gets uniform, e-commerce-ready front/back/side images — audit existing for quality, replace bad ones, generate missing views, standardize all, and upload to Shopify.

## v2.0 Requirements

### Image Quality Assessment

- [ ] **QUAL-01**: System scores each product image for blur, exposure, and resolution using sharp-based analysis on the trimmed garment region
- [ ] **QUAL-02**: System flags images below minimum quality thresholds as needing replacement (not just missing images)
- [ ] **QUAL-03**: Quality thresholds are calibrated against 50+ real supplier images before production use
- [ ] **QUAL-04**: Quality criteria account for mockup/visual generation use case — images must be clean blank garments suitable for client design overlays

### Image Sourcing

- [ ] **SRC-01**: System fetches product images from OrderMyGear OneSource API as a sourcing channel
- [ ] **SRC-02**: System re-fetches back and side images from S&S Canada API fields (colorBackImage, colorSideImage) not captured in v1.0
- [ ] **SRC-03**: System re-scrapes Canada Sportswear for additional image angles when available
- [ ] **SRC-04**: System implements a fallback chain (OMG → CSW → S&S → existing URL → AI generation) prioritizing cheapest sources first

### AI Image Generation

- [ ] **AIGEN-01**: System generates missing back and side views from a front image using OpenAI images.edit API
- [ ] **AIGEN-02**: System generates 2-3 candidates per view and selects the best match via color-distance and quality scoring
- [ ] **AIGEN-03**: System replaces existing images that fail quality scoring with AI-generated alternatives
- [ ] **AIGEN-04**: Generated images maintain color fidelity and garment proportions consistent with the source front image

### Image Standardization

- [ ] **STD-01**: All final images (sourced or generated) are standardized to uniform 2000x2000px dimensions with consistent garment-to-canvas ratio
- [ ] **STD-02**: Standardized images are uploaded to Shopify via staged uploads, replacing existing product media without breaking references

### Output

- [ ] **OUT-01**: Running the image pipeline produces e-commerce-ready front/back/side images for each product, uploaded to Shopify
- [ ] **OUT-02**: Existing Shopify product image GIDs are fetched before replacement to avoid accidental deletion via productSet

## Future Requirements (Deferred)

- **OPS-01**: Dry-run mode (deferred from v1.0)
- **OPS-02**: Batch processing 100+ products (deferred from v1.0)
- **OPS-03**: Per-product error reporting (deferred from v1.0)
- **INV-01**: Live inventory sync from suppliers via OneSource API (deferred from v1.0)

## Out of Scope

| Feature | Reason |
|---------|--------|
| On-model visualization | Breaks white-background garment pipeline and print area detection |
| Background replacement/scenes | Fortee's print area canvas requires white backgrounds |
| Image status columns in Google Sheet | User wants output (images uploaded to Shopify), not tracking columns |
| Web UI for image review | CLI with good logging is sufficient for single operator |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| QUAL-01 | TBD | Pending |
| QUAL-02 | TBD | Pending |
| QUAL-03 | TBD | Pending |
| QUAL-04 | TBD | Pending |
| SRC-01 | TBD | Pending |
| SRC-02 | TBD | Pending |
| SRC-03 | TBD | Pending |
| SRC-04 | TBD | Pending |
| AIGEN-01 | TBD | Pending |
| AIGEN-02 | TBD | Pending |
| AIGEN-03 | TBD | Pending |
| AIGEN-04 | TBD | Pending |
| STD-01 | TBD | Pending |
| STD-02 | TBD | Pending |
| OUT-01 | TBD | Pending |
| OUT-02 | TBD | Pending |

**Coverage:**
- v2.0 requirements: 16 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 16

---
*Requirements defined: 2026-03-26*
