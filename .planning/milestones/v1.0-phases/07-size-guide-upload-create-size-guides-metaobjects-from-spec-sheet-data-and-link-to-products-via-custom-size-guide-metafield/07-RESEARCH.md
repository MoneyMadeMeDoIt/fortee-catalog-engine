# Phase 7: Size Guide Upload - Research

**Researched:** 2026-03-11
**Domain:** Shopify metaobjects (size_guides), spec sheet transformation, GraphQL Admin API 2026-01
**Confidence:** HIGH

## Summary

This phase creates `size_guides` metaobjects in Shopify from the existing spec sheet Google Sheet data, then links each product to its metaobject via the `custom.size_guide` metafield. The store already has 71 existing entries and a fully-defined metaobject type — no schema setup is needed.

The critical technical constraint is the Shopify Dimension field type. Each measurement value (chest, length, etc.) must be stored as a JSON object `{"value": 25.0, "unit": "in"}` and a list of dimensions must be `JSON.stringify([...])`. The project already uses `metaobjectUpsert` (via `UPSERT_PRINT_AREA` mutation in `mutations.ts`) so the pattern is established — this phase extends it for the `size_guides` type.

The spec sheet data (columns: styleName, sizeName, specName, value) maps to the metaobject as follows: each unique `specName` becomes one of the Variable Label/Values field pairs (up to 5 variables), `sizeName` values become the Sizes list, and `value` entries become the corresponding Variable N Values list (one dimension entry per size).

**Primary recommendation:** Extend `src/shopify/metaobjects.ts` with a `buildSizeGuideFields()` pure function and `upsertSizeGuideMetaobject()` async function, then wire the call into `pushProduct()` after the existing metafieldsSet step. The handle should be deterministic: `size-guide-{productId.toLowerCase()}`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@shopify/admin-api-client` | ^1.1.1 | GraphQL Admin API client | Already in project, used for all Shopify calls |
| `googleapis` | ^171.4.0 | Google Sheets API | Already in project, spec sheet read via `readSpecSheet()` |
| `vitest` | ^4.0.18 | Unit testing | Already in project, all tests use it |

### Supporting
No new libraries needed. All necessary tools exist in the project.

**Installation:**
```bash
# No new packages required
```

## Architecture Patterns

### Recommended Project Structure
```
src/shopify/
├── metaobjects.ts          # ADD: buildSizeGuideFields(), upsertSizeGuideMetaobject(), linkSizeGuideToProduct()
├── mutations.ts             # ADD: UPSERT_SIZE_GUIDE (reuse UPSERT_PRINT_AREA shape), METAOBJECT_BY_HANDLE already exists
├── product-push.ts          # WIRE: call upsertSizeGuideMetaobject() + linkSizeGuideToProduct() in pushProduct()

src/sheets/
├── spec-sheet.ts            # ADD: readSpecSheetStructured() that returns Map<productId, SizeSpec[]> (raw, not formatted)

