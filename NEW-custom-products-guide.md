# Fortee Custom Products — New System (Builder Wizard)

## How It Works

### Overview

The new system replaces the single-page quick order form with a **multi-step builder wizard** built on Shopify Dawn theme. There are two wizard types:

| Wizard | Template | Steps | Use Case |
|--------|----------|-------|----------|
| **Single Product Builder** | `product.single-builder.json` | 3 | One product with decoration options |
| **Bundle Builder** | `product.bundle-builder.json` | 4 | Multiple products bundled together |

The key architectural shift: **variants now use 3 options — Color × Size × Decoration Type**. The 3rd option ("Decoration Type") encodes the customer's decoration mix (e.g., "1D+1E" = 1 DTF area + 1 Embroidery area). Pricing is baked into the variant — no Cart Transform needed.

### Architecture Summary

| Component | How It Works |
|-----------|-------------|
| **Theme** | Shopify Dawn (clean install, OS 2.0) |
| **Rendering** | Liquid (server-side data) + Alpine.js (client-side state) |
| **Global state** | `Alpine.store('builder')` in `assets/builder-components.js` |
| **Pricing** | Baked into variant price via Decoration Type option (base garment + decoration surcharge) |
| **Draft orders** | Webhook app verifies correct decoration tier variant on staff-created orders |
| **Artwork upload** | Uploadcare with automatic background removal (`-/rembg/on/`) |
| **Volume discounts** | Regios Discounts (applies to variant price which includes decoration) |

---

### Data Model

#### Variant Structure (3 Options — Color × Size × Decoration Type)

Each product has variants structured as **Color × Size × Decoration Type**:

```
Example: T-Shirt S05610
- Black / S / 1 DTF    → $19.00 (base $14.00 + $5.00 decoration)
- Black / S / 1 Emb    → $24.00 (base $14.00 + $10.00 decoration)
- Black / S / 1D+1E    → $29.00 (base $14.00 + $15.00 decoration)
- Black / M / 1 DTF    → $19.00
- Navy / S / 2 DTF     → $24.00
...
```

**The 11 Decoration Type tiers** (max 4 areas, max 2 embroidery, flat: DTF=$5/area, Emb=$10/area):

| Tier | Meaning | Decoration Surcharge |
|------|---------|---------------------|
| 1 DTF | 1 area DTF | +$5 |
| 1 Emb | 1 area Embroidery | +$10 |
| 2 DTF | 2 areas both DTF | +$10 |
| 1D+1E | 2 areas, 1 DTF + 1 Emb | +$15 |
| 2 Emb | 2 areas both Embroidery | +$20 |
| 3 DTF | 3 areas all DTF | +$15 |
| 2D+1E | 3 areas, 2 DTF + 1 Emb | +$20 |
| 1D+2E | 3 areas, 1 DTF + 2 Emb | +$25 |
| 4 DTF | 4 areas all DTF | +$20 |
| 3D+1E | 4 areas, 3 DTF + 1 Emb | +$25 |
| 2D+2E | 4 areas, 2 DTF + 2 Emb | +$30 |

This creates ~700 variants per product (e.g., 8 colors × 8 sizes × 11 tiers = 704) — well within Shopify's 2,048 variant limit.

**The variant price includes BOTH the garment cost AND the decoration surcharge.** No server-side price adjustment needed.

#### Product Metafields

| Metafield | Purpose |
|-----------|---------|
| `custom.print_areas` | List of Print Area metaobject references — now includes BOTH DTF and Embroidery entries per location |
| `custom.minimum_order_quantity` | Minimum total units |
| `custom.size_breakdown` | Size distribution presets |
| `custom.size_guide` | Size chart content |

#### Print Area Metaobject Fields (New)

| Field | Purpose |
|-------|---------|
| Title | Admin label |
| System Alias | Internal key (e.g., `left-chest-dtf`) |
| Alias | Customer-facing label (e.g., "Left Chest") |
| Decoration Methods | Reference to decoration method (DTF or Embroidery) |
| Dimensions | Print area dimensions |
| Price | Per-unit decoration cost (used for display breakdown in builder) |
| **Location** | **NEW — Groups print areas by physical zone** (e.g., "Left Chest") |

The `Location` field is what enables the method toggle. Multiple print area entries can share the same location (e.g., "Left Chest DTF" and "Left Chest Embroidery" both have Location = "Left Chest"). The wizard groups them and shows a toggle.

#### Pre-configured Print Area Entries (12 total)

