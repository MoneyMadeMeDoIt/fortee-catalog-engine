# Phase 4: Shopify Product Push (REWORK) - Research

**Researched:** 2026-03-09
**Domain:** Shopify GraphQL Admin API (product creation with 3-option variants, variant metafields, image standardization, existing metaobject linking)
**Confidence:** HIGH

## Summary

Phase 4 is being reworked to target the old Shopify store format instead of the new builder wizard. The core changes are: (1) variants expand from Color x Size (2 options) to Color x Size x # of Print Areas (3 options, values 1 and 2), doubling variant count; (2) each variant gets a `print_area_position` metafield with JSON coordinates; (3) products link to two existing metaobjects (`front-dtf`, `back-print`) instead of creating new per-category metaobjects; (4) images need specific alt text ("Front Print", "Back Print") for print area media; (5) images must be standardized to 2000x2000px; (6) template changes to `product.quick-order`; (7) only T-Shirts, Long Sleeves, Crewnecks, and Hoodies are pushed.

The existing code in `src/shopify/` provides a solid foundation but every file needs modification. The `productSet` mutation supports up to 3 product options and variant-level metafields via `ProductVariantSetInput.metafields`, so the print_area_position can be set during product creation. The `metaobjectByHandle` query can look up the existing `front-dtf` and `back-print` metaobjects to get their GIDs for linking. Sharp is the standard Node.js image processing library for the 2000x2000 canvas standardization.

**Primary recommendation:** Modify existing code to add the third "# of Print Areas" option with values [1, 2], include variant-level `print_area_position` metafield via `ProductVariantSetInput.metafields`, use `metaobjectByHandle` to look up existing metaobjects instead of creating them, use sharp for image standardization, and add category filtering early in the push pipeline.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Variants are **Color x Size x # of Print Areas** (3 options, not 2)
- # of Print Areas has values: 1, 2
- Variant with 1 print area uses `sellPrice1Area` pricing
- Variant with 2 print areas uses `sellPrice2Area` pricing
- SKU = `ProductId-Color-Size` (e.g., "S05280-Black-M")
- Each variant gets a `print_area_position` metafield containing JSON coordinates
- Coordinates are **category-based** (two groups: Tops and Hoodies)
- Tops (T-Shirt, Long Sleeve, Crewneck): `{"Front Print":{"x":"31.60","y":"15.87","width":"36.20","height":"50.80"},"Back Print":{"x":"30.60","y":"16.07","width":"39.40","height":"48.40"}}`
- Hoodies: `{"Front Print":{"x":"33.60","y":"25.53","width":"31.20","height":"36.00"},"Back Print":{"x":"32.48","y":"33.67","width":"33.80","height":"39.40"}}`
- Product front image alt text = "Front Print", back image alt text = "Back Print"
- Link to **existing** metaobjects: `front-dtf` and `back-print` (do NOT create new ones)
- Every product gets `Minimum Order Quantity` metafield set to "0"
- Template: `product.quick-order`
- DTF only (embroideryAvailable = "No")
- Images standardized to 2000x2000px matching reference proportions
- Only push: T-Shirt, Long Sleeve, Crewneck, Hoodie
- Skip: Cap, Beanie, Pants, Jacket, and unrecognized categories

### Claude's Discretion
- Image processing library choice (sharp, jimp, etc.)
- How to detect/measure garment boundaries for standardization
- Error handling strategy for failed image downloads
- Whether to process images locally before upload or let Shopify handle sizing

