# Phase 4: Shopify Product Push - Research

**Researched:** 2026-03-06
**Domain:** Shopify GraphQL Admin API (product creation, metaobjects, media uploads, template assignment)
**Confidence:** HIGH

## Summary

Phase 4 transforms enriched sheet rows into complete Shopify products via the GraphQL Admin API. The core mutation is `productSet`, which supports creating products with all variants, metafields, and media in a single call --- and supports upsert by handle for idempotency (SHOP-07). Print Area metaobjects require a separate two-step setup: first define the metaobject type via `metaobjectDefinitionCreate`, then create entries via `metaobjectUpsert` and link them to products via a `list.metaobject_reference` metafield.

Images can be attached to products either via external URLs directly in the `productSet` `files` field, or through staged uploads. Since supplier images are already publicly accessible URLs from OneSource/S&S CDNs, the simpler approach is to pass those URLs directly as `originalSource` in the `files` array. Staged uploads are only needed if images must be downloaded first (e.g., the CDN blocks Shopify's fetch).

**Primary recommendation:** Use `@shopify/admin-api-client` for a lightweight GraphQL client with built-in retry on 429s, `productSet` with `identifier: { handle }` for idempotent create/update, separate `metafieldsSet` for metafield updates (avoids accidental deletion), and `metaobjectUpsert` with deterministic handles for Print Area entries.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SHOP-01 | Create products in Shopify via GraphQL productSet mutation | productSet mutation with synchronous mode, @shopify/admin-api-client for GraphQL client |
| SHOP-02 | Generate Color x Size variants (~98 per product) with correct base pricing | productSet accepts productOptions array with up to 3 options and variants array with optionValues + price; 2048 variant limit per product |
| SHOP-03 | Create Print Area metaobjects with decoration method, placement, and pricing data | metaobjectDefinitionCreate for type setup, metaobjectUpsert with deterministic handles for entries |
| SHOP-04 | Assign metafields to products referencing Print Area metaobjects | metafieldsSet with list.metaobject_reference type; value is JSON-stringified array of metaobject GIDs |
| SHOP-05 | Download supplier images and upload to Shopify via staged uploads | productSet files field with external URLs as originalSource; staged uploads only if CDN blocks Shopify fetcher |
| SHOP-06 | Assign Dawn builder template based on category | templateSuffix field in productSet input maps category to template suffix string |
| SHOP-07 | Idempotent: re-running updates existing products | productSet with identifier: { handle } performs upsert; metaobjectUpsert is inherently idempotent by handle |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @shopify/admin-api-client | latest | Lightweight GraphQL client for Shopify Admin API | Official Shopify package, built-in retry on 429/503, no framework dependencies |
| dotenv | ^17.3.1 | Environment variable loading | Already in project |
| zod | ^4.3.6 | Input validation for push configs | Already in project |
| winston | ^3.19.0 | Structured logging | Already in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | File operations for temp image downloads | Only if staged uploads needed |
| node:stream/promises | built-in | Stream pipeline for image downloads | Only if staged uploads needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @shopify/admin-api-client | @shopify/shopify-api | Full SDK is heavier; includes OAuth, webhooks, session management not needed for a custom app with static access token |
| @shopify/admin-api-client | Plain fetch + manual GraphQL | Loses built-in retry on 429, header management, API version handling |

**Installation:**
```bash
npm install @shopify/admin-api-client
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  shopify/
    client.ts          # Shopify GraphQL client setup (createAdminApiClient)
    product-push.ts    # Main orchestrator: read sheet row -> build input -> push
    mutations.ts       # GraphQL mutation strings (productSet, metaobjectUpsert, etc.)
    metaobject-setup.ts  # One-time: metaobject definition + metafield definition creation
    template-map.ts    # GarmentCategory -> templateSuffix mapping
    types.ts           # Shopify-specific types (ProductSetInput shape, etc.)
```

### Pattern 1: Idempotent Product Upsert via Handle
**What:** Use `productSet` with `identifier: { handle }` so the same mutation creates on first run and updates on subsequent runs.
**When to use:** Every product push call.
**Example:**
```typescript
// Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
const PRODUCT_SET = `
  mutation ProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(synchronous: true, input: $input, identifier: $identifier) {
      product {
        id
        handle
        variants(first: 250) {
          edges { node { id title price } }
        }
      }
      userErrors { field message code }
    }
  }
