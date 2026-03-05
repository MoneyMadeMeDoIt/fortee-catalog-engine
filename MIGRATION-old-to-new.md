# Migrating from Old to New Custom Product System

## Key Differences at a Glance

| Aspect | Old System | New System |
|--------|-----------|------------|
| **Theme** | Kalles/T4S | Shopify Dawn (clean install) |
| **Page flow** | Single scrollable page | Multi-step wizard (3 or 4 steps) |
| **Variant structure** | Color x Size x # of Decoration Areas (~196 variants) | Color x Size only (~98 variants) |
| **Decoration pricing** | Baked into variant price tiers | Per-unit, from Print Area metaobject Price field |
| **Price calculation** | Variant price IS the final price | Client-side display + server-side Cart Transform |
| **Decoration method choice** | Not available — one method per area | Customer chooses DTF vs Embroidery per location |
| **Print area selection** | Flat button list, limited by max tier | Location-first tap zones with method toggle |
| **Artwork upload** | Uploadcare with manual library | Uploadcare with auto background removal |
| **Artwork preview** | Fabric.js canvas per area | Canvas-based with improved mobile UX |
| **Template** | `product.quick-order.json` | `product.single-builder.json` or `product.bundle-builder.json` |
| **JavaScript framework** | Alpine.js (`quickOrderApp`) | Alpine.js (`Alpine.store('builder')` + page components) |
| **Bundle support** | Not supported | Full 4-step bundle wizard |
| **Mobile UX** | Long scroll, poor conversion | Step-by-step, optimized for mobile |
| **Variant metafield `number_of_print_areas`** | Required | Removed — no longer needed |

---

## What Changes for Store Admins

### 1. Variant Management is Simpler

**Before:** Every product needed Color x Size x Decoration Tier variants. Adding a new color meant creating variants for every size AND every decoration tier. A 7-color, 7-size, 3-tier product = 147 variants.

**After:** Every product only needs Color x Size variants. Adding a new color means creating variants for every size only. A 7-color, 14-size product = 98 variants. All variants have the same base price (garment cost).

**Action needed:** Existing products must be migrated — remove the "# of Decoration Areas" option, set all prices to base garment cost.

### 2. Decoration Pricing Lives in One Place

**Before:** Decoration costs were embedded in variant prices. To change the cost of embroidery from $8 to $10, you'd need to update every variant that includes embroidery — across every product.

**After:** Decoration costs are set once on the Print Area metaobject entry. Change "Left Chest | Embroidery" price from $8 to $10 in one place, and it updates across ALL products that use it.

**Action needed:** Populate the Price field on all Print Area metaobject entries with actual per-unit costs.

### 3. Customers Can Now Choose Decoration Methods

**Before:** Each print area had one method. If "Left Chest" was DTF, the customer got DTF — no choice.

**After:** If a product has both "Left Chest Print" (DTF) and "Left Chest | Embroidery" assigned, the customer sees a toggle and picks their preferred method. If only one method is assigned, it auto-selects.

**Action needed:** Review each product's `custom.print_areas` metafield. Add embroidery entries where applicable.

### 4. Template Assignment Changes

**Before:** All custom products used `product.quick-order`.

**After:**
- Standalone custom products use `product.single-builder`
- Bundle products use `product.bundle-builder`
- Non-customizable bulk products can still use `product.quick-order` (Dawn version)

**Action needed:** Reassign templates for all custom products in Shopify admin.

### 5. Cart Transform Function Must Be Deployed

**Before:** No server-side pricing needed — variant price was the final price.

**After:** A Shopify Cart Transform Function must be deployed and active. It reads `_print_area_*` line item properties and adds decoration costs to the variant base price.

**Action needed:** Deploy the Cart Transform Function via Shopify CLI. Also deploy the draft order webhook app for admin-created orders.

---

## Migration Checklist

### Phase 1: Data Preparation

- [ ] Add `Location` field to Print Areas metaobject definition
- [ ] Populate `Location` for all existing Print Area entries
- [ ] Populate `Price` for all Print Area entries
- [ ] Document base garment cost for each product

### Phase 2: Cart Transform Deployment

- [ ] Build and deploy Cart Transform Function
- [ ] Test with manual cart API calls
- [ ] Build and deploy draft order webhook app

### Phase 3: Variant Migration (Per Product)

