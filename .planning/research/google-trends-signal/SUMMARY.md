# Research Summary: Google Trends as a Popularity Signal for Catalog Curation

**Domain:** Search trend data for wholesale apparel style filtering
**Researched:** 2026-03-31
**Overall confidence:** HIGH

## Executive Summary

Google Trends is NOT worth integrating into the Fortee catalog scoring system. The engineering effort is disproportionate to the signal quality, and the signal itself has fundamental problems for this use case.

The core issue is that Google Trends measures *consumer search interest*, but Fortee's customers are *decorators and businesses* ordering blank apparel -- not end consumers searching for style numbers. The people who search "Bella Canvas 3001" are screen printers, DTG operators, and print-on-demand sellers -- which means Google Trends would measure *decorator popularity*, not *end-consumer demand*. This is a useful but redundant signal: the styles decorators search for are already well-known bestsellers (BC 3001, Gildan 18500, NL 3600, Gildan 5000). A hardcoded bestseller list captures this signal with zero engineering effort.

Furthermore, the technical barriers are significant. The official Google Trends API (launched July 2025) is in alpha with waitlist access only. The primary unofficial library (pytrends) was archived in April 2025 and plagued by 429 rate-limit errors. Scraping APIs cost $75-400/month. For a one-time curation of 941 styles, this is unjustifiable.

The existing scoring model (color count, size range, fabric differentiation, stock reliability, fit modernity, decoration versatility, unique features, trend alignment) already captures the dimensions that actually matter for catalog curation. Adding a Google Trends signal would marginally reorder a few mid-tier styles at best, and introduce false signals at worst.

## Key Findings

**Stack:** No viable free programmatic access to Google Trends. Official API is alpha/waitlist. pytrends is archived. Paid scraping APIs ($75-400/mo) exist but are overkill.

**Signal quality:** Style numbers DO get searched (by decorators, not consumers), but only the top ~20-30 bestsellers have meaningful volume. The remaining 900+ styles would return zero or near-zero data, making the signal useless for differentiation.

**Critical pitfall:** Google Trends returns RELATIVE interest (0-100 within a query), and you can only compare 5 terms at a time. Normalizing across 188+ batches of 5 is statistically unreliable and would produce misleading rankings.

## Recommendation: Do NOT Integrate Google Trends

Instead, enhance the existing scoring model with these zero-cost improvements:

1. **Expand the hardcoded bestseller list** from ~10 to ~30 styles using publicly available "top sellers" lists from S&S Activewear, SanMar, and alphabroder.
2. **Add a "brand tier" signal** -- Bella+Canvas and Next Level styles score higher than equivalent Harriton or Devon & Jones styles in casual categories (reversed for corporate/uniform categories).
3. **Use distributor "featured" / "top seller" badges** as a proxy -- these are already embedded in supplier data and reflect actual wholesale purchase volume.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| API access barriers | HIGH | Official docs confirm alpha-only; pytrends archived confirmed via GitHub |
| Signal quality for style numbers | HIGH | Validated via search results -- only top sellers have volume |
| Normalization problem | HIGH | Well-documented Google Trends limitation |
| Cost-benefit conclusion | HIGH | Engineering effort clearly exceeds marginal signal value |

## Gaps to Address

- If Fortee later gets actual sales data (even 2-3 months), that would be a far superior popularity signal worth integrating.
- Distributor APIs (S&S, SanMar) may expose bestseller rankings or sales velocity -- worth investigating when those integrations are built.
