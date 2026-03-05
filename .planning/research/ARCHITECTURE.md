# Architecture Patterns

**Domain:** Product catalog enrichment pipeline
**Researched:** 2026-03-05

## Recommended Architecture

Three-stage ETL (Extract-Transform-Load) pipeline executed as CLI scripts. No web server. No database. Google Sheets is the persistent data store.

```
[Canada Sportswear]          [S&S Canada]
  (Shopify JSON               (Official REST API
   + Cheerio HTML)              api.ssactivewear.com/V2/)
        \                          /
         v                        v
    [Supplier Data Extractors]
              |
              v
    [Google Sheets - Master Sheet]  <-- Single source of truth
              |
              v
    [Enrichment Engine]
    - Decoration rules (by garment category)
    - Pricing calculator
    - Data validation (zod)
              |
              v
    [Shopify Product Builder]
    - Map sheet rows to GraphQL productSet mutations
    - Generate variants (Color x Size only)
    - Set metafields + metaobject references
    - Upload images via staged uploads
              |
              v
    [Shopify Store]
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `scrapers/canada-sportswear.ts` | Fetch product data via Shopify JSON endpoints + Cheerio for HTML details | Google Sheets (writes supplier data) |
| `scrapers/ss-canada.ts` | Fetch product data via S&S Activewear REST API (JSON) | Google Sheets (writes supplier data) |
| `enrichment/decoration-rules.ts` | Apply decoration methods and placements by garment category | Google Sheets (reads product type, writes decoration config) |
| `enrichment/pricing.ts` | Calculate sell prices using pricing calculator model | Google Sheets (reads costs, writes sell prices) |
| `enrichment/validator.ts` | Validate enriched rows have all required data before push | Google Sheets (reads rows, flags incomplete ones) |
| `shopify/product-builder.ts` | Transform enriched sheet rows into Shopify GraphQL mutations | Shopify Admin API |
| `shopify/image-uploader.ts` | Download supplier images and upload to Shopify CDN | Supplier URLs, Shopify staged uploads API |
| `shopify/metaobject-builder.ts` | Create/verify Print Area metaobjects before product creation | Shopify Admin API |
| `lib/sheets.ts` | Google Sheets connection, batch read/write operations | Google Sheets API v4 |
| `lib/shopify.ts` | Shopify API client init, rate-limited GraphQL executor | Shopify Admin API |
| `lib/queue.ts` | Rate-limited request queue (p-queue) | Used by scrapers and Shopify modules |

### Data Flow

1. **Extract**: `npx tsx scripts/scrape.ts` -- fetches from both suppliers, writes raw data to sheet
2. **Enrich**: `npx tsx scripts/enrich.ts` -- applies decoration rules + pricing, validates completeness
3. **Push**: `npx tsx scripts/push-to-shopify.ts` -- reads enriched rows, creates/updates products in Shopify
4. **Full run**: `npx tsx scripts/pipeline.ts` -- runs all three stages sequentially

## Recommended Project Structure

```
src/
├── scrapers/
│   ├── canada-sportswear.ts   # Shopify JSON + Cheerio HTML parser
│   ├── ss-canada.ts           # S&S REST API client
│   └── types.ts               # Shared SupplierProduct interface
├── enrichment/
│   ├── decoration-rules.ts    # Category-based rule engine
│   ├── pricing.ts             # Sell price calculator
│   └── validator.ts           # zod-based data validation
├── shopify/
│   ├── client.ts              # GraphQL client with rate limiting
│   ├── product-builder.ts     # CanonicalProduct -> productSet input
│   ├── metaobject-builder.ts  # Print Area metaobject management
│   ├── image-uploader.ts      # Staged uploads for images
│   └── mutations.ts           # GraphQL mutation strings
├── config/
│   ├── decoration-rules.json  # Category -> methods + placements
│   └── column-mapping.json    # Sheet column -> product field mapping
├── types/
│   ├── product.ts             # CanonicalProduct interface
│   └── shopify.ts             # Shopify API types
├── lib/
│   ├── sheets.ts              # Google Sheets wrapper
│   ├── shopify.ts             # Shopify client factory
│   ├── queue.ts               # p-queue rate limiter
│   └── logger.ts              # winston logger setup
scripts/
├── scrape.ts                  # Stage 1: Extract
├── enrich.ts                  # Stage 2: Transform
├── push-to-shopify.ts         # Stage 3: Load
├── setup-metaobjects.ts       # One-time: Create Print Area metaobjects
└── pipeline.ts                # Full pipeline runner
```

## Patterns to Follow

### Pattern 1: Pipeline with Canonical Intermediate Format
**What:** All data flows through a single `CanonicalProduct` type. Scrapers produce partial products, enrichment adds to them, builder consumes the final version.
**When:** Always -- this is the core pattern.
**Example:**
```typescript
interface CanonicalProduct {
  styleNumber: string;
  supplier: 'canada-sportswear' | 'ss-canada';
  title: string;
  description: string;
  category: GarmentCategory;
  fabricComposition: string;
  images: ProductImage[];
  variants: CanonicalVariant[];   // Color x Size combos
  decorationRules: DecorationRule[];
  printAreas: PrintArea[];
  pricing: PricingResult;
}
```

### Pattern 2: Adapter Pattern for Suppliers
**What:** Each supplier implements a shared interface but has independent extraction logic.
**When:** Always -- the two suppliers have fundamentally different data access methods.
**Example:**
```typescript
interface SupplierAdapter {
  supplier: string;
  fetchProduct(identifier: string): Promise<SupplierProduct>;
  fetchAllProducts(): Promise<SupplierProduct[]>;
}

