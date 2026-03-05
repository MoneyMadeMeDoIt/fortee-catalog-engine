# Domain Pitfalls

**Domain:** Custom apparel catalog enrichment pipeline + Shopify product automation
**Researched:** 2026-03-05

## Critical Pitfalls

Mistakes that cause rewrites, legal issues, or major data corruption.

### Pitfall 1: Scraping S&S Canada Website Instead of Using Their API
**What goes wrong:** S&S Activewear filed a lawsuit in September 2025 under the Computer Fraud and Abuse Act against PromoHunt for scraping their website. They actively protect against unauthorized data access.
**Why it happens:** Developers default to scraping without checking for official APIs. S&S's website requires login, tempting automated login flows.
**Consequences:** Legal action. Account termination. Loss of supplier relationship.
**Prevention:** Use the official S&S Activewear REST API at `api.ssactivewear.com/V2/`. Requires account number + API key (available in account settings). Returns JSON with products, pricing, inventory, images.
**Detection:** Any code that fetches `ssactivewear.com` or `en-ca.ssactivewear.com` HTML pages is wrong.

### Pitfall 2: `productSet` Mutation Silently Deletes Omitted Variants
**What goes wrong:** The `productSet` GraphQL mutation treats list fields (variants, metafields) as **replace-not-merge**. Send 3 of 98 variants, and the other 95 are deleted. Same for metafields.
**Why it happens:** Developers assume `productSet` works like a PATCH. It does for scalar fields (title, description), but for lists it replaces the entire set.
**Consequences:** Products lose variants and metafields on re-run. Print Area references vanish. Store products become broken.
**Prevention:** Always fetch current product state before calling `productSet`. Include ALL existing variants and metafields in the mutation, plus any changes. Build an explicit merge layer.
**Detection:** Products losing variants after script re-runs. Metafields disappearing.

### Pitfall 3: Using REST API for Products (Deprecated)
**What goes wrong:** Building on Shopify REST Admin API for product operations. REST is deprecated for products (API 2024-04+) and limited to 100 variants per product. Color x Size can hit ~98 variants -- zero room for error.
**Why it happens:** Most tutorials and Stack Overflow answers still reference REST. Training data lags behind Shopify's deprecation.
**Consequences:** Hit 100-variant hard cap. Must rewrite entire push pipeline to GraphQL.
**Prevention:** Use GraphQL Admin API exclusively. `productSet` handles product + variants + metafields + media in one call. Async mode supports 2048 variants.
**Detection:** Imports of REST product endpoint URLs. 100-variant limit errors.

### Pitfall 4: Shopify Rate Limit Exhaustion (429 Errors)
**What goes wrong:** Creating 100+ products without throttling. Each `productSet` costs ~10 points. 50 pts/sec budget = ~5 products/sec max. Exceeding causes 429 errors and partial product creation.
**Why it happens:** Using `Promise.all` or tight loops. Not accounting for query cost.
**Consequences:** Partial product creation. Some products created, others not. Inconsistent state.
**Prevention:** Use p-queue with concurrency limits (2-3 concurrent mutations max). Implement retry with backoff on 429. Make pipeline resumable.
**Detection:** 429 HTTP responses. Products missing variants or metafields.

## Moderate Pitfalls

### Pitfall 1: Google Sheets API Quota Exhaustion
**What goes wrong:** Reading/writing row-by-row (calling `row.save()` per cell) exhausts Google Sheets API rate limits (300 reads/min).
**Prevention:** Batch reads/writes. Load all rows at start, process in memory, write in batches. Use `sheet.saveUpdatedCells()` for bulk writes.

### Pitfall 2: Canada Sportswear JSON Endpoint Missing Data
**What goes wrong:** `/products.json` provides basic product data but size charts, fabric specs, and detailed descriptions may only be in the HTML body.
**Prevention:** Two-step extraction: JSON first (structured data), HTML scraping with Cheerio second (specs, size charts). Validate that required fields are populated.

### Pitfall 3: Metaobject Reference Integrity
**What goes wrong:** Print Area metaobjects deleted and recreated get new GIDs. All product references become dangling pointers. Builder wizard shows no decoration options.
**Prevention:** Use metaobject `handle` fields for stable identification. Build idempotent setup script. Never delete and recreate in production -- update in place.

