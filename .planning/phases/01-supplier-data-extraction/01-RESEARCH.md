# Phase 1: Supplier Data Extraction - Research

**Researched:** 2026-03-05
**Domain:** Web scraping (Shopify storefront JSON) + REST API consumption (S&S Activewear)
**Confidence:** HIGH

## Summary

Phase 1 extracts product data from two wholesale apparel suppliers with fundamentally different access methods. Canada Sportswear runs on Shopify, exposing a public `/collections/all/products.json` endpoint that returns structured product data (title, variants, images, tags, product_type) plus an HTML `body_html` field containing fabric composition as inline text and links to downloadable PDF size charts/spec sheets. S&S Canada provides an official REST API at `api.ssactivewear.com/V2/` with Basic Auth (account number + API key), returning detailed product data across three endpoints: Products (SKUs, pricing, colors, sizes, images), Styles (descriptions with fabric composition embedded in the description field), and Specs (size chart measurements).

The Canada Sportswear catalog is small (~70-80 products across 3 pages of paginated results from `/collections/all/products.json?limit=250`). Pagination uses the `?page=N` parameter. The body_html contains fabric specs as plain text (e.g., "280 gsm - 8.3 oz./yd2 - 14 oz./lin. yd 70% cotton, 30% polyester vintage wash fleece") rather than structured HTML tables, so extraction requires text parsing with regex rather than DOM traversal. Size charts are linked as downloadable PDFs, not embedded -- this is a gap that may require PDF parsing or manual entry.

The S&S API has a rate limit of 60 requests per minute (tracked via `X-Rate-Limit-Remaining` response header). Their catalog is much larger. Fabric composition is embedded in the Styles endpoint `description` field (HTML format). No separate fabric field exists. The API returns JSON by default.

**Primary recommendation:** Use native `fetch` + Cheerio for Canada Sportswear body_html parsing, and native `fetch` with Basic Auth for S&S API. Validate all extracted data with Zod schemas. Use p-queue for S&S rate limiting (60 req/min). Output a normalized `SupplierProduct` interface ready for Google Sheets.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUPP-01 | Extract product data (images, descriptions, specs, size charts, fabric composition) from Canada Sportswear via Shopify JSON endpoints and HTML parsing | Use `/collections/all/products.json?limit=250&page=N` for structured data. Parse `body_html` with Cheerio for fabric composition (inline text). Size charts are PDF links -- extract URLs, flag for manual review if content needed. Images from `images[].src`. |
| SUPP-02 | Fetch product data from S&S Canada via official REST API | Three endpoints needed: `/v2/styles/` (descriptions, fabric in HTML description field, style images), `/v2/products/` (SKUs, colors, sizes, pricing, color images), `/v2/specs/` (size measurements). Basic Auth with account number + API key. |
| SUPP-03 | Validate extracted supplier data and report missing/invalid fields before enrichment | Zod schemas for `SupplierProduct` interface. Validate required fields (title, at least 1 image, fabric composition, at least 1 variant). Report missing fields per product with actionable messages. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js native `fetch` | 20 LTS built-in | HTTP requests to both suppliers | No third-party HTTP client needed. Handles JSON + HTML responses. |
| cheerio | 1.0.0 | Parse Canada Sportswear body_html | Fast HTML parser for extracting fabric specs from inline HTML text. jQuery-like API. No browser overhead. |
| zod | 3.x | Validate extracted supplier data shapes | Runtime schema validation with TypeScript type inference. Catches malformed supplier data early. |
| p-queue | 8.x | Rate-limit S&S API requests | S&S allows 60 req/min. p-queue with `intervalCap` + `interval` enforces this. ESM-only package. |
| dotenv | 16.x | Load S&S API credentials from .env | Store account number and API key securely. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tsx | 4.x | Run TypeScript scripts directly | Always -- `npx tsx scripts/scrape.ts` with no compile step |
| winston | 3.x | Structured logging | Log extraction progress, errors per product, rate limit warnings |
| vitest | latest | Testing | Unit tests for parsers and data transformations |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cheerio | regex only | Cheerio is more robust for HTML parsing; regex alone is fragile for nested HTML |
| p-queue | custom setInterval throttle | p-queue handles edge cases (queue overflow, backpressure, pause/resume) that hand-rolled solutions miss |
| zod | manual if-checks | Zod gives type inference + validation in one declaration; manual checks are verbose and drift from types |

