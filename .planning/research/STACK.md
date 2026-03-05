# Stack Research

**Domain:** Product catalog enrichment pipeline (scraping + Google Sheets + Shopify)
**Researched:** 2026-03-05
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 20 LTS | Runtime | LTS stability, native fetch, good async I/O for scraping + API work |
| TypeScript | 5.x | Type safety | Catches shape mismatches between supplier data, sheet schema, and Shopify API payloads before runtime |
| shopify-api-node | 3.x | Shopify Admin API client | Simpler than official @shopify/shopify-api for script-based workflows (no OAuth dance needed). Direct REST calls with access token. Battle-tested with 87k+ GitHub stars ecosystem |
| google-spreadsheet | 4.1.5 | Google Sheets read/write | Clean row-based API (`addRow`, `getRows`, `updateRow`). Service account auth. Wraps Sheets API v4 without the verbose googleapis SDK |
| Cheerio | 1.x | HTML parsing (Canada Sportswear) | Canada Sportswear runs on Shopify, pages are server-rendered. Cheerio is 70% faster than browser-based scrapers for static HTML. No headless browser overhead |
| Playwright | 1.x | Browser automation (S&S Canada fallback) | Only needed if any supplier pages require JavaScript rendering or login-gated content. Keep as optional dependency |

### Supplier Data Access

| Supplier | Method | Technology | Notes |
|----------|--------|-----------|-------|
| Canada Sportswear | Shopify JSON endpoints | fetch + Cheerio | Site is Shopify-based (`canada-sportswear-corp.myshopify.com`). Use `/products.json` and `/collections/*.json` endpoints for structured data. Fall back to HTML scraping with Cheerio for specs/size charts not in JSON |
| S&S Canada | Official API | fetch (REST) | S&S Activewear has an official REST API at `api.ssactivewear.com/V2/`. Returns JSON with SKUs, pricing, inventory, images. Requires account number + API key auth. **Do NOT scrape their website** -- S&S has sued scrapers (CFAA violations). Use the API |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| dotenv | 16.x | Environment variable loading | Always -- store Shopify access token, S&S API key, Google service account path |
| zod | 3.x | Runtime schema validation | Validate scraped data shapes before writing to sheets or Shopify. Catches malformed supplier data early |
| p-queue | 8.x | Concurrency control | Rate-limit Shopify API calls (50 points/sec standard). Queue scraping requests to avoid overwhelming suppliers |
| sharp | 0.33.x | Image processing | Resize/optimize supplier images before uploading to Shopify if needed |
| winston | 3.x | Structured logging | Log pipeline stages (scrape, enrich, push) with enough context to debug failures in 100+ product runs |
| tsx | 4.x | TypeScript execution | Run .ts scripts directly without build step. Simpler than ts-node for script-based workflows |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| tsx | Run TypeScript scripts directly | `npx tsx scripts/scrape.ts` -- no compile step needed |
| vitest | Unit/integration testing | Fast, TypeScript-native, good for testing data transformations |
| eslint + prettier | Code quality | Standard tooling |

## Key Architecture Decision: Script-Based, Not App-Based

This project is a **CLI pipeline triggered manually**, not a Shopify embedded app. This means:

- **No OAuth flow needed** -- use a Custom App access token from Shopify Admin
- **No web server needed** -- just TypeScript scripts run from terminal
- **shopify-api-node > @shopify/shopify-api** -- the official library is designed for embedded apps with OAuth, sessions, webhooks. Overkill for script-based access. `shopify-api-node` gives direct REST client with access token auth
- **No database needed** -- Google Sheets IS the database

## Shopify API Strategy

Use **GraphQL Admin API** (not REST) for product creation because:

1. **Bulk operations** -- create product + variants + metafields in fewer API calls
2. **No rate limit on bulk operations** -- bulk queries/mutations bypass the 50 pts/sec limit
3. **Better metafield support** -- can set metafields inline with `productCreate` mutation
4. **API version**: Use `2025-01` or later (supports 5 concurrent bulk operations per shop)

However, use `shopify-api-node` for making these GraphQL calls -- it handles auth and request formatting while allowing raw GraphQL queries.

## Installation

