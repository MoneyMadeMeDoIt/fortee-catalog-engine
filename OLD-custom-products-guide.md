# Fortee Custom Products — Old System (Quick Order Form)

## How It Works

### Overview

The old system uses a **single-page quick order form** built with Alpine.js inside a Shopify product template. Customers select colors, print areas, upload artwork, and enter size quantities all on one scrollable page. Decoration pricing is **baked into variant tiers** (the variant itself encodes how many decoration areas are selected).

### Architecture Summary

| Component | How It Works |
|-----------|-------------|
| **Template** | `product.quick-order.json` (Kalles/T4S theme) |
| **Form snippet** | `snippets/quick-order-form.liquid` |
| **JavaScript** | `assets/quick-order-form.js` (Alpine.js `quickOrderApp`) |
| **CSS** | `assets/component-quick-order.css` |
| **Pricing** | Variant-based tiers: Color x Size x # of Decoration Areas |
| **Artwork upload** | Uploadcare widget with media library |
| **Canvas preview** | Fabric.js canvases per print area |

---

### Data Model

#### Variant Structure (3 Options)

Each product has variants structured as **Color x Size x # of Decoration Areas**:

```
Example: T-Shirt S05610
- Black / S / 1 Decoration Area   → $18.20
- Black / S / 2 Decoration Areas  → $24.12
- Black / M / 1 Decoration Area   → $18.20
- Black / M / 2 Decoration Areas  → $24.12
...
```

This creates ~196 variants per product (7 colors x 7 sizes x 4 decoration tiers).

**The price IS the variant price** — no server-side calculation needed. When the customer picks 2 decoration areas, the form switches to the "2 Decoration Areas" variant tier, and Shopify charges that price directly.

#### Product Metafields

| Metafield | Purpose |
|-----------|---------|
| `custom.print_areas` | List of Print Area metaobject references available for this product |
| `custom.minimum_order_quantity` | Minimum total units the customer must order |
| `custom.size_breakdown` | Pre-filled size distribution presets (Even, Top-heavy, etc.) |
| `custom.size_guide` | Size chart content for the modal |

#### Print Area Metaobject Fields (Old)

| Field | Purpose |
|-------|---------|
| Title | Admin label |
| System Alias | Internal key (e.g., `left-chest-print`) — maps to variant media alt text |
| Alias | Customer-facing label (e.g., "Left Chest") |
| Decoration Methods | Reference to decoration method metaobject |
| Dimensions | Print area dimensions |
| Price | Not actively used — pricing comes from variant tiers |

#### Variant Metafields

| Metafield | Purpose |
|-----------|---------|
| `custom.number_of_print_areas` | Number this variant tier supports (1, 2, 3, etc.) |
| `custom.print_area_media` | List of images tagged with print area system_alias alt text |
| `custom.print_area_position` | Canvas positioning data for mockup generation |

---

### Customer Flow (Single Page)

Everything happens on one scrollable page:

```
┌─────────────────────────────────────────────┐
│  Product Title + Images                      │
│                                              │
│  1. SELECT COLOR                             │
│     [Black] [White] [Navy] [Red] ...         │
│                                              │
│  2. SELECT PRINT AREAS                       │
│     [Left Chest] [Back] [Front Center]       │
│     (max limited by max_allowed_print_areas) │
│                                              │
│  3. UPLOAD ARTWORK (per selected area)       │
│     Left Chest: [Upload/Select from library] │
│     Back: [Upload/Select from library]       │
│     + Canvas preview per area                │
│     + Artwork notes per area                 │
│                                              │
│  4. SIZE QUANTITIES                          │
│     Presets: [Even] [Top-heavy] [Custom]     │
│     S: [−] 4 [+]                             │
│     M: [−] 6 [+]                             │
│     L: [−] 8 [+]                             │
│     XL: [−] 6 [+]                            │
│                                              │
│  5. PRICE BREAKS TABLE                       │
│     Showing volume tiers from variant prices │
│                                              │
│  [Add to Cart]                               │
└─────────────────────────────────────────────┘
```

### How Pricing Works