**Installation:**
```bash
npm install cheerio zod p-queue dotenv winston
npm install -D typescript tsx vitest @types/node
```

**CRITICAL: ESM Setup Required.** p-queue v7+ is ESM-only. The project must use `"type": "module"` in package.json and `"module": "nodenext"` in tsconfig.json. tsx handles this transparently.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── suppliers/
│   ├── canada-sportswear.ts   # Shopify JSON + Cheerio body_html parser
│   ├── ss-canada.ts           # S&S REST API client (Products + Styles + Specs)
│   ├── types.ts               # SupplierProduct interface + Zod schemas
│   └── index.ts               # Unified extraction entry point
├── lib/
│   ├── queue.ts               # p-queue configured for S&S rate limits
│   └── logger.ts              # winston logger setup
scripts/
├── scrape.ts                  # CLI entry: extract from one or both suppliers
tests/
├── suppliers/
│   ├── canada-sportswear.test.ts
│   ├── ss-canada.test.ts
│   └── fixtures/              # Sample JSON/HTML responses for testing
```

### Pattern 1: Supplier Adapter Interface
**What:** Both suppliers implement a shared interface but have completely different extraction logic.
**When to use:** Always -- this is the core abstraction for Phase 1.
**Example:**
```typescript
// src/suppliers/types.ts
interface SupplierAdapter {
  readonly supplier: 'canada-sportswear' | 'ss-canada';
  fetchProducts(): Promise<SupplierProduct[]>;
  fetchProduct(identifier: string): Promise<SupplierProduct>;
}