### Deferred Ideas (OUT OF SCOPE)
- Cap/Beanie/Pants/Jacket print area coordinates and image standardization
- New store builder wizard format
- Embroidery support
- Staged uploads fallback
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SHOP-01 | Create products in Shopify via GraphQL productSet mutation | productSet with synchronous mode; existing client.ts and mutations.ts provide foundation |
| SHOP-02 | Generate Color x Size x # of Print Areas variants with correct pricing | ProductVariantSetInput supports 3 optionValues; price differs by print area count (sellPrice1Area vs sellPrice2Area) |
| SHOP-03 | Link to existing Print Area metaobjects (front-dtf, back-print) | metaobjectByHandle query to look up existing GIDs; NO creation needed |
| SHOP-04 | Assign metafields: Print Areas (product-level list ref), print_area_position (variant-level JSON), Minimum Order Quantity (product-level) | metafieldsSet for product-level; ProductVariantSetInput.metafields for variant-level |
| SHOP-05 | Attach standardized supplier images with correct alt text | sharp for 2000x2000 standardization; stagedUploadsCreate for upload; alt text "Front Print"/"Back Print" |
| SHOP-06 | Assign product.quick-order template | templateSuffix: "quick-order" for all supported categories |
| SHOP-07 | Idempotent: re-running updates existing products | productSet with identifier: { handle } performs upsert |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @shopify/admin-api-client | ^1.1.1 | Shopify GraphQL client with retry | Already installed, built-in 429/503 retry |
| sharp | ^0.33 | Image resize/standardize to 2000x2000 | Fastest Node.js image processor, libvips-based, handles resize+extend natively |
| dotenv | ^17.3.1 | Environment variable loading | Already installed |
| zod | ^4.3.6 | Input validation | Already installed |
| winston | ^3.19.0 | Structured logging | Already installed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | Temp file handling for image processing | Download -> process -> staged upload pipeline |
| node:stream/promises | built-in | Stream pipeline for image downloads | Downloading supplier images before processing |
| node:crypto | built-in | Hash for temp filenames | Avoid collisions in temp dir |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| sharp | jimp | Jimp is pure JS (no native deps) but 4-5x slower; sharp's native libvips is worth it for batch processing |
| Local processing + staged upload | External URL pass-through | External URLs skip processing; but we NEED processing for 2000x2000 standardization, so staged upload is required |

**Installation:**
```bash
npm install sharp
```

**Recommendation (Claude's Discretion - Image Processing):** Use sharp. It is the de facto standard for Node.js image processing, handles resize with `fit: 'contain'` plus background extension natively, and is dramatically faster than alternatives. Since we must standardize images to 2000x2000 before upload, we cannot use external URL pass-through -- images must be downloaded, processed with sharp, then uploaded via staged uploads.

## Architecture Patterns

### Recommended Project Structure
```
src/
  shopify/
    client.ts              # Shopify GraphQL client (KEEP as-is)
    mutations.ts           # GraphQL mutations (ADD: metaobjectByHandle query, stagedUploadsCreate, variant response fields)
    types.ts               # TypeScript types (UPDATE: add metafields to variant input, new types)
    variants.ts            # Variant + handle + file builders (REWORK: 3 options, SKU format, print_area_position)
    metaobjects.ts         # Metaobject linking (REWORK: look up existing instead of creating)
    metaobject-setup.ts    # One-time setup (KEEP but may need new metafield definitions)
    template-map.ts        # Template mapping (SIMPLIFY: all categories -> "quick-order")
    product-push.ts        # Orchestrator (REWORK: add image processing, category filter, new metafield flow)
    image-standardizer.ts  # NEW: download + sharp resize + staged upload pipeline
    index.ts               # Barrel export (UPDATE)
  decoration/
    category-map.ts        # ADD: "Crewneck" category alias
```

### Pattern 1: Three-Option Variant Building
**What:** Each Color/Size combo produces TWO variants (one for 1 print area, one for 2 print areas), each with its own price and print_area_position metafield.
**When to use:** Building the variants array for productSet.
**Example:**
```typescript
// Each sheet row (Color x Size) becomes 2 variants
function buildVariants(rows: SheetRow[], categoryGroup: 'tops' | 'hoodies'): ProductVariantSetInput[] {
  const variants: ProductVariantSetInput[] = [];
  const printAreaCoords = PRINT_AREA_COORDINATES[categoryGroup];

  for (const row of rows) {
    // Variant for 1 print area
    variants.push({
      optionValues: [
        { optionName: 'Color', name: row.colorName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '1' },
      ],
      price: parseFloat(row.sellPrice1Area) || 0,
      sku: `${row.productId}-${row.colorName}-${row.sizeName}`,
      barcode: row.PartID,
      metafields: [{
        namespace: 'custom',
        key: 'print_area_position',
        type: 'json',
        value: JSON.stringify(printAreaCoords),
      }],
    });

    // Variant for 2 print areas
    variants.push({
      optionValues: [
        { optionName: 'Color', name: row.colorName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '2' },
      ],
      price: parseFloat(row.sellPrice2Area) || 0,
      sku: `${row.productId}-${row.colorName}-${row.sizeName}`,
      barcode: row.PartID,
      metafields: [{
        namespace: 'custom',
        key: 'print_area_position',
        type: 'json',
        value: JSON.stringify(printAreaCoords),
      }],
    });
  }
  return variants;
}
```

### Pattern 2: Look Up Existing Metaobjects by Handle
**What:** Query existing `front-dtf` and `back-print` metaobjects to get their GIDs, then link to products.
**When to use:** After product creation, when setting the Print Areas metafield.
**Example:**
```typescript
const METAOBJECT_BY_HANDLE = `
  query MetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      handle
      displayName
    }
  }
