import { METAOBJECT_BY_HANDLE, METAFIELDS_SET, UPSERT_SIZE_GUIDE } from './mutations.js';
import { logger } from '../lib/logger.js';
import type { SizeSpec } from '../suppliers/types.js';

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

type ShopifyClient = {
  request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown>;
};

/**
 * Build the metafield input for linking Print Area metaobjects to a product.
 * CRITICAL: value must be JSON.stringify of the GID array for list.metaobject_reference.
 */
export function buildPrintAreaMetafieldInput(
  productGid: string,
  metaobjectGids: string[],
): MetafieldSetInput {
  return {
    ownerId: productGid,
    namespace: 'custom',
    key: 'print_areas',
    type: 'list.metaobject_reference',
    value: JSON.stringify(metaobjectGids),
  };
}

/**
 * Look up existing Print Area metaobjects by handle.
 * Queries for 'front-dtf' and 'back-print' metaobjects (must already exist in the store).
 * Returns [frontGid, backGid] array.
 * Throws if either metaobject is not found.
 */
export async function getExistingPrintAreaGids(
  client: ShopifyClient,
): Promise<string[]> {
  const handles = [
    { type: 'print_areas', handle: 'front-dtf' },
    { type: 'print_areas', handle: 'back-print' },
  ];

  const gids: string[] = [];

  for (const handle of handles) {
    const response = await client.request(METAOBJECT_BY_HANDLE, {
      variables: { handle },
    }) as {
      data: {
        metaobjectByHandle: { id: string; handle: string } | null;
      };
    };

    const metaobject = response.data.metaobjectByHandle;
    if (!metaobject) {
      throw new Error(
        `Print Area metaobject "${handle.handle}" not found in the store. ` +
        `Ensure the "${handle.handle}" metaobject exists before pushing products.`
      );
    }

    gids.push(metaobject.id);
  }

  return gids;
}

/**
 * Link Print Area metaobjects to a product via the custom.print_areas metafield.
 * Throws on userErrors from the METAFIELDS_SET mutation.
 */
export async function linkPrintAreasToProduct(
  client: ShopifyClient,
  productGid: string,
  metaobjectGids: string[],
): Promise<void> {
  const metafieldInput = buildPrintAreaMetafieldInput(productGid, metaobjectGids);

  const response = await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [metafieldInput],
    },
  }) as { data: { metafieldsSet: { metafields: unknown[] | null; userErrors: { message: string }[] } } };

  const { userErrors } = response.data.metafieldsSet;

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(', '));
  }
}

// --- Size Guide Metaobject ---

export interface SizeGuideFields {
  sizes: string[];
  variables: Array<{ label: string; values: number[] }>;
  title: string;
}

const EMPTY_RICH_TEXT = JSON.stringify({
  type: 'root',
  children: [
    {
      type: 'paragraph',
      children: [{ type: 'text', value: '' }],
    },
  ],
});

const MAX_VARIABLES = 5;

/**
 * Build the metaobject field array for a size guide.
 * Encodes sizes as JSON array, dimension values as list of {value, unit} objects.
 * Limits to 5 variables (warns on overflow).
 */
export function buildSizeGuideMetaobjectFields(
  guide: SizeGuideFields,
): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [
    { key: 'title', value: guide.title },
    { key: 'description', value: EMPTY_RICH_TEXT },
    { key: 'sizes', value: JSON.stringify(guide.sizes) },
  ];

  const variables = guide.variables;
  if (variables.length > MAX_VARIABLES) {
    console.warn(
      `Size guide "${guide.title}" has ${variables.length} variables but only ${MAX_VARIABLES} are supported. ` +
      `Extra variables will be omitted.`
    );
  }

  const included = variables.slice(0, MAX_VARIABLES);
  for (let i = 0; i < included.length; i++) {
    const variable = included[i];
    const n = i + 1;
    fields.push({ key: `variable_${n}_label`, value: variable.label });
    fields.push({
      key: `variable_${n}_values`,
      value: JSON.stringify(variable.values.map((v) => ({ value: v, unit: 'in' }))),
    });
  }

  return fields;
}

/**
 * Parse a measurement string that may contain fractions.
 * Examples: "24 1/2" → 24.5, "17" → 17, "3/4" → 0.75, "+/- 3/4" → NaN
 */