interface SupplierProduct {
  styleNumber: string;
  supplier: 'canada-sportswear' | 'ss-canada';
  title: string;
  description: string;
  category: string;
  fabricComposition: string;       // Parsed from body_html or Styles description
  sizeChartUrl: string | null;     // PDF URL (Canada Sportswear) or null
  sizeChartData: SizeSpec[] | null; // Parsed measurements (S&S Specs endpoint)
  images: ProductImage[];
  variants: SupplierVariant[];
  rawData: unknown;                // Original API/JSON response for debugging
}
```

### Pattern 2: Two-Phase Canada Sportswear Extraction
**What:** First fetch `/collections/all/products.json` for structured data, then parse `body_html` with Cheerio for fabric composition and spec sheet URLs.
**When to use:** Always for Canada Sportswear -- JSON alone does not contain all required fields.
**Example:**
```typescript
// Step 1: Fetch all products via paginated JSON
async function fetchAllProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let page = 1;
  while (true) {
    const url = `https://canadasportswear.com/collections/all/products.json?limit=250&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.products || data.products.length === 0) break;
    products.push(...data.products);
    page++;
  }
  return products;
}

// Step 2: Parse body_html for fabric composition
function parseFabricComposition(bodyHtml: string): string | null {
  const $ = cheerio.load(bodyHtml);
  const text = $.text();
  // Pattern: "XXX gsm ... XX% material, XX% material ..."
  const match = text.match(
    /(\d+\s*gsm[\s\S]*?(?:\d+%\s*\w+[\s,]*)+)/i
  );
  return match ? match[1].trim() : null;
}

// Step 3: Extract size chart PDF URL from body_html
function parseSizeChartUrl(bodyHtml: string): string | null {
  const $ = cheerio.load(bodyHtml);
  const sizeChartLink = $('a[href*="size"], a[href*="Size"]').attr('href');
  return sizeChartLink || null;
}
```

### Pattern 3: S&S Three-Endpoint Merge
**What:** S&S product data is split across Products, Styles, and Specs endpoints. Must merge by styleID.
**When to use:** Always for S&S -- no single endpoint has all required fields.
**Example:**
```typescript
async function fetchSSProduct(styleId: string): Promise<SupplierProduct> {
  const [style, products, specs] = await Promise.all([
    ssApi.get(`/v2/styles/${styleId}`),     // Description, fabric (in HTML description)
    ssApi.get(`/v2/products/?style=${styleId}`), // SKUs, colors, sizes, pricing, images
    ssApi.get(`/v2/specs/?style=${styleId}`),    // Size measurements
  ]);
  return mergeSSData(style, products, specs);
}
```

### Pattern 4: Zod Validation Gate
**What:** Every extracted product passes through Zod validation before being accepted.
**When to use:** After extraction, before any downstream processing.
**Example:**
```typescript
const SupplierProductSchema = z.object({
  styleNumber: z.string().min(1),
  supplier: z.enum(['canada-sportswear', 'ss-canada']),
  title: z.string().min(1),
  description: z.string().min(10),
  fabricComposition: z.string().min(5),
  images: z.array(z.object({
    url: z.string().url(),
    alt: z.string().optional(),
  })).min(1),
  variants: z.array(z.object({
    color: z.string().min(1),
    size: z.string().min(1),
    sku: z.string().optional(),
    price: z.number().optional(),
  })).min(1),
});

function validateProduct(product: unknown): ValidationResult {
  const result = SupplierProductSchema.safeParse(product);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { valid: true, data: result.data };
}
```

### Anti-Patterns to Avoid
- **Scraping S&S website:** Legal risk (CFAA lawsuit precedent). Use their official API only.
- **Using only `/products.json` for Canada Sportswear:** Returns only 2 products. Must use `/collections/all/products.json` for full catalog.
- **Ignoring S&S rate limits:** 60 req/min hard cap. Will get 429 errors without throttling.
- **Assuming fabric composition is in a structured field:** For both suppliers, fabric data is embedded in HTML/text description fields. Must parse it out.
- **Relying on body_html for embedded size charts:** Canada Sportswear links to PDF size charts, does not embed tables in HTML.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTML parsing | Custom regex-only HTML parser | Cheerio | HTML is messy; regex breaks on nested tags, attributes, encoding |
| Rate limiting | setTimeout/setInterval throttle | p-queue with intervalCap | Handles queue overflow, backpressure, concurrent request limits, pause/resume |
| Data validation | Manual if/else field checks | Zod schemas | Type inference + validation in one declaration; error messages are structured |
| HTTP Basic Auth header | Manual Base64 encoding | `headers: { 'Authorization': 'Basic ' + btoa(user + ':' + pass) }` | Node.js `btoa` is built-in since v16; or use `Buffer.from().toString('base64')` |
| Retry logic | Custom retry loops | p-retry or hand-roll a simple 3-attempt wrapper | Exponential backoff, jitter, abort on non-retryable errors |

**Key insight:** The extraction logic (parsing body_html, merging S&S endpoints) is the custom value. Everything around it (HTTP, throttling, validation, HTML parsing) has battle-tested solutions.

## Common Pitfalls

### Pitfall 1: Using /products.json Instead of /collections/all/products.json
**What goes wrong:** `/products.json` on Canada Sportswear returns only 2 products. The full catalog (~70-80 products) is only accessible via `/collections/all/products.json`.
**Why it happens:** Most Shopify scraping guides reference `/products.json` as the universal endpoint.
**How to avoid:** Always use `/collections/all/products.json?limit=250&page=N` with pagination.
**Warning signs:** Extraction returns fewer than 20 products from Canada Sportswear.

### Pitfall 2: S&S API Rate Limit (60 req/min)
**What goes wrong:** Fetching all styles, products, and specs without throttling hits the 60 req/min limit. API returns 429 errors.
**Why it happens:** Three endpoints per style means 3 requests per product. 20+ styles = 60+ requests.
**How to avoid:** Use p-queue with `intervalCap: 55, interval: 60000` (leave 5 req buffer). Check `X-Rate-Limit-Remaining` header.
**Warning signs:** 429 HTTP responses, incomplete data for some styles.

### Pitfall 3: Fabric Composition Not in a Dedicated Field
**What goes wrong:** Code looks for a `fabric` or `composition` field and finds nothing. Both suppliers embed this in description text/HTML.
**Why it happens:** Neither Canada Sportswear's Shopify JSON nor S&S's Styles API has a dedicated fabric field.
**How to avoid:** Canada Sportswear: parse body_html text with regex for "gsm" + percentage patterns. S&S: parse the `description` HTML field from Styles endpoint.
**Warning signs:** fabricComposition is null/empty for all products.

### Pitfall 4: S&S Styles Description Contains HTML
**What goes wrong:** The S&S Styles `description` field contains HTML markup, not plain text. Storing raw HTML in your data model causes issues downstream.
**Why it happens:** S&S provides formatted descriptions intended for web display.
**How to avoid:** Use Cheerio to strip HTML tags and extract plain text fabric composition from the description.
**Warning signs:** Descriptions contain `<br>`, `<p>`, `<b>` tags in output.

### Pitfall 5: Canada Sportswear Size Charts Are PDFs, Not HTML
**What goes wrong:** Code tries to parse size chart data from body_html and finds nothing. Size charts are linked as downloadable PDF files.
**Why it happens:** Canada Sportswear hosts spec sheets as PDF documents, not embedded HTML tables.
**How to avoid:** Extract the PDF URL from body_html links. For Phase 1, store the URL; parsing PDFs is a separate concern. Flag products where size chart URL is missing.
**Warning signs:** sizeChartData is always null for Canada Sportswear products.

### Pitfall 6: p-queue ESM-Only Import Error
**What goes wrong:** `require('p-queue')` throws `ERR_REQUIRE_ESM`. p-queue v7+ is ESM-only.
**Why it happens:** Project not configured for ESM.
**How to avoid:** Set `"type": "module"` in package.json and `"module": "nodenext"` in tsconfig.json. Use `import PQueue from 'p-queue'`.
**Warning signs:** ERR_REQUIRE_ESM error at runtime.

### Pitfall 7: S&S Canadian Endpoint Uncertainty
**What goes wrong:** The API base URL `api.ssactivewear.com` may serve US-only data. Canadian pricing/inventory may require a different endpoint or account flag.
**Why it happens:** S&S operates separate US and Canadian divisions. The API documentation doesn't clearly distinguish Canadian-specific endpoints.
**How to avoid:** During implementation, verify with S&S support that the account is set up for Canadian data. Test that returned prices are in CAD and warehouses include Canadian locations.
**Warning signs:** Prices in USD, no Canadian warehouse abbreviations in warehouse data.

## Code Examples

### Canada Sportswear: Full Product Extraction
```typescript
// Source: Verified against canadasportswear.com/collections/all/products.json (2026-03-05)
import * as cheerio from 'cheerio';

interface CSWRawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: Array<{
    id: number;
    title: string;
    option1: string | null; // Color
    option2: string | null; // Size
    sku: string;
    price: string;
    available: boolean;
  }>;
  images: Array<{
    id: number;
    src: string;
    width: number;
    height: number;
    variant_ids: number[];
  }>;
  options: Array<{
    name: string;
    values: string[];
  }>;
}

async function fetchCSWProducts(): Promise<CSWRawProduct[]> {
  const allProducts: CSWRawProduct[] = [];
  let page = 1;

  while (true) {
    const url = `https://canadasportswear.com/collections/all/products.json?limit=250&page=${page}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`CSW fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.products || data.products.length === 0) break;

    allProducts.push(...data.products);
    page++;
  }

  return allProducts;
}