| Entry | Location | Method | Example Price |
|-------|----------|--------|--------------|
| Left Chest Print | Left Chest | DTF | $3.00 |
| Left Chest \| Embroidery | Left Chest | Embroidery | $8.00 |
| Left Chest \| DTF | Left Chest | DTF | $3.00 |
| Back Print | Back | DTF | $5.00 |
| Back Embroidery | Back | Embroidery | $10.00 |
| Front Print | Front Center | DTF | $4.50 |
| Center Cap \| DTF | Center Cap | DTF | $4.00 |
| Left Arm | Left Arm | DTF | $3.50 |
| Right Arm | Right Arm | DTF | $3.50 |
| Heart Side Cap | Heart Side Cap | DTF | $4.00 |

*(Prices are examples — actual pricing set in Shopify admin)*

---

### Customer Flow — Single Product Builder (3 Steps)

```
Step 1: UPLOAD YOUR LOGO
┌─────────────────────────────────────────────┐
│  Step 1 of 3 — Upload Your Logo              │
│  ═══════════════                             │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │     Tap to upload logo               │    │
│  │     or drag & drop                   │    │
│  │     (auto background removal)        │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  [Skip — I'll send my logo later]            │
│                                              │
│  [Continue →]                                │
└─────────────────────────────────────────────┘

Step 2: CONFIGURE (color + decorations + sizes combined)
┌─────────────────────────────────────────────┐
│  Step 2 of 3 — Configure                     │
│  ═══════════════                             │
│                                              │
│  ── Color ──                                 │
│  [Black] [White] [Navy] [Red]                │
│                                              │
│  ── Decoration Locations ──                  │
│  ┌──────────────┐  ┌──────────────┐          │
│  │  Left Chest   │  │     Back     │          │
│  │   [Select]    │  │   [Select]   │          │
│  └──────────────┘  └──────────────┘          │
│                                              │
│  ── Left Chest (selected) ──                 │
│  ┌──────────┐  ┌──────────────────┐          │
│  │  DTF     │  │   Embroidery     │          │
│  │  $3.00   │  │     $8.00        │          │
│  └──────────┘  └──────────────────┘          │
│                                              │
│  ── Sizes & Quantities ──                    │
│  Min order: 24 units                         │
│  Presets: [Even] [Top-heavy] [Custom]        │
│  S: [−] 4 [+]  M: [−] 6 [+]                 │
│  L: [−] 8 [+]  XL: [−] 6 [+]                │
│                                              │
│  ── Price Breakdown ──                       │
│  Decoration: 1D+1E (1 DTF + 1 Embroidery)   │
│  Base garment:     $14.00                    │
│  + Left Chest Emb:  $10.00                   │
│  + Back DTF:        $5.00                    │
│  Per unit:         $29.00                    │
│  x 24 units = $696.00                        │
│                                              │
│  [Review Order →]                            │
└─────────────────────────────────────────────┘

Step 3: REVIEW & ADD TO CART
┌─────────────────────────────────────────────┐
│  Step 3 of 3 — Review Your Order             │
│  ═══════════════                             │
│                                              │
│  Hoodie L00550 — Black                       │
│  Decorations:                                │
│  - Left Chest — Embroidery ($10.00)           │
│  - Back — DTF Print ($5.00)                  │
│  Decoration Type: 1D+1E                      │
│  Sizes: S(4) M(6) L(8) XL(6) = 24 units     │
│  Per unit: $29.00 | Total: $696.00           │
│                                              │
│  [Add to Cart]                               │
└─────────────────────────────────────────────┘
```

### Customer Flow — Bundle Builder (4 Steps)

```
Step 1: Upload Logo (+ "Apply to all items" toggle)
Step 2: Configure Items (overview cards → drill into each product)
Step 3: Sizes & Quantities (per product)
Step 4: Review & Add to Cart (all products summarized)
```

---

### How Pricing Works (New)

Pricing is **variant-based** — the decoration cost is baked into the variant price via the Decoration Type option. No Cart Transform Function needed (not on Shopify Plus).

**1. Client-Side (Alpine.js) — Tier Resolution + Display**
```
1. Count selected decorations by method (DTF count + Embroidery count)
2. Map to tier name (e.g., 1 DTF + 1 Emb → "1D+1E")
3. Look up variant: Color × Size × Decoration Type
4. Variant price already includes base garment + decoration surcharge
5. Display per-unit price and breakdown
```