`;

// Look up once at startup, cache the GIDs
async function getExistingPrintAreaGids(client: ShopifyClient): Promise<string[]> {
  const handles = [
    { type: 'print_area', handle: 'front-dtf' },
    { type: 'print_area', handle: 'back-print' },
  ];
  const gids: string[] = [];
  for (const handle of handles) {
    const response = await client.request(METAOBJECT_BY_HANDLE, {
      variables: { handle },
    });
    if (response.data.metaobjectByHandle) {
      gids.push(response.data.metaobjectByHandle.id);
    }
  }
  return gids;
}
```

### Pattern 3: Image Standardization Pipeline
**What:** Download supplier image, resize to fit within 2000x2000 maintaining aspect ratio, extend canvas to exactly 2000x2000 with white background, upload via staged uploads.
**When to use:** For every product image before Shopify upload.
**Example:**
```typescript
import sharp from 'sharp';

async function standardizeImage(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .resize(2000, 2000, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
}
```

### Pattern 4: Category Filtering with Crewneck Support
**What:** Filter products by supported categories early in the pipeline, before any API calls.
**When to use:** First step in pushProduct, before building input.
**Example:**
```typescript
const SUPPORTED_CATEGORIES = new Set(['T-Shirt', 'Long Sleeve', 'Crewneck', 'Hoodie']);

// Category group for print area coordinates
type CategoryGroup = 'tops' | 'hoodies';

function getCategoryGroup(category: string): CategoryGroup | null {
  const resolved = resolveCategory(category);
  if (!resolved || !SUPPORTED_CATEGORIES.has(resolved)) return null;
  if (resolved === 'Hoodie') return 'hoodies';
  return 'tops'; // T-Shirt, Long Sleeve, Crewneck
}
```

### Pattern 5: Product-Level Metafields via metafieldsSet
**What:** After productSet, set product-level metafields (Print Areas, Minimum Order Quantity) separately to avoid deletion issues.
**When to use:** After product creation/update.
**Example:**
```typescript
// Set both Print Areas (list ref) and Minimum Order Quantity
await client.request(METAFIELDS_SET, {
  variables: {
    metafields: [
      {
        ownerId: productGid,
        namespace: 'custom',
        key: 'print_areas',
        type: 'list.metaobject_reference',
        value: JSON.stringify(printAreaGids), // GIDs of front-dtf and back-print
      },
      {
        ownerId: productGid,
        namespace: 'custom',
        key: 'minimum_order_quantity',
        type: 'number_integer',
        value: '0',
      },
    ],
  },
});
```

