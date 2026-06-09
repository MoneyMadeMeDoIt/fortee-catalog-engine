# Technology Stack

**Project:** Product Curation/Filtering System (Catalog Reducer)
**Researched:** 2026-03-31
**Scope:** This file covers ONLY the catalog curation feature. See prior STACK.md content in git history for v2.0 Image Automation stack.

## Recommended Stack

### Core — No New Dependencies

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| TypeScript (ESM) | existing | Script logic, scoring engine | Already the project language |
| `googleapis` | existing (^171.4.0) | Read 43,130 rows from Google Sheet | `readAllRows()` already implemented |
| `zod` | existing (^4.3.6) | Validate scoring config / weight schema | Already used throughout |
| `winston` | existing (^3.19.0) | Log scoring decisions | Already configured |
| `tsx` | existing (^4.21.0) | Run curation script | Standard runner |

### Optional — For Output
| Technology | Version | Purpose | When to Use |
|------------|---------|---------|-------------|
| `csv-stringify` | 4.x (new) | Export curated list as CSV | Only if operator prefers CSV over sheet write-back |

**Bottom line: zero new dependencies for the core feature.** The entire curation engine is pure data processing on existing `SheetRow` data.

## Supplier API Capabilities for Curation

### S&S Activewear / S&S Canada API (Confirmed)

**Endpoint:** `api.ssactivewear.com/V2/Products.aspx`

| Field | Curation Use | Available |
|-------|-------------|-----------|
| `closeout` | Exclude dying products | YES (warehouse-level boolean) |
| `qty` | Stock depth signal | YES (per warehouse) |
| `salePrice` / `saleExpiration` | Promotional activity indicator | YES |
| Popularity ranking | Proxy for demand | NO -- does not exist |
| Bestseller flag | Direct signal | NO -- does not exist |
| New arrival flag | Freshness signal | NO -- arrival date not exposed |
| Featured/recommended | Curated signal | NO -- does not exist |
| Order frequency / sales velocity | Direct demand data | NO -- not exposed to API consumers |

**Confirmed absent after checking API documentation directly.** The S&S API is a product catalog and inventory API, not a merchandising API. It exposes what products exist and what stock is available -- nothing about how well they sell.

### Canada Sportswear (CSW)

| Signal | Available | How |
|--------|-----------|-----|
| Closeouts list | YES | Scrape `canadasportswear.com/collections/closeouts` |
| New Arrivals list | YES | Scrape `canadasportswear.com/collections/new-arrivals` |
| Popularity ranking | NO | No API, no public sorting by popularity |

### External Popularity Sources (Evaluated, Not Recommended for MVP)

| Source | Signal Quality | Effort | Recommendation |
|--------|---------------|--------|----------------|
| Google Trends API | LOW -- searches for "Gildan 5000" vs "BC 3001" are too noisy | High (rate limits, parsing) | Skip |
| Amazon bestseller lists | MEDIUM -- relevant for retail, less for wholesale/decoration | High (scraping, matching) | Skip |
| Supplier website "featured" pages | LOW -- editorial curation, not demand data | Medium (fragile scraping) | Skip |
| Industry knowledge (hardcoded) | HIGH -- decorators know which styles move | Low (manual list) | USE THIS |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Popularity signal | Industry bestseller list (hardcoded) | Google Trends API | Noisy signal, rate limits, Python dependency for marginal improvement |
| Data storage | In-memory (Map/Array) | SQLite | 941 styles fit in memory; SQL adds complexity for no benefit |
| Scoring engine | Custom TypeScript | ML clustering (k-means on features) | No training data, purely algorithmic approach is more predictable |
| Output format | Google Sheet write-back | Separate CSV file | Sheet write-back uses existing `EnrichmentUpdate` pattern |

## Installation

```bash
# No installation needed for core feature
# Everything uses existing dependencies
```

## Sources

- [S&S Activewear Products API](https://api.ssactivewear.com/V2/Products.aspx) -- confirmed available fields (HIGH)
- [S&S Canada Integration Page](https://en-ca.ssactivewear.com/marketing/edi) -- API access info (HIGH)
- [Canada Sportswear Closeouts](https://canadasportswear.com/collections/closeouts) -- scrapable product list (MEDIUM)
- [Canada Sportswear New Arrivals](https://canadasportswear.online/newsite/product-category/all-products/new-arrivals/) -- scrapable product list (MEDIUM)
- [Google Trends API Alpha](https://developers.google.com/search/apis/trends) -- available but noisy for product-level queries (MEDIUM)

---
*Researched: 2026-03-31*