The `getDecorationTierName()` function in `single-builder.js` handles the mapping. The builder looks up the variant by all 3 options (`option1` = color, `option2` = size, `option3` = decoration type).

**2. Cart & Checkout**

The correct variant is added to cart — its price already includes decoration. No server-side price adjustment needed. Regios Discounts applies volume breaks directly to the variant price.

**3. Draft Orders (Webhook App)**

For staff-created draft orders, a webhook app listens for `draft_orders/create` and `draft_orders/update` to verify the correct decoration tier variant is selected, adjusting via Admin API if needed.

### How Cart Submission Works (New)

```javascript
// 1. Resolve the decoration tier from selections
const tierName = getDecorationTierName(selectedDecorations);
// e.g., 1 DTF + 1 Embroidery → "1D+1E"

// 2. Build print area properties from selected decorations
const printAreaProps = {};
let areaIndex = 1;
for (const [location, systemAlias] of Object.entries(selectedDecorations)) {
  printAreaProps[`_print_area_${areaIndex}`] = selected.handle;
  printAreaProps[`artwork_${selected.alias}`] = artworkUrl;
  areaIndex++;
}

// 3. One line item per size with quantity > 0
for (const [size, qty] of Object.entries(quantities)) {
  // Find variant by Color × Size × Decoration Type (all 3 options)
  const variant = variants.find(v =>
    v.option1 === selectedColor && v.option2 === size && v.option3 === tierName
  );

  lineItems.push({
    id: variant.id,         // Color × Size × Decoration Type variant
    quantity: qty,
    properties: {
      '_print_area_1': 'left-chest-embroidery',    // metaobject handle
      '_print_area_2': 'back-dtf',                  // metaobject handle
      'artwork_Left Chest | Embroidery': 'https://ucarecdn.com/xxx/logo.png',
      'artwork_Back | DTF': 'https://ucarecdn.com/xxx/logo.png',
      // NO '_bundle_product_url' for single products
    }
  });
}
```

---

### Key Files

| File | Purpose |
|------|---------|
| `sections/main-single-builder.liquid` | Single product wizard section |
| `assets/single-builder.js` | Single product Alpine.js logic |
| `assets/single-builder.css` | Single product styles |
| `assets/builder-components.js` | Shared Alpine store + Uploadcare setup |
| `assets/builder-shared.css` | Shared builder styles |
| `snippets/bw-step-upload.liquid` | Step 1: Logo upload (shared) |
| `snippets/bw-location-zones.liquid` | Decoration location tap zones (shared) |
| `snippets/bw-method-toggle.liquid` | DTF/Embroidery method selector (shared) |
| `snippets/bw-price-breakdown.liquid` | Per-unit price display (shared) |
| `snippets/bw-step-review.liquid` | Review step (shared) |
| `snippets/bw-progress-bar.liquid` | Step indicator (shared) |
| `snippets/bw-sticky-bottom.liquid` | Sticky navigation bar (shared) |
| `snippets/bw-size-chart.liquid` | Size guide modal (shared) |
| `templates/product.single-builder.json` | Single builder template |
| `templates/product.bundle-builder.json` | Bundle builder template |

---

## How to Add a New Product (New Way)

### Step 1: Create the Product in Shopify Admin

1. Go to **Products > Add product** in Shopify admin
2. Fill in title, description, images
3. Set up **3 option types**:
   - **Option 1: Color** — Add all available colors
   - **Option 2: Size** — Add all sizes
   - **Option 3: Decoration Type** — Add all 11 tiers: `1 DTF`, `1 Emb`, `2 DTF`, `1D+1E`, `2 Emb`, `3 DTF`, `2D+1E`, `1D+2E`, `4 DTF`, `3D+1E`, `2D+2E`
4. This generates all variant combinations (e.g., 8 colors × 8 sizes × 11 tiers = 704 variants)

**Tip:** Use the `02-add-decoration-tier.graphql` script to add the Decoration Type option to existing products via the Admin API — it auto-creates all variant combinations.

### Step 2: Set Variant Prices

Set each variant's price to **base garment cost + decoration tier surcharge**:

| Variant | Price | Breakdown |
|---------|-------|-----------|
| Black / S / 1 DTF | $19.00 | $14.00 + $5.00 |
| Black / S / 1 Emb | $24.00 | $14.00 + $10.00 |
| Black / S / 2 DTF | $24.00 | $14.00 + $10.00 |
| Black / S / 1D+1E | $29.00 | $14.00 + $15.00 |
| Black / S / 2 Emb | $34.00 | $14.00 + $20.00 |
| ... | ... | ... |