- [ ] Export product variants via CSV or Matrixify
- [ ] Remove "# of Decoration Areas" option
- [ ] Set all variant prices to base garment cost
- [ ] Delete `number_of_print_areas` variant metafield
- [ ] Keep `print_area_media` and `print_area_position` metafields
- [ ] Re-import updated variants
- [ ] Verify Cart Transform adjusts prices correctly

### Phase 4: Product Configuration

For each product:
- [ ] Review `custom.print_areas` — add embroidery entries where applicable
- [ ] Verify `custom.minimum_order_quantity` is set
- [ ] Verify `custom.size_breakdown` presets exist
- [ ] Verify `custom.size_guide` content exists
- [ ] Assign new template (`product.single-builder` or `product.bundle-builder`)

### Phase 5: Testing

- [ ] Test each product through the full wizard flow
- [ ] Verify correct prices in cart (Cart Transform working)
- [ ] Verify correct prices in draft orders (webhook working)
- [ ] Test on mobile devices (primary target)
- [ ] Test volume discounts with Regios

---

## Side-by-Side: Adding a Product

### Old Way (Quick Order Form)

1. Create product with 3 options (Color, Size, # of Decoration Areas)
2. Price ~147+ variants individually based on decoration tiers
3. Set `number_of_print_areas` metafield on every variant
4. Upload print area media per variant
5. Set product metafields (print_areas, min qty, size breakdown, size guide)
6. Assign `product.quick-order` template

**Time estimate: 30–60 minutes per product** (most time spent on variant pricing)

### New Way (Builder Wizard)

1. Create product with 2 options (Color, Size)
2. Set all ~98 variants to the same base garment price
3. Upload print area media per variant (same as before)
4. Set product metafields (print_areas with DTF+Embroidery entries, min qty, size breakdown, size guide)
5. Assign `product.single-builder` template

**Time estimate: 10–20 minutes per product** (no per-variant pricing needed)

---

## Adapting Your Workflow

### If you used to: Update decoration prices

**Old way:** Open each product → find all variants at that decoration tier → update price on each variant. Repeat for every product.

**New way:** Go to Content > Metaobjects > Print Areas → find the entry (e.g., "Left Chest | Embroidery") → change the Price field → Save. Done. All products using that entry get the new price automatically.

### If you used to: Add a new color to a product

**Old way:** Add variants for every Size x Decoration Tier combination for the new color (e.g., 7 sizes x 3 tiers = 21 new variants). Price each one.

**New way:** Add variants for every Size for the new color (e.g., 14 sizes = 14 new variants). Set them all to the base garment price. Upload print area media.

### If you used to: Add a new decoration location

**Old way:** Create a new Print Area metaobject entry. Potentially need to add a higher decoration tier to variants (e.g., add "3 Decoration Areas" variants if they don't exist). Update all affected variant prices.

**New way:** Create a new Print Area metaobject entry with Location, Method, and Price filled in. Assign it to the product's `custom.print_areas` metafield. The wizard automatically shows the new location. No variant changes needed.

### If you used to: Create draft orders in admin

**Old way:** Select the correct variant tier (e.g., "Black / M / 2 Decoration Areas") and the price was automatic.

**New way:** Select the Color x Size variant (e.g., "Black / M"). Add `_print_area_1` and `_print_area_2` line item properties with the metaobject handles. The webhook app will auto-adjust the price. Alternatively, manually set the line item price.

---

## FAQ

**Q: Can I keep some products on the old quick order form?**
A: The old quick order form was built for the Kalles/T4S theme, which is being replaced by Dawn. A Dawn-compatible quick order list section exists for simple bulk ordering (no customization), but customizable products should use the new builder wizard.

**Q: Do I need to migrate all products at once?**
A: No. You can migrate products one at a time. The Cart Transform Function only activates on line items that have `_print_area_*` properties, so old-style orders continue to work until you switch the template.

**Q: What happens to existing orders in the system?**
A: Nothing. Existing orders are already processed. The migration only affects new orders going forward.

**Q: Will the price breaks table still exist?**
A: The new wizard shows a live per-unit price breakdown instead of a pre-computed price breaks table. Volume discounts from Regios still apply and are shown at checkout.

**Q: Can the same product work in both a bundle AND as a standalone?**
A: Yes. The same product (with the same metafields) can be accessed directly via the single builder template, or included in a bundle. The data model is the same — the wizard just reads it differently.