### Anti-Patterns to Avoid
- **Including metafields in productSet for updates:** Omitted metafields get deleted. Use `metafieldsSet` separately for product-level metafields.
- **Creating new metaobjects per product/category:** The old store uses TWO shared metaobjects (front-dtf, back-print) for ALL products. Never create new ones.
- **Using external URL pass-through for images:** Images MUST be standardized to 2000x2000 first, requiring download -> process -> staged upload.
- **Hardcoding metaobject GIDs:** GIDs differ between stores/environments. Always look up by handle at runtime.
- **Same SKU for different print area variants:** Both 1-area and 2-area variants of the same Color/Size use the same SKU (ProductId-Color-Size) since the SKU is for supplier ordering, not print area differentiation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image resize + canvas | Custom pixel manipulation | sharp `resize({ fit: 'contain' })` | Handles aspect ratio, padding, format conversion in one call |
| GraphQL client with retry | Custom fetch wrapper | @shopify/admin-api-client | Built-in 429/503 retry, header management |
| File upload to Shopify | Custom multipart upload | stagedUploadsCreate mutation | Official two-step flow: get presigned URL, PUT file, reference in productSet |
| Category normalization | Ad-hoc string matching | resolveCategory from category-map.ts | Already handles aliases, just needs Crewneck added |

**Key insight:** The rework simplifies the metaobject flow (lookup 2 existing instead of creating many) but adds complexity in images (must process locally) and variants (doubled count with metafields). Keep the image pipeline separate from the product push logic.

## Common Pitfalls

