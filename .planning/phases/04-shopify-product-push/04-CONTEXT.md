# Phase 4: Shopify Product Push - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning
**Source:** User discussion (session 2026-03-09)

<domain>
## Phase Boundary

This phase takes enriched Google Sheet rows and pushes them to the Shopify store as complete products with:
- Variants (Color x Size x # of Print Areas)
- Print Area Position metafield with coordinates for the decoration overlay
- Print Area Media images with correct alt text
- Product-level metafields (Print Areas list, Minimum Order Quantity)
- SKUs for supplier ordering
- Correct template assignment
- Standardized product images matching reference proportions

**Target store:** Old Shopify store (not the new builder wizard system).
**Supported categories:** T-shirts, Long Sleeves, Crewnecks, Hoodies only. All other garment types skipped for now.

</domain>

<decisions>
## Implementation Decisions

### Variant Structure
- Variants are **Color x Size x # of Print Areas** (3 options, not 2)
- # of Print Areas has values: 1, 2
- Variant with 1 print area uses `sellPrice1Area` pricing
- Variant with 2 print areas uses `sellPrice2Area` pricing
- This means each Color/Size combo produces 2 variants (one for 1 area, one for 2 areas)

### SKU Format
- SKU = `ProductId-Color-Size` (e.g., "S05280-Black-M")
- Used for placing orders with suppliers

### Print Area Position (Variant Metafield)
- Each variant gets a `print_area_position` metafield containing JSON
- JSON maps print area names to x/y/width/height percentages relative to the product image
- Coordinates are **category-based** (same for all products in a category group)
- **Two category groups:**
  - **Tops** (T-Shirt, Long Sleeve, Crewneck):
    ```json
    {"Front Print":{"x":"31.60","y":"15.87","width":"36.20","height":"50.80"},"Back Print":{"x":"30.60","y":"16.07","width":"39.40","height":"48.40"}}
    ```
  - **Hoodies**:
    ```json
    {"Front Print":{"x":"33.60","y":"25.53","width":"31.20","height":"36.00"},"Back Print":{"x":"32.48","y":"33.67","width":"33.80","height":"39.40"}}
    ```

### Print Area Media (Image Alt Text)
- Product front image must have alt text = "Front Print"
- Product back image must have alt text = "Back Print"
- The alt text links the image to the corresponding print area in the JSON
- This is how the dotted decoration overlay knows which image to show for each print area selection

### Print Areas Metafield (Product Level)
- Each product gets a `Print Areas` metafield (list of metaobject references)
- Links to **existing** metaobjects already in the store:
  - "Front Print" (handle: `front-dtf`)
  - "Back Print" (handle: `back-print`)
- Do NOT create new metaobjects per category — use these existing two for all products

### Minimum Order Quantity
- Every product must have `Minimum Order Quantity` metafield set to "0"

### Template
- Use `product.quick-order` template (old store)
- NOT the builder wizard template

### Decoration
- DTF only for old store (embroideryAvailable = "No" for all)
- Front and Back placements only

### Image Standardization
- All product images must be standardized to **2000x2000px**
- Garment must fill the canvas in the same proportion as the reference images
- Reference images (for garment-to-canvas ratio only, not used as actual product images):
  - Tops: S05280-Black-Front.png / S05280-Black-Back.png
  - Hoodies: L00550-Black-Front.png / L00550-Black-Back.png
- Supplier images are already fairly consistent — mostly resize/minor adjustments needed
- This standardization is required so the fixed coordinate JSON works across all products in a group

### Category Filtering
- Only push products in supported categories: T-Shirt, Long Sleeve, Crewneck (mapped to Tops group), Hoodie
- Skip: Cap, Beanie, Pants, Jacket, and any unrecognized categories
- Skipped products should be logged but not cause errors

### Claude's Discretion
- Image processing library choice (sharp, jimp, etc.)
- How to detect/measure garment boundaries for standardization (if needed beyond simple resize)
- Error handling strategy for failed image downloads
- Whether to process images locally before upload or let Shopify handle sizing

</decisions>

<specifics>
## Specific Ideas

- The Print Area Position JSON keys ("Front Print", "Back Print") must match the metaobject titles AND the image alt text exactly
- The existing metaobjects in the Shopify store have these properties:
  - Front Print: handle=front-dtf, System Alias="Front Print", Decoration Methods=DTF, Dimensions=11x11
  - Back Print: handle=back-print, System Alias="Back Print", Decoration Methods=DTF, Dimensions=11x11
- The bulk editor in Shopify admin shows: Print Area Position, Number of Print Areas, Print Area Media columns at variant level
- Reference images are in c:\Users\ugofo\Downloads\ (S05280-Black-Front.png, S05280-Black-Back.png, L00550-Black-Front.png, L00550-Black-Back.png)

</specifics>

<deferred>
## Deferred Ideas

- Cap/Beanie/Pants/Jacket print area coordinates and image standardization — later when those categories are needed
- New store builder wizard format (Color x Size only variants) — separate future work
- Embroidery support — old store is DTF only
- Staged uploads fallback — only if external URL pass-through fails

</deferred>

---
*Phase: 04-shopify-product-push*
*Context gathered: 2026-03-09 via user discussion*