// Canada Sportswear: Shopify JSON + Cheerio
// S&S Canada: REST API with account auth
```

### Pattern 3: Configuration-Driven Decoration Rules
**What:** Decoration methods and placements in JSON config, not hardcoded.
**When:** When business rules change more often than code.
**Example:**
```json
{
  "hoodie": {
    "methods": ["dtf", "embroidery"],
    "placements": ["front-chest", "back-full", "left-sleeve", "right-sleeve", "hood"],
    "maxAreas": 5
  },
  "t-shirt": {
    "methods": ["dtf"],
    "placements": ["front-chest", "back-full", "left-sleeve", "right-sleeve"],
    "maxAreas": 4
  }
}
```

### Pattern 4: Idempotent Push with Handle-Based Matching
**What:** Use product handles (derived from style number) to determine create vs. update. `productSet` supports this natively.
**When:** Every push operation.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Scraping S&S Canada Website
**What:** Using Cheerio/Playwright to scrape S&S product pages.
**Why bad:** S&S Activewear has sued companies for scraping (CFAA violations, September 2025). Legal risk.
**Instead:** Use their official REST API at `api.ssactivewear.com/V2/`.

### Anti-Pattern 2: Monolithic Script
**What:** One script that scrapes, enriches, and pushes in a single function.
**Why bad:** Can't retry failed stages independently. Hard to test. Fragile.
**Instead:** Separate scripts per stage. Each reads from/writes to Google Sheets.

### Anti-Pattern 3: REST API for Product Creation
**What:** Using Shopify REST Admin API for product operations.
**Why bad:** REST product endpoints are deprecated (API 2024-04+). Limited to 100 variants (Color x Size needs ~98). Multiple sequential calls needed.
**Instead:** GraphQL `productSet` mutation -- handles everything in one call, supports 2048 variants async.

### Anti-Pattern 4: In-Memory Data Store
**What:** Keeping all product data in JS objects without persisting to sheets.
**Why bad:** Data loss on crash. No visibility. Can't restart from failure point.
**Instead:** Google Sheets is the checkpoint. Write intermediate results there.

### Anti-Pattern 5: No Validation Before Push
**What:** Sending data directly to Shopify without checking completeness.
**Why bad:** Corrupts live products with missing images, empty descriptions, wrong prices.
**Instead:** zod validation gate between enrichment and push. Fail early with clear messages.

## Scalability Considerations

| Concern | At 10 products | At 100 products | At 500+ products |
|---------|---------------|-----------------|-------------------|
| Supplier extraction | Seconds | 2-5 min | 10-20 min, cache aggressively |
| Google Sheets API | No issues | Batch reads/writes needed | Hit quota limits, batch in groups of 50 |
| Shopify GraphQL | Trivial | 20-30 sec with rate limiting | Use async productSet, plan multi-day if >50K variants |
| Image uploads | Inline | Queue with concurrency=3 | Queue with retry and progress tracking |
| Error recovery | Manual retry | Per-product error tracking needed | Checkpoint/resume required |

## Shopify API Strategy

### Use `productSet` Over `productCreate`

`productSet` is recommended because it:
- Creates or updates in a single call (idempotent)
- Handles variants, metafields, and media together
- Supports async mode for >100 variants (up to 2048)
- Replaces the need for `productCreate` + `productUpdate` + `productVariantsBulkCreate`

**Critical caveat:** `productSet` replaces list fields entirely. If you send 3 variants, the other 95 get deleted. Always send the COMPLETE variant and metafield list.

### Metaobject Strategy

1. Create `MetaobjectDefinition` for "print_area" type (one-time setup)
2. Create individual print area entries via `metaobjectCreate`
3. Reference from products via metafields
4. Use handles for stable identification, not GIDs

### Rate Limiting

- 50 cost points/second (standard plan), 100 (Advanced), 500 (Plus)
- `productSet` costs ~10 points per call
- Practical: ~4-5 product creates/second
- 100 products = ~25 seconds of API time (manageable without bulk ops)

## Sources

- [Shopify productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) -- HIGH confidence
- [Shopify bulk operations](https://shopify.dev/docs/api/usage/bulk-operations/queries) -- HIGH confidence
- [Shopify metaobject management](https://shopify.dev/docs/apps/build/custom-data/metaobjects/manage-metaobjects) -- HIGH confidence
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits) -- HIGH confidence
- [S&S Activewear API](https://api.ssactivewear.com/V2/Default.aspx) -- HIGH confidence
- [Canada Sportswear site](https://canadasportswear.com/) -- Shopify-based, verified (HIGH confidence)

---
*Architecture research for: Fortee Catalog Engine*
*Researched: 2026-03-05*