tests/shopify/
├── size-guide.test.ts       # NEW: unit tests for buildSizeGuideFields()
```

### Pattern 1: Upsert by Deterministic Handle
**What:** Use `metaobjectUpsert` with a handle derived from productId. Creates if absent, updates if present. Idempotent — re-runs are safe.
**When to use:** Any time a metaobject has a 1:1 relationship with a product.
**Example:**
```typescript
// Source: existing pattern in src/shopify/mutations.ts (UPSERT_PRINT_AREA)
const handle: MetaobjectHandleInput = {
  type: 'size_guides',
  handle: `size-guide-${productId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
};
```

### Pattern 2: Dimension Field Encoding
**What:** Shopify Dimension type stores as JSON object stringified. List of dimensions is a JSON array stringified.
**When to use:** Variable N Values fields (each is `list.dimension`).

```typescript
// Source: https://shopify.dev/docs/apps/build/metafields/list-of-data-types
// Single dimension:
const dimensionValue = JSON.stringify({ value: 25.0, unit: 'in' });
// => '{"value":25,"unit":"in"}'

// List of dimensions (for Variable N Values — one entry per size):
const dimensionListValue = JSON.stringify([
  { value: 36.0, unit: 'in' },
  { value: 38.0, unit: 'in' },
  { value: 40.0, unit: 'in' },
]);
// => '[{"value":36,"unit":"in"},{"value":38,"unit":"in"},{"value":40,"unit":"in"}]'
```

### Pattern 3: List of Text Field Encoding
**What:** `list.single_line_text_field` stores as JSON array of strings stringified.
**When to use:** The Sizes field (e.g. `["S","M","L","XL"]`).

```typescript
// Source: https://shopify.dev/docs/apps/build/metafields/list-of-data-types
const sizesValue = JSON.stringify(['S', 'M', 'L', 'XL']);
// => '["S","M","L","XL"]'
```

### Pattern 4: Rich Text Field Encoding
**What:** Description field (type `rich_text_field`) requires a specific root/paragraph JSON structure.
**When to use:** Any rich text metaobject field.

```typescript
// Source: https://shopify.dev/docs/apps/build/metafields/list-of-data-types
const richTextValue = JSON.stringify({
  type: 'root',
  children: [
    {
      type: 'paragraph',
      children: [{ type: 'text', value: '' }],
    },
  ],
});
```

### Spec Sheet Data Mapping

The spec sheet columns map to `size_guides` metaobject fields as follows:

```
Spec sheet structure (per productId):
  styleName=A230, sizeName=S,  specName=Chest, value=34
  styleName=A230, sizeName=S,  specName=Length, value=27
  styleName=A230, sizeName=M,  specName=Chest, value=36
  styleName=A230, sizeName=M,  specName=Length, value=29

Maps to metaobject fields:
  sizes:              ["S", "M"]                              (list.single_line_text_field)
  variable_1_label:   "Chest"                                 (single_line_text_field)
  variable_1_values:  [{"value":34,"unit":"in"}, {"value":36,"unit":"in"}]  (list.dimension)
  variable_2_label:   "Length"                                (single_line_text_field)
  variable_2_values:  [{"value":27,"unit":"in"}, {"value":29,"unit":"in"}]  (list.dimension)
```

Key insight: sizes list order defines the index correspondence with variable N values. Size at index 0 corresponds to dimension value at index 0. This ordering must be preserved from spec sheet row order (using `sizeOrder` column if available — spec sheet has `sizeOrder` as a known column per project memory).

### Anti-Patterns to Avoid
- **Passing raw numeric string as dimension value:** Spec sheet values are strings (e.g. `"34"`). Must parse to float before putting into dimension JSON. `parseFloat("34")` = `34`, not `"34"`.
- **Using Description field as plain text:** The Description field type is `rich_text_field` — plain strings will fail. Must wrap in the root/paragraph structure.
- **Creating a new metaobject definition:** The `size_guides` definition already exists with 71 entries. Do NOT call `metaobjectDefinitionCreate` for this type.
- **Setting `custom.size_guide` as `list.metaobject_reference`:** It is `metaobject_reference` (single), not a list. Value is a single GID string, not a JSON array.
- **Skipping products with no spec data:** The push should skip setting the size_guide metafield if no spec data exists for the product rather than throwing. Log a warning.
- **Loading the full spec sheet on every product push:** Cache the spec sheet Map in pushProduct flow or pass it in as a parameter to avoid redundant API calls.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Spec sheet reading | Custom Sheets API calls | Extend `readSpecSheet()` in `spec-sheet.ts` | Already handles auth, range, header parsing |
| Metaobject upsert | Custom create+update logic | `metaobjectUpsert` mutation | Handles both create and update atomically |
| Dimension parsing | Custom unit/value string parsing | `parseFloat()` + hardcoded unit | Values in spec sheet are simple numbers |
| Handle sanitization | Complex regex | Simple `.toLowerCase().replace(/[^a-z0-9-]/g, '-')` | Shopify handles are alphanumeric+dash |

**Key insight:** The project already has `UPSERT_PRINT_AREA` mutation string with identical structure. Duplicate the mutation string as `UPSERT_SIZE_GUIDE` (or make it generic) rather than writing new GraphQL from scratch.

## Common Pitfalls

### Pitfall 1: Dimension Unit Mismatch
**What goes wrong:** Spec sheet values are in inches (garment measurements). The Shopify dimension type will accept any valid unit but the store may display wrong units if inconsistent.
**Why it happens:** The spec sheet doesn't include units — the value column is just a number like `"34"`.
**How to avoid:** Hardcode unit `"in"` (inches) for all dimension values. All garment measurements in this store are in inches.
**Warning signs:** Shopify admin shows measurements in wrong scale (e.g., 34cm instead of 34in).

### Pitfall 2: Sizes List Order vs Variable Values Order Mismatch
**What goes wrong:** If sizes are listed in one order in the Sizes field but dimension values are in a different order, the chart renders incorrectly (S shows M's measurements).
**Why it happens:** JavaScript `Map` iteration order is insertion order. Spec sheet rows may not be sorted by size.
**How to avoid:** Sort both the sizes array and the values arrays together using the `sizeOrder` column from the spec sheet (the spec sheet has a `sizeOrder` column per project memory). If sizeOrder not available, use a standard size sort order constant.
**Warning signs:** XL measurements appearing in S column in the store.

### Pitfall 3: Variable Count Mismatch (>5 measurement types)
**What goes wrong:** If a product has more than 5 unique `specName` values (measurement types), there aren't enough Variable fields.
**Why it happens:** The metaobject definition only has Variable 1 through Variable 5 (5 label+values pairs).
**How to avoid:** Limit to first 5 unique specNames. Log a warning if more than 5 are found.
**Warning signs:** Silently dropped measurement data.

### Pitfall 4: Metaobject Handle Collision
**What goes wrong:** Two products with similar names could produce the same handle after sanitization.
**Why it happens:** Handle derivation strips special characters.
**How to avoid:** Use productId (e.g., `A230`) not productName for handle construction. ProductIds are already unique keys in the system.
**Warning signs:** Shopify returns "handle already taken" userError on upsert for wrong product type, or an existing unrelated metaobject gets overwritten.

### Pitfall 5: `custom.size_guide` Type is Single Reference, Not List
**What goes wrong:** Using `list.metaobject_reference` type with a JSON array value when the field is actually `metaobject_reference` (single).
**Why it happens:** The `custom.print_areas` field is a list — developers copy that pattern.
**How to avoid:** Set type `'metaobject_reference'` and value as the raw GID string (no JSON.stringify array wrapping).
**Warning signs:** Shopify userError "value is not valid for type".

### Pitfall 6: spec-sheet.ts Currently Returns Formatted Strings, Not Raw Specs
**What goes wrong:** The existing `readSpecSheet()` returns `Map<productId, string>` (formatted text), not the raw `SizeSpec[]` arrays needed to build dimension fields.
**Why it happens:** `readSpecSheet()` was built for enrichment, not for structured metaobject creation.
**How to avoid:** Add a new function `readSpecSheetStructured()` (or a flag parameter) that returns `Map<productId, SizeSpec[]>` without formatting. Do NOT modify the existing function signature — it's used by the enrichment flow.
**Warning signs:** Trying to parse the formatted string "S: Chest 34, Length 27 | M: Chest 36, Length 29" back into structured data.

## Code Examples

Verified patterns from official sources and existing project code:

### metaobjectUpsert Mutation (extend mutations.ts)
```typescript
// Source: existing UPSERT_PRINT_AREA in src/shopify/mutations.ts
export const UPSERT_SIZE_GUIDE = `
  mutation metaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        id
        handle
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;
```

### buildSizeGuideFields() — Pure Function
```typescript
// Source: project pattern from buildPrintAreaMetafieldInput() in metaobjects.ts
// + Dimension format from https://shopify.dev/docs/apps/build/metafields/list-of-data-types
interface SizeGuideFields {
  sizes: string[];             // e.g. ['S', 'M', 'L', 'XL']
  variables: Array<{
    label: string;             // e.g. 'Chest'
    values: number[];          // e.g. [34, 36, 38, 40] — parallel to sizes
  }>;
  title: string;               // e.g. 'A230 Size Guide'
}

function buildSizeGuideMetaobjectFields(
  guide: SizeGuideFields,
): MetaobjectField[] {
  const fields: MetaobjectField[] = [
    { key: 'title', value: guide.title },
    {
      key: 'sizes',
      value: JSON.stringify(guide.sizes),
    },
    // Description: empty rich text (required shape even when blank)
    {
      key: 'description',
      value: JSON.stringify({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }],
      }),
    },
  ];

  const MAX_VARIABLES = 5;
  const variableSlots = guide.variables.slice(0, MAX_VARIABLES);

  for (let i = 0; i < variableSlots.length; i++) {
    const n = i + 1; // 1-indexed
    const v = variableSlots[i];
    fields.push({ key: `variable_${n}_label`, value: v.label });
    fields.push({
      key: `variable_${n}_values`,
      value: JSON.stringify(
        v.values.map((val) => ({ value: val, unit: 'in' })),
      ),
    });
  }

  return fields;
}
```

### Link size_guide Metafield to Product
```typescript
// Source: project pattern from linkPrintAreasToProduct() in metaobjects.ts
// Type is 'metaobject_reference' (single), NOT 'list.metaobject_reference'
const metafieldInput: MetafieldSetInput = {
  ownerId: productGid,
  namespace: 'custom',
  key: 'size_guide',
  type: 'metaobject_reference',
  value: sizeGuideGid, // raw GID string, NOT JSON.stringify([gid])
};
```

### readSpecSheetStructured() — New Function in spec-sheet.ts
```typescript
// Add alongside existing readSpecSheet() — do NOT replace it
// Returns raw SizeSpec[] per product for structured metaobject building
export async function readSpecSheetStructured(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName = 'Sheet1',
): Promise<Map<string, SizeSpec[]>> {
  // Same read logic as readSpecSheet()
  // But return specsByProduct (Map<string, SizeSpec[]>) directly
  // instead of calling formatSizeChart()
}
```

### pushProduct() Integration Point
```typescript
// Add after step 13 (product-level metafields set), before step 14 (media query)
// in src/shopify/product-push.ts