function parseMeasurement(value: string): number {
  const trimmed = value.trim();
  // Match "whole fraction" like "24 1/2" or just "1/2"
  const mixedMatch = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) {
    return parseInt(mixedMatch[1]) + parseInt(mixedMatch[2]) / parseInt(mixedMatch[3]);
  }
  const fractionMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    return parseInt(fractionMatch[1]) / parseInt(fractionMatch[2]);
  }
  return parseFloat(trimmed);
}

/**
 * Transform raw SizeSpec[] into SizeGuideFields.
 * Groups by sizeName to get unique sizes, by specName to get variables.
 * Filters out specs with non-numeric values (e.g. tolerance specs like "+/- 3/4").
 * Preserves the order of first appearance for both sizes and variables.
 * Values in each variable are parallel to the sizes array.
 */
export function transformSpecsToSizeGuide(
  _productId: string,
  productName: string,
  specs: SizeSpec[],
): SizeGuideFields {
  // Filter out specs whose values can't be parsed to valid numbers
  const numericSpecs = specs.filter((s) => {
    const parsed = parseMeasurement(s.value);
    return !isNaN(parsed) && parsed >= 0;
  });

  // Collect unique sizes in first-appearance order
  const sizeOrder: string[] = [];
  const sizeSet = new Set<string>();
  for (const spec of numericSpecs) {
    if (!sizeSet.has(spec.sizeName)) {
      sizeOrder.push(spec.sizeName);
      sizeSet.add(spec.sizeName);
    }
  }

  // Collect unique variables in first-appearance order
  const variableOrder: string[] = [];
  const variableSet = new Set<string>();
  for (const spec of numericSpecs) {
    if (!variableSet.has(spec.specName)) {
      variableOrder.push(spec.specName);
      variableSet.add(spec.specName);
    }
  }

  // Build lookup: specName -> sizeName -> value
  const lookup = new Map<string, Map<string, number>>();
  for (const spec of numericSpecs) {
    if (!lookup.has(spec.specName)) {
      lookup.set(spec.specName, new Map());
    }
    lookup.get(spec.specName)!.set(spec.sizeName, parseMeasurement(spec.value));
  }

  const variables = variableOrder.map((specName) => {
    const valuesBySize = lookup.get(specName)!;
    const values = sizeOrder.map((size) => valuesBySize.get(size) ?? 0);
    return { label: specName, values };
  });

  return {
    title: `${productName} Size Guide`,
    sizes: sizeOrder,
    variables,
  };
}

/**
 * Upsert a size guide metaobject in Shopify and return its GID.
 */
export async function upsertSizeGuideMetaobject(
  client: ShopifyClient,
  productId: string,
  productName: string,
  specs: SizeSpec[],
): Promise<string> {
  const guide = transformSpecsToSizeGuide(productId, productName, specs);
  const fields = buildSizeGuideMetaobjectFields(guide);

  const handle = `size-guide-${productId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

  const response = await client.request(UPSERT_SIZE_GUIDE, {
    variables: {
      handle: { type: 'size_guides', handle },
      metaobject: { fields },
    },
  }) as {
    data: {
      metaobjectUpsert: {
        metaobject: { id: string; handle: string } | null;
        userErrors: { field: string; message: string; code: string }[];
      };
    };
  };

  const { metaobject, userErrors } = response.data.metaobjectUpsert;

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(', '));
  }

  if (!metaobject) {
    throw new Error(`Failed to upsert size guide for product ${productId}`);
  }

  return metaobject.id;
}

/**
 * Link a size guide metaobject to a product via the custom.size_guide metafield.
 * Uses single metaobject_reference type (not list).
 */
export async function linkSizeGuideToProduct(
  client: ShopifyClient,
  productGid: string,
  sizeGuideGid: string,
): Promise<void> {
  const response = await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: productGid,
          namespace: 'custom',
          key: 'size_guide',
          type: 'metaobject_reference',
          value: sizeGuideGid,
        },
      ],
    },
  }) as { data: { metafieldsSet: { metafields: unknown[] | null; userErrors: { message: string }[] } } };

  const { userErrors } = response.data.metafieldsSet;

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(', '));
  }
}