`;

// Usage:
const handle = buildHandle(row.productName, row.styleID);
const { data } = await client.request(PRODUCT_SET, {
  variables: {
    identifier: { handle },
    input: {
      title: row.productName,
      handle,
      descriptionHtml: row.description,
      vendor: row.brandName,
      productType: row.baseCategory,
      status: "ACTIVE",
      templateSuffix: getTemplateSuffix(row.baseCategory),
      tags: buildTags(row),
      productOptions: [
        { name: "Color", position: 1, values: uniqueColors.map(c => ({ name: c })) },
        { name: "Size", position: 2, values: uniqueSizes.map(s => ({ name: s })) },
      ],
      variants: buildVariants(groupedRows),
    },
  },
});
```

### Pattern 2: Separate Metafield Updates (Avoid Deletion)
**What:** Use `metafieldsSet` instead of including metafields in `productSet` to avoid accidentally deleting existing metafields.
**When to use:** After product creation, when linking Print Area metaobjects.
**Example:**
```typescript
// Source: https://community.shopify.com/t/shopify-api-2025-04-avoid-metafield-loss-when-using-productset/406135
const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace value }
      userErrors { field message }
    }
  }
`;

// Link print areas to product:
await client.request(METAFIELDS_SET, {
  variables: {
    metafields: [{
      ownerId: productGid,
      namespace: "custom",
      key: "print_areas",
      type: "list.metaobject_reference",
      value: JSON.stringify(printAreaGids), // '["gid://shopify/Metaobject/123", ...]'
    }],
  },
});
```

### Pattern 3: Deterministic Metaobject Handles
**What:** Build metaobject handles from stable data (category + method + placement) so `metaobjectUpsert` is naturally idempotent.
**When to use:** All Print Area metaobject creation.
**Example:**
```typescript
// Handle: "t-shirt-print-left-chest"
function buildPrintAreaHandle(category: string, method: string, placement: string): string {
  return `${category}-${method}-${placement}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
```

### Pattern 4: Variant Building from Sheet Rows
**What:** Group sheet rows by styleID, extract unique colors/sizes, build Color x Size variant matrix.
**When to use:** Building the variants array for productSet.
**Example:**
```typescript
function buildVariants(rows: SheetRow[]): ProductVariantSetInput[] {
  return rows.map(row => ({
    optionValues: [
      { optionName: "Color", name: row.colorName },
      { optionName: "Size", name: row.sizeName },
    ],
    price: parseFloat(row.sellPrice) || 0,
    sku: row.partNumber,
    barcode: row.PartID,
  }));
}
```

### Anti-Patterns to Avoid
- **Including metafields in productSet for updates:** Omitted metafields get deleted. Always use `metafieldsSet` separately.
- **Including files in productSet for updates when not changing images:** Omitted files get deleted. Only include `files` on first creation or when explicitly updating images.
- **Using productCreate + productVariantsBulkCreate:** Two calls when `productSet` does it in one.
- **Synchronous mode with very large variant counts (200+):** May timeout. Use `synchronous: false` and poll `ProductSetOperation` for status.
- **Building handles without the styleID:** Product names alone are not unique across suppliers.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| GraphQL client with auth + retry | Custom fetch wrapper with retry logic | @shopify/admin-api-client | Built-in 429/503 retry, header management, API versioning |
| Rate limiting | Custom token bucket / queue | @shopify/admin-api-client retries | Shopify uses calculated query cost (50 pts/sec, 1000 pt bucket); client handles 429 backoff |
| Image upload pipeline | Custom multipart form upload | productSet files with originalSource URL | Shopify fetches external URLs directly; only build staged upload if CDN blocks Shopify |
| Product handle generation | Naive slugify | Deterministic function with styleID uniqueness | Must be unique across all products; include styleID |
| Metaobject handle generation | Random IDs or auto-generated | Deterministic handle from category+method+placement | Enables idempotent upsert without tracking IDs |

**Key insight:** Shopify's `productSet` mutation is designed as a sync-from-external-source tool. The entire product (options, variants, media, tags) can be defined in a single mutation. Lean into this design rather than orchestrating multiple mutations for product creation.

## Common Pitfalls

### Pitfall 1: Metafield Deletion on productSet Update
**What goes wrong:** When updating a product with `productSet`, any metafields NOT included in the input are deleted.
**Why it happens:** `productSet` treats list fields (metafields, files, variants, collections) as "sync" fields --- what's in the input is the desired state.
**How to avoid:** Use `metafieldsSet` mutation separately for metafield updates. Only use metafields in `productSet` on initial creation if needed.
**Warning signs:** Metafields disappearing after product updates.

### Pitfall 2: Image Re-creation / Deletion on Subsequent Runs
**What goes wrong:** Including the same `files` array on every `productSet` call re-creates images (new IDs) or deletes existing ones if any are omitted.
**Why it happens:** `files` is a list field subject to the same sync behavior as metafields.
**How to avoid:** Only include `files` on first creation. On updates, omit the `files` field entirely or use `productCreateMedia` separately.
**Warning signs:** Duplicate images appearing or images disappearing after updates.

### Pitfall 3: Timeout on Synchronous Mode with Many Variants
**What goes wrong:** `productSet` with `synchronous: true` and 98+ variants may timeout.
**Why it happens:** Each variant adds 0.2 query cost; 98 variants = ~30 points + base cost.
**How to avoid:** Use `synchronous: false` and poll `ProductSetOperation` for completion. The 98-variant case is likely fine synchronously (well under 2048 limit), but monitor for timeouts.
**Warning signs:** GraphQL timeout errors or 429 responses.

### Pitfall 4: Metaobject Definition Must Exist Before Entries
**What goes wrong:** `metaobjectUpsert` fails if the type definition doesn't exist.
**Why it happens:** Metaobject types must be defined via `metaobjectDefinitionCreate` before entries can be created.
**How to avoid:** Create a setup script/command that runs once to create the Print Area metaobject definition and the product metafield definition. Make it idempotent (check if exists first).
**Warning signs:** "Type not found" errors from metaobjectUpsert.

### Pitfall 5: Metafield Definition Required for list.metaobject_reference
**What goes wrong:** Setting a `list.metaobject_reference` metafield fails without a matching metafield definition.
**Why it happens:** Shopify requires metafield definitions for structured types.
**How to avoid:** Create the metafield definition (namespace: "custom", key: "print_areas", type: "list.metaobject_reference", ownerType: PRODUCT) as part of the one-time setup.
**Warning signs:** "Metafield definition not found" or type validation errors.

### Pitfall 6: list.metaobject_reference Value Format
**What goes wrong:** Passing a JSON array object instead of a stringified JSON array.
**Why it happens:** The GraphQL `value` field is a String, not a JSON scalar.
**How to avoid:** Always `JSON.stringify()` the array of GIDs: `"[\"gid://shopify/Metaobject/123\"]"`.
**Warning signs:** "Invalid value" errors on metafield set.

### Pitfall 7: Handle Collisions
**What goes wrong:** Two products with similar names get the same handle, causing upsert to overwrite.
**Why it happens:** Handle is generated from product title alone without a unique suffix.
**How to avoid:** Always include styleID in the handle: `my-product-name-st550` not just `my-product-name`.
**Warning signs:** Products being overwritten instead of created.

## Code Examples

### Shopify Client Setup
```typescript
// Source: https://github.com/Shopify/shopify-api-js/tree/main/packages/admin-api-client
import { createAdminApiClient } from '@shopify/admin-api-client';

export function createShopifyClient() {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!storeDomain || !accessToken) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN in environment.'
    );
  }

  return createAdminApiClient({
    storeDomain,
    apiVersion: '2025-01',
    accessToken,
  });
}
```

### Metaobject Definition (One-Time Setup)
```typescript
// Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectDefinitionCreate
const CREATE_PRINT_AREA_DEFINITION = `
  mutation CreatePrintAreaDefinition {
    metaobjectDefinitionCreate(definition: {
      name: "Print Area"
      type: "print_area"
      fieldDefinitions: [
        { name: "Method", key: "method", type: "single_line_text_field" }
        { name: "Placement", key: "placement", type: "single_line_text_field" }
        { name: "Max Size", key: "max_size", type: "single_line_text_field" }
        { name: "Common Sizes", key: "common_sizes", type: "single_line_text_field" }
        { name: "Notes", key: "notes", type: "multi_line_text_field" }
      ]
    }) {
      metaobjectDefinition { id name type }
      userErrors { field message }
    }
  }
`;
```

### Metaobject Upsert (Print Area Entry)
```typescript
// Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectUpsert
const UPSERT_PRINT_AREA = `
  mutation UpsertPrintArea($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

// Usage:
await client.request(UPSERT_PRINT_AREA, {
  variables: {
    handle: { type: "print_area", handle: "t-shirt-print-left-chest" },
    metaobject: {
      fields: [
        { key: "method", value: "Print" },
        { key: "placement", value: "Left Chest" },
        { key: "max_size", value: "4.5x4.5" },
        { key: "common_sizes", value: "3.5x3.5" },
        { key: "notes", value: "Primary brand logo" },
      ],
    },
  },
});
```

### Template Suffix Mapping
```typescript
// Dawn builder templates follow the pattern: product.{suffix}
// The suffix maps garment categories to pre-built Dawn templates
const TEMPLATE_SUFFIX_MAP: Record<string, string> = {
  'T-Shirt': 't-shirt',
  'Hoodie': 'hoodie',
  'Long Sleeve': 'long-sleeve',
  'Cap': 'cap',
  'Beanie': 'beanie',
  'Pants': 'pants',
  'Jacket': 'jacket',
};

export function getTemplateSuffix(baseCategory: string): string | undefined {
  return TEMPLATE_SUFFIX_MAP[baseCategory];
}
```

### Product Files (Images) on Creation
```typescript
// Source: https://shopify.dev/docs/api/admin-graphql/latest/input-objects/productsetinput
// Use external URLs directly --- Shopify fetches them
function buildFiles(row: SheetRow): FileSetInput[] {
  const files: FileSetInput[] = [];
  if (row.FrontImage) {
    files.push({ originalSource: row.FrontImage, alt: `${row.productName} - Front`, contentType: "IMAGE" });
  }
  if (row.BackImage) {
    files.push({ originalSource: row.BackImage, alt: `${row.productName} - Back`, contentType: "IMAGE" });
  }
  if (row.DirectSideImage) {
    files.push({ originalSource: row.DirectSideImage, alt: `${row.productName} - Side`, contentType: "IMAGE" });
  }
  return files;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| productCreate + productVariantsBulkCreate (2 calls) | productSet (1 call, full product sync) | API 2024-01+ | Single mutation for full product definition |
| REST Admin API for products | GraphQL Admin API | Shopify pushing since 2023 | Better performance, calculated query costs, typed inputs |
| stagedUploadTargetsGenerate | stagedUploadsCreate | 2024 | Updated mutation name; old one deprecated |
| productUpdate for template assignment | productSet includes templateSuffix | 2024-01+ | Can set template in same call as product creation |

**Deprecated/outdated:**
- `productCreate` is still available but `productSet` is preferred for external sync workflows
- `stagedUploadTargetsGenerate` replaced by `stagedUploadsCreate`
- REST product endpoints still work but GraphQL is recommended

## Open Questions

1. **Template suffix values for Dawn builder**
   - What we know: `templateSuffix` field exists on productSet; format is the suffix after `product.`
   - What's unclear: Exact suffix strings for the user's Dawn builder theme templates need to be discovered from the actual Shopify store
   - Recommendation: Query the store's theme templates via Admin API or check the theme editor, then map categories to discovered suffixes

2. **Print Area metaobject field richness**
   - What we know: Need method, placement, max_size, common_sizes, notes at minimum
   - What's unclear: Whether pricing data (print cost per area, embroidery cost) should also be stored in metaobjects or calculated at order time
   - Recommendation: Store placement/method data in metaobjects; pricing is calculated from rules (Phase 3) and stored as the sellPrice on variants

3. **Image CDN accessibility**
   - What we know: productSet files accept external URLs as originalSource
   - What's unclear: Whether OneSource/S&S CDN URLs are accessible to Shopify's image fetcher
   - Recommendation: Try external URLs first; fall back to staged uploads (download locally, then upload) if Shopify returns fetch errors

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | Implicit (vitest resolves from package.json) |
| Quick run command | `npx vitest run src/shopify/` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SHOP-01 | productSet mutation builds correct input from sheet row | unit | `npx vitest run tests/shopify/product-push.test.ts -t "builds productSet input"` | No - Wave 0 |
| SHOP-02 | Color x Size variant matrix generation | unit | `npx vitest run tests/shopify/variants.test.ts` | No - Wave 0 |
| SHOP-03 | Print Area metaobject input construction | unit | `npx vitest run tests/shopify/metaobjects.test.ts` | No - Wave 0 |
| SHOP-04 | Metafield value format for list.metaobject_reference | unit | `npx vitest run tests/shopify/metafields.test.ts` | No - Wave 0 |
| SHOP-05 | Image file input construction from sheet row | unit | `npx vitest run tests/shopify/files.test.ts` | No - Wave 0 |
| SHOP-06 | Template suffix mapping from category | unit | `npx vitest run tests/shopify/template-map.test.ts` | No - Wave 0 |
| SHOP-07 | Handle generation is deterministic and unique | unit | `npx vitest run tests/shopify/handles.test.ts` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/shopify/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before verify-work

### Wave 0 Gaps
- [ ] `tests/shopify/` directory
- [ ] All test files listed above (7 files)
- [ ] Test fixtures: sample SheetRow data, expected GraphQL inputs

## Sources

### Primary (HIGH confidence)
- [productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) - full mutation signature, arguments, response
- [ProductSetInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/productsetinput) - all input fields with types
- [ProductSetIdentifiers](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductSetIdentifiers) - handle/id/customId upsert options
- [stagedUploadsCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate) - staged upload flow
- [metaobjectUpsert](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectUpsert) - idempotent metaobject creation
- [metaobjectDefinitionCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectDefinitionCreate) - type definition setup
- [@shopify/admin-api-client](https://github.com/Shopify/shopify-api-js/tree/main/packages/admin-api-client) - lightweight GraphQL client with retry

### Secondary (MEDIUM confidence)
- [Avoid metafield loss with productSet](https://community.shopify.com/t/shopify-api-2025-04-avoid-metafield-loss-when-using-productset/406135) - use metafieldsSet separately
- [productSet image deletion issue](https://community.shopify.dev/t/productset-mutation-issue-images-are-deleted-or-restored-with-each-mutation-execution/14324) - omit files on updates
- [list.metaobject_reference value format](https://community.shopify.dev/t/setting-list-metaobject-reference-values-in-graphql/25552) - JSON-stringified array of GIDs
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits) - 50 pts/sec, 1000 pt bucket

### Tertiary (LOW confidence)
- Template suffix exact values for user's Dawn builder theme (needs store-specific discovery)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - official Shopify packages, verified API docs
- Architecture: HIGH - patterns derived from official mutation docs and community-verified best practices
- Pitfalls: HIGH - documented in multiple community threads and confirmed by Shopify staff
- Template mapping: LOW - suffix values are store-specific, need discovery

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (Shopify API versions are quarterly-stable)