// Step 13b. Upsert size guide metaobject and link to product
const specSpreadsheetId = process.env.SPEC_SHEET_GOOGLE_SPREADSHEET_ID;
if (specSpreadsheetId) {
  const specMap = await readSpecSheetStructured(sheets, specSpreadsheetId);
  const productSpecs = specMap.get(rows[0].productId);
  if (productSpecs && productSpecs.length > 0) {
    const sizeGuideGid = await upsertSizeGuideMetaobject(
      client,
      rows[0].productId,
      rows[0].productName,
      productSpecs,
    );
    await linkSizeGuideToProduct(client, productGid, sizeGuideGid);
    logger.info(`Linked size guide to product: ${sizeGuideGid}`);
  } else {
    logger.warn(`No spec data for productId "${rows[0].productId}" — skipping size guide`);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `readSpecSheet()` returns formatted string | Need `readSpecSheetStructured()` returning raw `SizeSpec[]` | This phase | Enables building structured dimension fields |
| `metaobjectCreate` (fails on duplicate) | `metaobjectUpsert` (idempotent) | Project convention since Phase 4 | Re-runs safe |

**Deprecated/outdated:**
- `formatSizeChart()` output: That formatted string was for the Google Sheet `sizeChart` column. For metaobject creation, use raw `SizeSpec[]` instead.

## Open Questions

1. **Exact metaobject field keys for the store's size_guides definition**
   - What we know: Field names from the brief are Title, Description, How to Measure, Sizes, Variable 1 Label, Variable 1 Values... Variable 5 Values.
   - What's unclear: The API field keys (lowercased, underscored). Likely `title`, `description`, `how_to_measure`, `sizes`, `variable_1_label`, `variable_1_values`, etc. — but the store's actual definition may differ.
   - Recommendation: In Wave 0 task, add a one-time script or introspection query to fetch the actual field keys via `metaobjectDefinitions` query before implementing field builders. Alternatively, test with one product first and inspect userErrors.

2. **Spec sheet sizeOrder column availability**
   - What we know: Project memory mentions `sizeOrder` column exists in the spec sheet (~20,746 rows).
   - What's unclear: Whether all rows have valid sizeOrder values or if some are blank.
   - Recommendation: Use sizeOrder for sorting when non-empty; fall back to a hardcoded standard size order array `['XS','S','M','L','XL','2XL','3XL','4XL']` for the fallback.

3. **How to Measure field (File type)**
   - What we know: The metaobject has a `How to Measure` field of type `File`.
   - What's unclear: Whether to populate it programmatically. File type requires a file GID.
   - Recommendation: Leave this field unset (omit from fields array). Shopify allows partial field updates. The user can set it manually in admin.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none — uses package.json scripts |
| Quick run command | `npx vitest run tests/shopify/size-guide.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SG-01 | buildSizeGuideMetaobjectFields() encodes sizes as JSON array | unit | `npx vitest run tests/shopify/size-guide.test.ts` | Wave 0 |
| SG-02 | buildSizeGuideMetaobjectFields() encodes dimension list correctly | unit | `npx vitest run tests/shopify/size-guide.test.ts` | Wave 0 |
| SG-03 | buildSizeGuideMetaobjectFields() limits to 5 variables | unit | `npx vitest run tests/shopify/size-guide.test.ts` | Wave 0 |
| SG-04 | buildSizeGuideMetaobjectFields() includes empty rich text for description | unit | `npx vitest run tests/shopify/size-guide.test.ts` | Wave 0 |
| SG-05 | linkSizeGuideToProduct() uses metaobject_reference type (not list) | unit | `npx vitest run tests/shopify/size-guide.test.ts` | Wave 0 |
| SG-06 | readSpecSheetStructured() returns raw SizeSpec[] per product | unit | `npx vitest run tests/sheets/spec-sheet.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/shopify/size-guide.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/shopify/size-guide.test.ts` — covers SG-01 through SG-05
- [ ] `tests/sheets/spec-sheet.test.ts` — covers SG-06 (new `readSpecSheetStructured` function)

## Sources

### Primary (HIGH confidence)
- https://shopify.dev/docs/apps/build/metafields/list-of-data-types — Dimension type JSON format `{"value": 25.0, "unit": "cm"}`, list.dimension format, list.single_line_text_field format, rich_text_field structure
- Existing codebase: `src/shopify/metaobjects.ts`, `src/shopify/mutations.ts` — established upsert/link patterns
- Existing codebase: `src/sheets/spec-sheet.ts` — current spec sheet reading approach

### Secondary (MEDIUM confidence)
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectupsert — mutation signature confirmed matches existing UPSERT_PRINT_AREA pattern in project

### Tertiary (LOW confidence)
- Actual field keys for the store's `size_guides` metaobject definition — inferred from brief description, not verified via API introspection. Must be confirmed with a `metaobjectDefinitions` query in Wave 0.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, all existing
- Architecture: HIGH — mirrors established upsert/link pattern in the codebase
- Dimension field format: HIGH — verified from official Shopify docs
- Pitfalls: HIGH — derived from actual codebase analysis
- Actual metaobject field keys: LOW — inferred, not introspected

**Research date:** 2026-03-11
**Valid until:** 2026-06-11 (Shopify API 2026-01 stable, metaobject API stable)
