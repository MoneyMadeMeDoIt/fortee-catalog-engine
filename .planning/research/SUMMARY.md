# Research Summary: Fortee Catalog Engine

**Domain:** Product catalog enrichment pipeline (supplier scraping, Google Sheets data management, Shopify product automation)
**Researched:** 2026-03-05
**Overall confidence:** HIGH

## Executive Summary

The Fortee Catalog Engine is a data pipeline that pulls product information from two wholesale apparel suppliers (Canada Sportswear and S&S Canada), enriches it with decoration rules and pricing in Google Sheets, and pushes fully-formed products to Shopify. The entire stack runs in Node.js/TypeScript as manually-triggered CLI scripts -- no web server, no database, no embedded app framework needed.

A critical discovery during research: the two suppliers have very different data access methods. Canada Sportswear runs on Shopify, which means their product data is accessible via standard Shopify JSON endpoints (`/products.json`) and HTML parsing with Cheerio. S&S Canada (part of S&S Activewear) has an official REST API (`api.ssactivewear.com/V2/`) that provides product data in JSON format with account-based authentication. S&S has actively sued companies for scraping their website, so using their API is both the correct technical choice and a legal necessity.

The Shopify product creation side should use the GraphQL Admin API rather than REST. GraphQL supports bulk operations that bypass rate limits, allows setting metafields inline with product creation, and supports the metaobject references needed for print area configuration. The `shopify-api-node` community library is preferred over Shopify's official `@shopify/shopify-api` because this is a script-based pipeline, not an embedded app -- no OAuth, sessions, or webhook infrastructure needed.

Google Sheets serves as the single source of truth (the "database"), managed via the `google-spreadsheet` library with service account authentication. The pipeline pattern is straightforward: Extract (suppliers) -> Transform (enrich in sheets) -> Load (push to Shopify).

## Key Findings

**Stack:** Node.js/TypeScript scripts using shopify-api-node, google-spreadsheet, Cheerio, and S&S REST API. No framework, no database, no web server.
**Architecture:** Three-stage ETL pipeline (Scrape -> Enrich -> Push) with Google Sheets as the central data store.
**Critical pitfall:** S&S Canada must be accessed via their official API, not scraped. They have sued scrapers under CFAA. Canada Sportswear is Shopify-based, so use their JSON endpoints.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Supplier Data Extraction** - Build scrapers/API clients for both suppliers first, since everything downstream depends on having product data
   - Addresses: Scrape supplier product pages, enrich sheet rows
   - Avoids: S&S scraping legal risk (use API instead)

2. **Google Sheets Schema and Enrichment** - Define the sheet structure, write enrichment logic to merge supplier data with decoration rules and pricing
   - Addresses: Define decoration rules by category, pricing logic, sheet enrichment
   - Avoids: Premature Shopify integration before data model is solid

3. **Shopify Product Push** - Build the GraphQL-based product creation pipeline that reads enriched sheet data and creates products with correct variants, metafields, and metaobjects
   - Addresses: Generate Shopify-ready data, push via API, template assignment
   - Avoids: Rate limit issues (use bulk operations)

4. **Scale and Reliability** - Handle 100+ products, add error recovery, logging, retry logic
   - Addresses: Handle 100+ products at scale
   - Avoids: Silent failures in large batch runs

**Phase ordering rationale:**
- Supplier data must exist before enrichment can happen
- Enrichment must be complete before Shopify push makes sense
- Scale concerns are best addressed after the happy path works end-to-end

**Research flags for phases:**
- Phase 1: Needs deeper research on Canada Sportswear's specific product page structure and what data is/isn't in their Shopify JSON
- Phase 2: Standard patterns, but decoration rule schema needs domain-specific design
- Phase 3: Needs deeper research on Shopify metaobject creation for print areas and the exact GraphQL mutations needed
- Phase 4: Standard patterns for batching and error handling

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Well-established libraries, verified versions, clear rationale |
| Features | HIGH | Requirements are well-defined in PROJECT.md |
| Architecture | HIGH | Standard ETL pipeline pattern, no novel architecture needed |
| Pitfalls | HIGH | S&S legal risk verified with news sources, Shopify rate limits documented officially |

## Gaps to Address

- Exact Shopify GraphQL mutations for creating products with metaobject references (print areas) -- needs phase-specific research
- Whether Canada Sportswear's `/products.json` endpoint includes all needed data (size charts, fabric composition) or if HTML scraping is also needed
- S&S Canada API: need to confirm account access and whether the Canadian endpoint differs from the US one
- Google Sheets performance at scale -- how the `google-spreadsheet` library handles 100+ products with many columns
