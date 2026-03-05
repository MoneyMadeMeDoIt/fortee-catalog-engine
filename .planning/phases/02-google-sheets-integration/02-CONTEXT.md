# Phase 2: Google Sheets Integration - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Read product rows from the master Google Sheet, enrich them with supplier data from Phase 1 extractors, and write missing data back. The system scans all rows and fills gaps — it never overwrites existing data. The master sheet (`Master_Product_Variants_Media.xlsx` format, hosted on Google Sheets) contains one row per variant, keyed by PartID.

</domain>

<decisions>
## Implementation Decisions

### Sheet Structure & Product Identity
- Each row = one product variant, identified by **PartID** (unique key)
- Multiple rows share the same styleID (one product = many variants across size/color)
- Sheet already exists with populated data — this is enrichment, not creation
- System scans the entire sheet, not a subset of rows

### Column Mapping
35 columns in the master sheet:
- Identity: supplierCode, PartID, styleID, partNumber, brandName, productId
- Product: colorName, colorFamily, productName, description
- Images: FrontImage, BackImage, DirectSideImage, (empty col 14)
- Color: color1, color2
- Size: sizeName, sizePriceCodeName
- Pricing: costPrice
- Logistics: CaseQty, unitWeight, Qty, CaseWeight, BoxHeight, BoxLength, BoxWidth
- Classification: baseCategory, weightGSM, gender, fit, keywords, categories
- Details: careInstructions, Size Chart, Embroidery available, DTF available

### Merge Behavior
- **Fill gaps only** — only write to cells that are currently empty
- Never overwrite existing data, even if supplier data is newer/different
- Existing images from the spreadsheet are higher quality and take priority
- OneSource API images should ONLY fill missing image cells

### Size Chart Format
- Store as **structured text** in the "Size Chart" column (e.g., "S: Chest 36\", M: Chest 38\"...")
- Not image URLs — actual measurement data

### Target Fields for Enrichment
Priority fields to fill from supplier API:
1. Images (FrontImage, BackImage, DirectSideImage) — only if empty
2. Size Chart — structured text from supplier data
3. Description — only if empty
4. careInstructions — only if empty
5. Any other fields the API provides that are currently empty

### Authentication
- Google Sheets API via **service account** (standard approach)
- Credentials stored in `.env` (never committed)
- Research phase will include setup instructions if user doesn't have one yet

### Claude's Discretion
- Google Sheets library choice (googleapis vs simpler wrapper)
- Batch write strategy (row-by-row vs batch update)
- How to handle variants that don't match any supplier data
- Rate limiting approach for Sheets API
- Logging format for enrichment results

</decisions>

<specifics>
## Specific Ideas

- The master sheet file reference is `Master_Product_Variants_Media.xlsx` — actual sheet is on Google Sheets
- Supplier data comes from OneSource API (PromoStandards SOAP), already built in Phase 1
- Two suppliers: Canada Sportswear (`CANADASPORTSWEAR`) and S&S Canada (`SSCANADA`)
- The `supplierCode` column identifies which extractor to use per row

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-google-sheets-integration*
*Context gathered: 2026-03-05*