### Pitfall 1: Variant Count Doubling
**What goes wrong:** With 3 options (Color x Size x # of Print Areas), variant count doubles. A product with 50 Color/Size combos now has 100 variants.
**Why it happens:** Each Color/Size pair produces 2 variants (1 area + 2 areas).
**How to avoid:** Ensure the `variants(first: N)` in the response query is set high enough (use 250). Shopify's 2048 variant limit is not a concern (max ~200 variants expected).
**Warning signs:** Missing variants in the response; `hasNextPage` being true.

### Pitfall 2: Variant Metafield Deletion on productSet Update
**What goes wrong:** When updating a product with `productSet`, variant metafields not included in the input are deleted.
**Why it happens:** `productSet` treats all list fields as sync fields.
**How to avoid:** Always include `metafields` in every variant in the `variants` array, even on updates. The `print_area_position` is deterministic (category-based), so it can always be included.
**Warning signs:** print_area_position disappearing after product updates.

### Pitfall 3: Image Alt Text Must Exactly Match
**What goes wrong:** Print area overlay doesn't appear on the correct image.
**Why it happens:** The alt text "Front Print" and "Back Print" must exactly match the keys in the print_area_position JSON and the metaobject display names.
**How to avoid:** Use constants for these strings. Never localize or vary them.
**Warning signs:** Decoration overlay showing on wrong image or not appearing.

### Pitfall 4: Metaobject Type Name Mismatch
**What goes wrong:** `metaobjectByHandle` returns null.
**Why it happens:** The `type` parameter in the handle input must match the actual metaobject type in the store (e.g., "print_area" vs "print-area").
**How to avoid:** Verify the exact type name from the Shopify admin. Log clearly when lookup fails.
**Warning signs:** Null response from metaobjectByHandle with no errors.

### Pitfall 5: Staged Upload Flow Complexity
**What goes wrong:** Images fail to upload or appear broken in Shopify.
**Why it happens:** Staged uploads are a 3-step process: (1) get presigned URL via stagedUploadsCreate, (2) PUT the processed image to the URL, (3) reference the resourceUrl in productSet files.
**How to avoid:** Implement a clear pipeline: download -> sharp process -> staged upload -> collect resourceUrl. Handle each step's errors independently.
**Warning signs:** 403 errors on PUT (expired URL), images showing as broken in Shopify.

### Pitfall 6: Crewneck Not in Category Map
**What goes wrong:** Crewneck products get skipped despite being a supported category.
**Why it happens:** The current `category-map.ts` has no Crewneck alias.
**How to avoid:** Add 'crewneck' and 'crewnecks' to CATEGORY_ALIASES. Decide whether Crewneck maps to its own GarmentCategory or is an alias for an existing one.
**Warning signs:** Products with baseCategory "Crewneck" being logged as "no category found".

### Pitfall 7: SKU Format Change Breaking Existing Products
**What goes wrong:** Products that were previously pushed with `partNumber` as SKU now get `ProductId-Color-Size` SKU, causing Shopify to see them as different variants.
**Why it happens:** SKU is not used for variant matching in productSet (optionValues are), but it could cause inventory tracking issues.
**How to avoid:** Since this is a rework for a different store, this should not be an issue. But be aware that the old store may have existing products.
**Warning signs:** Duplicate SKUs in Shopify admin.

## Code Examples

### Staged Upload Flow
```typescript
// Source: https://shopify.dev/docs/api/admin-graphql/2025-01/mutations/stagedUploadsCreate
const STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

// Step 1: Get presigned URL
const { data } = await client.request(STAGED_UPLOADS_CREATE, {
  variables: {
    input: [{
      resource: 'IMAGE',
      filename: 'product-front.png',
      mimeType: 'image/png',
      fileSize: String(buffer.length),
      httpMethod: 'PUT',
    }],
  },
});

const target = data.stagedUploadsCreate.stagedTargets[0];

// Step 2: Upload processed image
await fetch(target.url, {
  method: 'PUT',
  body: buffer,
  headers: { 'Content-Type': 'image/png' },
});

// Step 3: Use resourceUrl in productSet files
const fileInput = {
  originalSource: target.resourceUrl,
  alt: 'Front Print',
  contentType: 'IMAGE',
};
```

### Print Area Coordinates Constants
```typescript
const PRINT_AREA_COORDINATES = {
  tops: {
    'Front Print': { x: '31.60', y: '15.87', width: '36.20', height: '50.80' },
    'Back Print': { x: '30.60', y: '16.07', width: '39.40', height: '48.40' },
  },
  hoodies: {
    'Front Print': { x: '33.60', y: '25.53', width: '31.20', height: '36.00' },
    'Back Print': { x: '32.48', y: '33.67', width: '33.80', height: '39.40' },
  },
} as const;
```

### Image Standardization with Sharp
```typescript
import sharp from 'sharp';

// Download image from URL, standardize to 2000x2000
async function downloadAndStandardize(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${url}`);
  const inputBuffer = Buffer.from(await response.arrayBuffer());

  return sharp(inputBuffer)
    .resize(2000, 2000, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
}
```

### Template Suffix (Simplified)
```typescript
// All supported categories use the same template in the old store
export function getTemplateSuffix(_baseCategory: string): string {
  return 'quick-order';
}
```

## Existing Code Change Summary

This section maps what exists to what needs to change, to help the planner create focused tasks.

### `src/shopify/variants.ts`
| Function | Current | Needed |
|----------|---------|--------|
| `buildHandle` | Uses productName + styleID | KEEP (works as-is) |
| `buildVariants` | Color x Size, 2 options, sellPrice1Area only | REWORK: 3 options, duplicate per print area count, different prices, add metafields |
| `buildFiles` | External URLs, generic alt text | REWORK: alt text must be "Front Print"/"Back Print", source from staged upload resourceUrls |

### `src/shopify/metaobjects.ts`
| Function | Current | Needed |
|----------|---------|--------|
| `buildPrintAreaHandle` | Builds handle from category+method+placement | REMOVE or repurpose -- not creating metaobjects |
| `buildPrintAreaInput` | Builds creation input | REMOVE -- not creating metaobjects |
| `buildPrintAreaMetafieldInput` | Builds list ref metafield | KEEP (works as-is for linking) |
| `upsertPrintAreas` | Creates metaobjects via upsert | REPLACE: lookup existing by handle |
| `linkPrintAreasToProduct` | Links GIDs to product | KEEP (works as-is) |

### `src/shopify/product-push.ts`
| Function | Current | Needed |
|----------|---------|--------|
| `buildProductSetInput` | 2 options, no variant metafields, external URL files | REWORK: 3 options, variant metafields, staged upload files, category filter |
| `pushProduct` | Creates metaobjects, no image processing | REWORK: lookup existing metaobjects, add image pipeline, add MOQ metafield |

### `src/shopify/template-map.ts`
| Current | Needed |
|---------|--------|
| Per-category suffix mapping | All categories -> "quick-order" |

### `src/shopify/types.ts`
| Current | Needed |
|---------|--------|
| ProductVariantSetInput without metafields | ADD metafields field |
| No image standardization types | ADD staged upload types |

### `src/shopify/mutations.ts`
| Current | Needed |
|---------|--------|
| No metaobjectByHandle query | ADD query |
| No stagedUploadsCreate mutation | ADD mutation |
| variants(first: 100) in PRODUCT_SET | INCREASE to first: 250 |

### `src/decoration/category-map.ts`
| Current | Needed |
|---------|--------|
| No Crewneck alias | ADD 'crewneck'/'crewnecks' aliases |

### NEW: `src/shopify/image-standardizer.ts`
| What | Purpose |
|------|---------|
| downloadAndStandardize() | Download URL -> sharp resize to 2000x2000 -> Buffer |
| uploadStagedImage() | stagedUploadsCreate -> PUT buffer -> return resourceUrl |
| processProductImages() | Orchestrate download+standardize+upload for front/back/side |

## State of the Art

| Old Approach (current code) | New Approach (rework) | Reason |
|----|----|----|
| Color x Size (2 options) | Color x Size x # of Print Areas (3 options) | Old store needs print area count as option |
| Create metaobjects per category | Look up 2 existing metaobjects | Old store has shared front-dtf / back-print |
| External URL pass-through for images | Download -> sharp -> staged upload | Images must be standardized to 2000x2000 |
| Per-category template suffix | Single "quick-order" template | Old store uses one template |
| partNumber as SKU | ProductId-Color-Size as SKU | Supplier ordering format |

## Open Questions

1. **Crewneck as GarmentCategory**
   - What we know: Crewneck is listed as a supported category in CONTEXT.md, maps to Tops group for coordinates
   - What's unclear: Whether Crewneck should be a new GarmentCategory type or alias to an existing one (Hoodie without hood?)
   - Recommendation: Add 'Crewneck' as a new GarmentCategory value and add aliases in category-map.ts. It uses Tops coordinates, not Hoodie coordinates.

2. **Staged Upload PUT method details**
   - What we know: stagedUploadsCreate returns a URL and parameters for uploading
   - What's unclear: Whether the PUT needs the parameters as form fields or just the raw body
   - Recommendation: Use `httpMethod: 'PUT'` in the staged upload input, which gives a simple PUT URL. The `parameters` in the response may need to be sent as headers. Test with one image first.

3. **Image processing for Side images**
   - What we know: Front and Back images need specific alt text for print area media
   - What's unclear: Whether Side images also need standardization, and what alt text they should use
   - Recommendation: Standardize all images to 2000x2000 for consistency. Side images get a descriptive alt text (e.g., "{productName} - {colorName} Side") but are NOT used as print area media.

4. **Metafield definition for print_area_position (variant-level)**
   - What we know: Variant metafields of type `json` may require a metafield definition to exist first
   - What's unclear: Whether the store already has this definition
   - Recommendation: Add to the setup script -- create metafield definition for `custom.print_area_position` with type `json` and ownerType `PRODUCTVARIANT`. Handle already-exists gracefully.

5. **Metafield definition for minimum_order_quantity**
   - What we know: Product-level metafield "Minimum Order Quantity" must be set to "0"
   - What's unclear: The exact namespace/key/type expected by the store's theme
   - Recommendation: Check the store admin for the existing metafield definition. If it exists, match its namespace/key. If not, create via setup script.

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
| SHOP-01 | productSet mutation builds correct input from sheet row | unit | `npx vitest run tests/shopify/product-push.test.ts` | No - Wave 0 |
| SHOP-02 | 3-option variant matrix with correct pricing per print area count | unit | `npx vitest run tests/shopify/variants.test.ts` | No - Wave 0 |
| SHOP-03 | Existing metaobject GID lookup by handle (front-dtf, back-print) | unit | `npx vitest run tests/shopify/metaobjects.test.ts` | No - Wave 0 |
| SHOP-04 | Metafield construction: print_area_position (variant), Print Areas (product), MOQ (product) | unit | `npx vitest run tests/shopify/metafields.test.ts` | No - Wave 0 |
| SHOP-05 | Image standardization to 2000x2000 and staged upload | unit | `npx vitest run tests/shopify/image-standardizer.test.ts` | No - Wave 0 |
| SHOP-06 | Template suffix returns "quick-order" for all supported categories | unit | `npx vitest run tests/shopify/template-map.test.ts` | No - Wave 0 |
| SHOP-07 | Handle generation is deterministic and unique | unit | `npx vitest run tests/shopify/handles.test.ts` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/shopify/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before verify-work

### Wave 0 Gaps
- [ ] `tests/shopify/` directory
- [ ] All test files listed above (7 files)
- [ ] Test fixtures: sample SheetRow data with sellPrice1Area/sellPrice2Area, expected 3-option variant outputs

## Sources

### Primary (HIGH confidence)
- [ProductVariantSetInput](https://shopify.dev/docs/api/admin-graphql/2025-01/input-objects/ProductVariantSetInput) - confirms metafields field on variants
- [ProductSetInput](https://shopify.dev/docs/api/admin-graphql/2025-01/input-objects/ProductSetInput) - max 3 product options confirmed
- [metaobjectByHandle query](https://shopify.dev/docs/api/admin-graphql/latest/queries/metaobjectByHandle) - lookup existing metaobjects by handle+type
- [stagedUploadsCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate) - staged upload flow for processed images
- [sharp resize API](https://sharp.pixelplumbing.com/api-resize/) - fit: 'contain' with background for canvas standardization
- [sharp npm](https://www.npmjs.com/package/sharp) - current version, installation

### Secondary (MEDIUM confidence)
- [Avoid metafield loss with productSet](https://community.shopify.com/t/shopify-api-2025-04-avoid-metafield-loss-when-using-productset/406135) - use metafieldsSet for product-level metafields
- [MetafieldInput](https://shopify.dev/docs/api/admin-graphql/2025-01/input-objects/MetafieldInput) - namespace, key, type, value fields
- [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/2025-01/mutations/metafieldsSet) - accepts any resource GID as ownerId

### Tertiary (LOW confidence)
- Staged upload PUT details (whether parameters go as headers or form fields) - needs live testing
- Exact metafield namespace/key for Minimum Order Quantity in the store - needs store inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - sharp is undisputed for Node.js image processing; Shopify client already proven
- Architecture: HIGH - productSet 3-option support confirmed; variant metafields confirmed; metaobjectByHandle confirmed
- Pitfalls: HIGH - variant count doubling, metafield deletion, alt text matching are well-documented concerns
- Image pipeline: MEDIUM - sharp processing is straightforward; staged upload PUT details need live verification
- Metafield definitions: MEDIUM - may need store inspection to match existing definitions

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (Shopify API versions are quarterly-stable; sharp is mature/stable)