Variants with the same Decoration Type tier have the same surcharge across all colors and sizes. Use the `02-set-variant-prices.graphql` script to bulk-update prices.

### Step 3: Add Product Metafields

1. **`custom.print_areas`** — Select which Print Area entries are available:
   - For products with DTF + Embroidery options: assign BOTH entries per location
     ```
     Example (Hoodie with embroidery on left chest):
     - "Left Chest Print" (DTF, $3.00)
     - "Left Chest | Embroidery" (Embroidery, $8.00)
     - "Back Print" (DTF, $5.00)
     ```
   - For products with DTF only: assign only DTF entries
     ```
     Example (T-shirt, no embroidery):
     - "Left Chest Print" (DTF, $3.00)
     - "Back Print" (DTF, $5.00)
     ```
   - The wizard automatically shows a method toggle when multiple methods exist for the same location
   - If only one method is available, it's auto-selected with no toggle shown

2. **`custom.minimum_order_quantity`** — Set the minimum (e.g., 24)
3. **`custom.size_breakdown`** — Add size distribution presets as JSON
4. **`custom.size_guide`** — Add size chart content

### Step 4: Add Variant Media

For each color variant, upload product images with **alt text matching the print area `system_alias`**:
- Front view image → alt text: `left-chest-print` (or whatever system_alias matches)
- Back view image → alt text: `back-print`
- Both DTF and Embroidery at the same location use the SAME product photo (same angle)

### Step 5: Assign the Template

1. In Shopify admin, go to the product
2. Under **Theme template**, select:
   - `product.single-builder` for standalone products
   - `product.bundle-builder` for bundle parent products
3. Save

### Step 6: Test

1. View the product on the storefront
2. Verify the 3-step wizard loads correctly
3. Test logo upload (verify background removal works)
4. Test color selection and preview image switching
5. Test decoration location selection:
   - Verify locations with multiple methods show the DTF/Embroidery toggle
   - Verify locations with one method auto-select without a toggle
6. Test size quantity inputs and minimum order enforcement
7. Verify the live price breakdown updates correctly
8. Add to cart and verify:
   - Cart shows the correct adjusted price (base + decorations)
   - Line item properties include correct `_print_area_*` handles
   - Artwork URLs are attached

---

### Troubleshooting Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| No decoration locations shown | No `print_areas` metafield assigned | Assign Print Area metaobject entries to the product |
| No method toggle shown | Only one method per location assigned | Assign both DTF and Embroidery entries for that location |
| Wrong preview image | Media alt text doesn't match `system_alias` | Update alt text to match the print area's system_alias |
| Price not updating | Alpine store not recalculating | Check `builder-components.js` for reactive bindings |
| Cart price wrong | Wrong decoration tier variant selected | Check `getDecorationTierName()` logic — verify tier name matches variant option3 |
| Variant not found | Missing variant for decoration combo | Ensure all 11 Decoration Type values exist on the product (run `02-add-decoration-tier.graphql`) |
| Draft order price wrong | Webhook not verifying tier variant | Check webhook app logs on Railway |

---

### Creating a New Print Area Entry

If a new decoration location or method needs to be added:

1. Go to **Content > Metaobjects > Print Areas** in Shopify admin
2. Click **Add entry**
3. Fill in:
   - **Title**: Admin label (e.g., "Right Arm | Embroidery")
   - **System Alias**: Internal key (e.g., `right-arm-embroidery`)
   - **Alias**: Customer-facing label (e.g., "Right Arm")
   - **Location**: Physical zone (e.g., "Right Arm") — MUST match other entries at same location
   - **Decoration Methods**: Select DTF or Embroidery
   - **Price**: Per-unit cost (e.g., $5.00)
   - **Dimensions**: Print area dimensions
4. Save
5. Now assign this entry to any products that should offer it via `custom.print_areas`

### Creating a Product Bundle

1. Go to **Content > Metaobjects > Product Bundle** in Shopify admin
2. Click **Add entry**
3. Fill in:
   - **Bundle Title**: Name of the bundle (e.g., "Business Starter Pack")
   - **Products**: Select the products included in the bundle
   - **Restrict Artwork**: Whether all items must use the same artwork
4. Create a parent product in Shopify to represent the bundle
5. Assign `product.bundle-builder` template
6. Link the bundle metaobject to the parent product