1. Customer selects a color (e.g., Black)
2. Customer selects print areas (e.g., Left Chest + Back = 2 areas)
3. The form finds the variant matching: `Black / [size] / 2 Decoration Areas`
4. That variant's price IS the final price — includes garment + decoration
5. Volume discounts come from Regios Discounts (customer tag-based)

**Price breaks** are displayed in a table derived from variant prices at different quantity tiers.

### How Cart Submission Works

```javascript
// For each size with quantity > 0:
lineItems.push({
  id: variantId,        // Color x Size x # of Decoration Areas
  quantity: qty,
  properties: {
    '_print_area_1': 'left-chest-print',      // metaobject handle
    '_print_area_2': 'back-print',            // metaobject handle
    'artwork_Left Chest Print': 'https://ucarecdn.com/xxx/logo.png',
    'artwork_Back Print': 'https://ucarecdn.com/xxx/logo.png',
    '_mockup_Left Chest Print': 'https://...',
    'Left Chest Print_notes': 'Use gold ink',
  }
});
```

The variant price already includes decoration costs, so no server-side price adjustment is needed.

### Key Limitations of Old System

| Limitation | Impact |
|-----------|--------|
| ~196 variants per product | Hits Shopify's 100-variant limit on some products; requires workarounds |
| No decoration method choice | Customer can't choose between DTF and embroidery |
| Pricing tied to variant tiers | Changing decoration prices means updating hundreds of variants |
| Single page = long scroll on mobile | 77% mobile traffic but poor mobile conversion (1.60%) |
| No visual step progression | Customer can't see where they are in the process |

---

## How to Add a New Product (Old Way)

### Step 1: Create the Product in Shopify Admin

1. Go to **Products > Add product** in Shopify admin
2. Fill in title, description, images
3. Set up **3 option types**:
   - **Option 1: Color** — Add all available colors (Black, White, Navy, etc.)
   - **Option 2: Size** — Add all sizes (S, M, L, XL, 2XL, etc.)
   - **Option 3: # of Decoration Areas** — Add tiers (1 Decoration Area, 2 Decoration Areas, etc.)
4. This generates all variant combinations automatically

### Step 2: Set Variant Prices

For every variant, set the price based on the decoration tier:

| Tier | Price Logic |
|------|------------|
| 1 Decoration Area | Base garment + 1 area decoration cost |
| 2 Decoration Areas | Base garment + 2 areas decoration cost |
| 3 Decoration Areas | Base garment + 3 areas decoration cost |

You must price **every single variant** — with 7 colors x 7 sizes x 3 tiers, that's ~147 variants to price.

### Step 3: Add Variant Metafields

For each variant, set:
- `custom.number_of_print_areas` — the decoration tier number (1, 2, 3, etc.)
- `custom.print_area_media` — upload product images for each print area angle, with alt text matching the `system_alias` of each print area

### Step 4: Add Product Metafields

1. `custom.print_areas` — Select which Print Area metaobject entries are available for this product
   - Example: Hoodie might have "Left Chest Print", "Back Print", "Left Arm Print"
   - Example: Cap might have "Center Cap", "Heart Side Cap"
2. `custom.minimum_order_quantity` — Set the minimum (e.g., 24)
3. `custom.size_breakdown` — Add size distribution presets as JSON
4. `custom.size_guide` — Add size chart content

### Step 5: Assign the Template

1. In Shopify admin, go to the product
2. Under **Theme template**, select `product.quick-order`
3. Save

### Step 6: Test

1. View the product on the storefront
2. Verify all colors show with correct swatches
3. Verify print areas display with correct preview images
4. Test artwork upload and canvas positioning
5. Test size quantity inputs and minimum order enforcement
6. Verify price breaks table shows correct volume pricing
7. Add to cart and verify the correct variant (with decoration tier) is submitted

---

### Troubleshooting Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Print area button disabled | `max_allowed_print_areas` reached | Check variant metafield `number_of_print_areas` — ensure higher tiers exist |
| Wrong preview image | Media alt text doesn't match `system_alias` | Update variant media alt text to match exactly |
| Price not changing when adding areas | Form not switching variant tier | Verify all Color x Size x Tier combinations exist as variants |
| "Sold out" on size | Variant inventory is 0 | Restock or set to "Continue selling when out of stock" |
| Canvas not loading | Missing `print_area_position` metafield | Add positioning data to the variant metafield |