function parseBodyHtml(bodyHtml: string) {
  const $ = cheerio.load(bodyHtml);
  const text = $.text();

  // Extract fabric composition (pattern: "XXX gsm ... XX% material")
  const fabricMatch = text.match(
    /(\d+\s*gsm[\s\S]{0,200}?(?:\d+%\s*[\w\s/]+[,.]?\s*)+)/i
  );

  // Extract size chart PDF URL
  const sizeChartLink = $('a[href$=".pdf"]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return /size/i.test(href) || /spec/i.test(href);
  }).first().attr('href') || null;

  return {
    fabricComposition: fabricMatch ? fabricMatch[1].trim() : null,
    sizeChartUrl: sizeChartLink,
  };
}
```

### S&S Canada: Authenticated API Client
```typescript
// Source: Verified against api.ssactivewear.com/V2/ docs (2026-03-05)
import PQueue from 'p-queue';

const SS_BASE_URL = 'https://api.ssactivewear.com/v2';

function createSSClient(accountNumber: string, apiKey: string) {
  const authHeader = 'Basic ' + Buffer.from(`${accountNumber}:${apiKey}`).toString('base64');

  // Rate limit: 60 requests per minute, leave 5 buffer
  const queue = new PQueue({
    intervalCap: 55,
    interval: 60_000,
    carryoverConcurrencyCount: true,
  });

  async function get<T>(path: string): Promise<T> {
    return queue.add(async () => {
      const url = `${SS_BASE_URL}${path}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
        },
      });

      if (response.status === 404) {
        throw new Error(`S&S resource not found: ${path}`);
      }

      if (response.status === 429) {
        const remaining = response.headers.get('X-Rate-Limit-Remaining');
        throw new Error(`S&S rate limit hit. Remaining: ${remaining}`);
      }

      if (!response.ok) {
        throw new Error(`S&S API error: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    }, { throwOnTimeout: true }) as Promise<T>;
  }

  return {
    getStyles: () => get<SSStyle[]>('/styles/'),
    getStyle: (id: string) => get<SSStyle[]>(`/styles/${id}`),
    getProducts: (styleId: string) => get<SSProduct[]>(`/products/?style=${styleId}`),
    getSpecs: (styleId: string) => get<SSSpec[]>(`/specs/?style=${styleId}`),
  };
}
```

### S&S: Merging Three Endpoints
```typescript
async function extractSSProduct(
  client: SSClient,
  styleId: string
): Promise<SupplierProduct> {
  const [styles, products, specs] = await Promise.all([
    client.getStyle(styleId),
    client.getProducts(styleId),
    client.getSpecs(styleId),
  ]);

  const style = styles[0]; // Styles endpoint returns array

  // Parse fabric from HTML description
  const $ = cheerio.load(style.description || '');
  const descText = $.text();
  const fabricMatch = descText.match(/(\d+%\s*[\w\s/]+[\s,]*)+/i);

  // Build variants from products (each product = one SKU = one color+size combo)
  const variants = products.map(p => ({
    color: p.colorName,
    size: p.sizeName,
    sku: p.sku,
    price: p.customerPrice ?? p.piecePrice,
    colorSwatchImage: p.colorSwatchImage,
    colorFrontImage: p.colorFrontImage,
  }));

  // Build size chart from specs
  const sizeChartData = specs.map(s => ({
    sizeName: s.sizeName,
    specName: s.specName,
    value: s.value,
  }));

  return {
    styleNumber: style.partNumber,
    supplier: 'ss-canada',
    title: style.title,
    description: descText,
    category: style.baseCategory,
    fabricComposition: fabricMatch ? fabricMatch[0].trim() : '',
    sizeChartUrl: null,
    sizeChartData,
    images: extractUniqueImages(products, style),
    variants,
    rawData: { style, products, specs },
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| axios for HTTP | Native `fetch` in Node.js | Node.js 18 (2022) | No third-party HTTP dependency needed |
| cheerio 0.22.x (htmlparser2-based) | cheerio 1.0.0 (parse5-based) | 2024 | Better HTML5 compliance, but htmlparser2 still available as option |
| p-queue v6 (CommonJS) | p-queue v8 (ESM-only) | 2022 | Must use ESM imports; requires `"type": "module"` in package.json |
| S&S website scraping | S&S official REST API | Always (lawsuit Sep 2025) | Legal compliance -- never scrape S&S website |

## Open Questions

1. **S&S Canadian-Specific API Configuration**
   - What we know: API is at `api.ssactivewear.com/V2/`. Auth is account number + API key.
   - What's unclear: Whether the same endpoint returns Canadian pricing/inventory or requires a Canadian-specific account or parameter.
   - Recommendation: Verify during implementation by checking warehouse abbreviations and currency in responses. Contact S&S support if needed.

2. **Canada Sportswear Size Chart PDF Content**
   - What we know: Size charts are PDF files linked in body_html, not embedded HTML.
   - What's unclear: Whether we need to parse PDF content or if storing the URL is sufficient for Phase 1.
   - Recommendation: For Phase 1, extract and store the PDF URL. If size chart data is needed in structured form, add PDF parsing (via pdf-parse library) as a follow-up task.

3. **Canada Sportswear Product Catalog Completeness**
   - What we know: `/collections/all/products.json` returns ~70-80 products across ~3 pages. `/products.json` returns only 2.
   - What's unclear: Whether some products are in specific collections but not in "all". Whether discontinued products are excluded.
   - Recommendation: Use `/collections/all/products.json` as primary source. Cross-reference with known product list if available.

4. **S&S API Credential Access**
   - What we know: Requires S&S account number and API key from account settings page.
   - What's unclear: Whether the user has these credentials ready.
   - Recommendation: Document required credentials in .env.example. Fail fast with clear message if credentials are missing.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (latest) |
| Config file | none -- see Wave 0 |
| Quick run command | `npx vitest run tests/suppliers/ --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUPP-01 | Canada Sportswear extracts products with images, descriptions, specs, fabric | unit | `npx vitest run tests/suppliers/canada-sportswear.test.ts` | No -- Wave 0 |
| SUPP-01 | body_html parsing extracts fabric composition | unit | `npx vitest run tests/suppliers/canada-sportswear.test.ts -t "fabric"` | No -- Wave 0 |
| SUPP-01 | body_html parsing extracts size chart PDF URL | unit | `npx vitest run tests/suppliers/canada-sportswear.test.ts -t "size chart"` | No -- Wave 0 |
| SUPP-01 | Pagination fetches all products across multiple pages | integration | `npx vitest run tests/suppliers/canada-sportswear.test.ts -t "pagination"` | No -- Wave 0 |
| SUPP-02 | S&S API client authenticates and fetches styles | unit | `npx vitest run tests/suppliers/ss-canada.test.ts -t "styles"` | No -- Wave 0 |
| SUPP-02 | S&S merges styles + products + specs into SupplierProduct | unit | `npx vitest run tests/suppliers/ss-canada.test.ts -t "merge"` | No -- Wave 0 |
| SUPP-02 | S&S rate limiting respects 60 req/min cap | unit | `npx vitest run tests/suppliers/ss-canada.test.ts -t "rate"` | No -- Wave 0 |
| SUPP-03 | Validation rejects products with missing required fields | unit | `npx vitest run tests/suppliers/validation.test.ts` | No -- Wave 0 |
| SUPP-03 | Validation reports specific missing fields per product | unit | `npx vitest run tests/suppliers/validation.test.ts -t "report"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/suppliers/ --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` -- vitest configuration file
- [ ] `tests/suppliers/canada-sportswear.test.ts` -- covers SUPP-01
- [ ] `tests/suppliers/ss-canada.test.ts` -- covers SUPP-02
- [ ] `tests/suppliers/validation.test.ts` -- covers SUPP-03
- [ ] `tests/suppliers/fixtures/csw-products-sample.json` -- sample Canada Sportswear JSON response
- [ ] `tests/suppliers/fixtures/csw-body-html-sample.html` -- sample body_html with fabric specs
- [ ] `tests/suppliers/fixtures/ss-style-sample.json` -- sample S&S Styles response
- [ ] `tests/suppliers/fixtures/ss-products-sample.json` -- sample S&S Products response
- [ ] `tests/suppliers/fixtures/ss-specs-sample.json` -- sample S&S Specs response
- [ ] Framework install: `npm install -D vitest`

## Sources

### Primary (HIGH confidence)
- [Canada Sportswear /collections/all/products.json](https://canadasportswear.com/collections/all/products.json?limit=250) - Verified live, returns ~70-80 products with body_html containing fabric specs and PDF links. Tested 2026-03-05.
- [Canada Sportswear single product JSON](https://canadasportswear.com/products/l00450-weekender-vintage-wash-pullover-hooded-sweatshirt.json) - Verified body_html content structure: fabric as inline text, size charts as PDF links.
- [S&S Activewear API main page](https://api.ssactivewear.com/V2/Default.aspx) - Verified endpoints, auth method (Basic Auth), 60 req/min rate limit.
- [S&S Products endpoint](https://api.ssactivewear.com/V2/Products.aspx) - Verified fields: sku, colorName, sizeName, pricing, color images.
- [S&S Styles endpoint](https://api.ssactivewear.com/v2/Styles.aspx) - Verified fields: description (HTML with fabric), title, styleImage, partNumber. No dedicated fabric field.
- [S&S Specs endpoint](https://api.ssactivewear.com/v2/Specs.aspx) - Verified: returns size measurements per style.
- [Cheerio 1.0.0](https://cheerio.js.org/) - Latest stable version, parse5-based HTML parsing.

### Secondary (MEDIUM confidence)
- [p-queue v8 ESM-only](https://github.com/sindresorhus/p-queue) - Confirmed ESM-only from v7+. Must use `import` not `require`.
- [Shopify /products.json pagination](https://community.shopify.com/t/how-to-paginate-or-get-a-list-of-all-products-using-domain-com-products-json/99991) - `?page=N` parameter still works on storefront endpoint (not API).

### Tertiary (LOW confidence)
- S&S Canadian-specific endpoint behavior -- not verified whether same API returns CAD pricing. Needs validation during implementation.
- Canada Sportswear catalog completeness via /collections/all -- may not include all products if some are in hidden collections.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Libraries verified via official docs and npm; versions confirmed
- Architecture: HIGH - Verified actual endpoint responses from both suppliers; data shapes confirmed
- Pitfalls: HIGH - Verified the /products.json vs /collections/all gap firsthand; S&S lawsuit documented; rate limits from official docs

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (30 days -- both suppliers' endpoints are stable)