### Pitfall 4: Flat Sheet to Hierarchical Product Mismatch
**What goes wrong:** Sheet has one row per variant (color/size). Shopify expects product -> options -> variants hierarchy. Incorrect grouping creates duplicate products or wrong variant assignments.
**Prevention:** Build explicit grouping logic: group rows by style number, then by color, then by size. Validate that each product has consistent options. Enforce Option1=Color, Option2=Size always.

### Pitfall 5: Image URL Instability
**What goes wrong:** Supplier image URLs change or expire. Products reference broken images.
**Prevention:** Download images from suppliers and upload to Shopify CDN during product creation. Never reference external URLs in final products.

### Pitfall 6: Daily Variant Creation Throttle (Post-50K)
**What goes wrong:** After 50,000 total store variants, Shopify limits new variant creation to 1,000/day. With ~98 variants/product, that's only ~10 products/day.
**Prevention:** Calculate total variant count before bulk import. If near 50K, plan multi-day imports. Build resumable pipeline with checkpoint tracking.

## Minor Pitfalls

### Pitfall 1: Character Encoding (French Content)
**What goes wrong:** French characters (accents, special chars) get garbled in scraping or API calls.
**Prevention:** Ensure UTF-8 throughout. Test with French product names early.

### Pitfall 2: Price Rounding
**What goes wrong:** Floating-point artifacts ($24.999999). Shopify prices are in cents.
**Prevention:** All pricing math in cents (integers). Round at final step. Convert to dollars only for display.

### Pitfall 3: Shopify API Version Deprecation
**What goes wrong:** Using an API version that gets deprecated.
**Prevention:** Use recent stable version (2025-01+). Shopify versions have 12-month lifecycle. Set reminder to update.

### Pitfall 4: Sheet Schema Drift
**What goes wrong:** Manual edits rename columns, add rows, change formats. Scripts break.
**Prevention:** Validate sheet schema at script start (check column headers). Document expected schema.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Project setup | API token in source code | `.env` file + `.gitignore`. Minimum scopes: `write_products`, `read_products`, `write_files` |
| Supplier extraction | S&S scraping legal risk | Use official API, never scrape website |
| Supplier extraction | Canada Sportswear JSON data gaps | Two-step: JSON + HTML parsing |
| Supplier extraction | Scraper breaks on HTML changes | Validation gate on scraped data, reject empty required fields |
| Sheet enrichment | Google Sheets quota exhaustion | Batch reads/writes, not per-cell saves |
| Sheet enrichment | Schema drift from manual edits | Validate headers at script start |
| Decoration rules | Rule complexity explosion | Start category-based, add per-product overrides later |
| Pricing | Floating point errors | Integer math in cents |
| Shopify push | Rate limit exhaustion | p-queue with concurrency limits |
| Shopify push | `productSet` deletes omitted variants | Always send complete variant+metafield list |
| Shopify push | Metaobject ordering | Create metaobjects BEFORE products reference them |
| Shopify push | Duplicate creation on re-run | Idempotent push via handle matching |
| Scale (100+) | Variant daily creation limit | Check store variant count, plan multi-day if >50K |

## Sources

- [S&S Activewear lawsuit](https://members.asicentral.com/news/industry-news/september-2025/ss-activewear-files-lawsuit-accuses-promohunt-of-illegally-accessing-data/) -- HIGH confidence
- [Shopify productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) -- HIGH confidence
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits) -- HIGH confidence
- [Shopify REST deprecation](https://shopify.dev/changelog/deprecation-timelines-related-to-new-graphql-product-apis) -- HIGH confidence
- [Google Sheets API limits](https://developers.google.com/workspace/sheets/api/limits) -- HIGH confidence
- [Shopify metaobject docs](https://shopify.dev/docs/apps/build/custom-data/metaobjects/manage-metaobjects) -- HIGH confidence
- Canada Sportswear site analysis -- confirmed Shopify platform (HIGH confidence)

---
*Pitfalls research for: Fortee Catalog Engine*
*Researched: 2026-03-05*