```bash
# Core
npm install shopify-api-node google-spreadsheet@4.1.5 cheerio zod dotenv p-queue winston sharp

# Dev dependencies
npm install -D typescript tsx vitest @types/node eslint prettier

# Optional (only if supplier pages need JS rendering)
npm install playwright
```

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| shopify-api-node | @shopify/shopify-api (official) | Official lib is designed for embedded apps with OAuth. Adds complexity (session management, webhook handlers) we don't need for a script-based pipeline |
| google-spreadsheet 4.x | googleapis (raw SDK) | Verbose, requires manual pagination, no row abstraction. google-spreadsheet wraps it cleanly |
| Cheerio | Puppeteer | Puppeteer launches a full Chromium browser. Canada Sportswear is static Shopify HTML -- no JS rendering needed. Cheerio is faster and lighter |
| Cheerio | Playwright | Same reasoning as Puppeteer. Keep Playwright as optional fallback only |
| zod | joi / yup | zod has better TypeScript inference. Validates and infers types from one schema definition |
| p-queue | bottleneck | p-queue is simpler, promise-native, actively maintained. bottleneck has more features but more complexity than we need |
| tsx | ts-node | tsx is faster (uses esbuild), zero-config, better for script execution |
| vitest | jest | vitest is faster, TypeScript-native without additional config, compatible Jest API |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Selenium / WebDriver | Massive overhead for static page scraping. Slow, fragile, resource-heavy | Cheerio for static HTML, Playwright only if JS rendering required |
| axios | Node.js 18+ has native `fetch`. No need for a third-party HTTP client | Built-in `fetch` or `node-fetch` for older Node versions |
| MongoDB / PostgreSQL | Over-engineered for this use case. Google Sheets is the data store by design | Google Sheets via google-spreadsheet |
| Shopify CSV import | No support for metafields, metaobjects, or print area configuration. Limited variant control | Shopify Admin API (GraphQL) |
| Python (Scrapy, BeautifulSoup) | Adds a second language to the stack. Node.js handles scraping + API calls + sheets in one runtime | Node.js + Cheerio |
| @shopify/shopify-api | Session management, OAuth flows, webhook registration -- none needed for manual script execution | shopify-api-node for simpler access-token auth |

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| shopify-api-node@3.x | Shopify API 2025-01+ | Supports both REST and GraphQL. Access token auth |
| google-spreadsheet@4.1.5 | Google Sheets API v4 | Requires google-auth-library for service account auth |
| cheerio@1.x | Node.js 18+ | ESM and CJS both supported |
| zod@3.x | TypeScript 5.x | Full type inference from schemas |

## Google Sheets Authentication

Use a **Google Cloud Service Account** (not OAuth):
1. Create service account in Google Cloud Console
2. Download JSON key file
3. Share the Google Sheet with the service account email
4. Load credentials from environment variable pointing to key file path

This avoids OAuth consent screens and refresh token management -- ideal for automated scripts.

## Sources

- [Shopify Admin API documentation](https://shopify.dev/docs/api/admin-graphql/latest) -- GraphQL product creation, rate limits (HIGH confidence)
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits) -- bulk operations bypass rate limits (HIGH confidence)
- [S&S Activewear API documentation](https://api.ssactivewear.com/V2/Products.aspx) -- official REST API with JSON/XML responses (HIGH confidence)
- [S&S Activewear lawsuit against scraping](https://members.asicentral.com/news/industry-news/september-2025/ss-activewear-files-lawsuit-accuses-promohunt-of-illegally-accessing-data/) -- legal risk of scraping S&S (HIGH confidence)
- [Canada Sportswear website](https://canadasportswear.com/) -- confirmed Shopify platform via page source inspection (HIGH confidence)
- [google-spreadsheet npm](https://www.npmjs.com/package/google-spreadsheet) -- v4.1.5 latest in 4.x line (MEDIUM confidence)
- [Cheerio vs Playwright comparison](https://blog.apify.com/playwright-vs-puppeteer/) -- Cheerio 70% faster for static HTML (MEDIUM confidence)
- [shopify-api-node npm](https://www.npmjs.com/package/shopify-api-node) -- community-maintained but simpler for scripts (MEDIUM confidence)

---
*Stack research for: Fortee Catalog Engine*
*Researched: 2026-03-05*
