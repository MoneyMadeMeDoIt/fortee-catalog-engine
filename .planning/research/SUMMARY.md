# Research Summary: Product Curation/Filtering System

**Domain:** Wholesale apparel catalog curation for custom decoration business
**Researched:** 2026-03-31
**Overall confidence:** MEDIUM-HIGH

## Executive Summary

Fortee has 941 unique styles across ~20 brands in a Google Sheet with 43,130 rows (each row = one color/size combo). The goal is to reduce this to a manageable curated catalog (recommended: 200-300 styles) while maintaining full category coverage across all brands. The core challenge is determining "popularity" without sales data.

The key finding is that supplier APIs (S&S Canada, Canada Sportswear) do NOT expose popularity rankings, bestseller flags, or sort-by-popular endpoints. The S&S Activewear API provides a `closeout` flag at the warehouse level (useful for excluding dying products) but nothing for popularity. This means popularity must be inferred from proxy signals: color count breadth (more colors = supplier invests more = higher demand), size range inclusivity, stock depth (Qty field), and industry knowledge about which specific style numbers are known bestsellers (e.g., BELLA+CANVAS 3001, Gildan 64000, Next Level 3600).

The recommended approach is a composite scoring system applied per style, computed from the existing sheet data alone -- no external APIs needed for the MVP. The scoring formula weights color count (30%), size range (25%), stock availability (20%), and category/brand balance constraints (25% as post-score adjustments). This can be implemented as a single TypeScript script that reads the sheet, scores all 941 styles, and outputs a ranked list with recommended keep/drop decisions. The scoring is deterministic and repeatable, meaning it can be re-run whenever the sheet data changes.

The existing CATALOG-CURATION-REPORT.md already contains excellent domain research on fabric compositions, market trends, and a detailed scoring model. This new research focuses on the practical implementation: what data is actually available, how to compute scores from it, what target catalog size to aim for, and how to structure the filtering pipeline.

## Key Findings

**Stack:** No new dependencies needed -- pure data processing on existing SheetRow data using TypeScript. Optional: `pytrends` or Google Trends API for external popularity validation (not recommended for MVP).
**Architecture:** Single script that groups sheet rows by styleID, computes per-style metrics, applies scoring formula, enforces category/brand quotas, outputs a curated list.
**Critical pitfall:** Over-indexing on a single brand (e.g., Gildan has the most styles) or category (e.g., t-shirts) -- quota-based selection is mandatory, not optional.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Data Aggregation & Scoring** - Group 43K rows into 941 style profiles, compute per-style metrics (color count, size range, stock depth, price tier)
   - Addresses: Scoring system, data transformation
   - Avoids: Pitfall of treating each row independently instead of aggregating to style level

2. **Category & Brand Quota Engine** - Define target counts per category per brand, apply quotas after scoring
   - Addresses: Category coverage, brand balance, price tier representation
   - Avoids: Pitfall of selecting only premium or only budget items, under-representing small brands

3. **Industry Bestseller Overlay** - Hardcode known industry bestsellers (BC 3001, G64000, NL 3600, etc.) with score bonuses
   - Addresses: Popularity without sales data
   - Avoids: Pitfall of purely data-driven selection missing obviously popular products

4. **Output & Review** - Generate ranked list with keep/drop recommendations, export to sheet or CSV for manual review
   - Addresses: Human oversight before committing to catalog changes
   - Avoids: Pitfall of automated filtering without operator review

**Phase ordering rationale:**
- Phase 1 must come first because all downstream logic depends on style-level aggregated metrics
- Phase 2 follows because quotas shape the selection boundaries before individual scores matter
- Phase 3 is an overlay on scored results, not a replacement -- it boosts known bestsellers
- Phase 4 is last because the output format is the simplest part and depends on all prior computation

**Research flags for phases:**
- Phase 3: May need manual research to compile the full industry bestseller list per brand -- standard patterns exist but brand-specific style numbers require catalog familiarity
- Phase 1-2: Standard data processing patterns, unlikely to need additional research

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Pure TypeScript data processing on existing types -- no new dependencies |
| Features | MEDIUM-HIGH | Scoring formula is well-defined; popularity proxy signals are the weakest area |
| Architecture | HIGH | Simple pipeline pattern: read -> aggregate -> score -> quota -> output |
| Pitfalls | MEDIUM-HIGH | Brand/category imbalance is the primary risk; supplier API limitations confirmed |

## Gaps to Address

- Exact category distribution in the current 941 styles (need to query actual sheet to know how many t-shirts vs hoodies vs jackets exist)
- Per-brand style counts (some brands may have 5 styles total, making "top N per brand" irrelevant)
- Whether the `closeout` flag from S&S API is already captured in the sheet data
- Validation of the scoring formula against the user's intuition (run once, review results, adjust weights)
