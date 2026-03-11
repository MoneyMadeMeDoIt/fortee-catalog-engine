import {
  METAOBJECTS_BY_TYPE,
  METAOBJECT_CREATE,
  PRODUCT_OPTIONS_CREATE,
  PRODUCT_VARIANTS_BULK_CREATE,
  PRODUCT_VARIANTS_BULK_DELETE,
  PRODUCT_BY_HANDLE,
} from './mutations.js';
import { logger } from '../lib/logger.js';
import type { SheetRow } from '../sheets/types.js';
import type { MetafieldInput, PrintAreaCoords } from './types.js';

type ShopifyClient = {
  request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown>;
};

interface ColorMetaobject {
  id: string;
  handle: string;
  displayName: string;
  color?: string;
}

/**
 * Convert a color name to a URL-safe handle.
 * "Collegiate Navy" → "collegiate-navy"
 */
function toHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Fetch all existing shopify--color-pattern metaobjects from the store.
 * Returns a map of handle → { id, handle, displayName, color }.
 */
async function fetchExistingColorPatterns(
  client: ShopifyClient,
): Promise<Map<string, ColorMetaobject>> {
  const response = (await client.request(METAOBJECTS_BY_TYPE, {
    variables: { type: 'shopify--color-pattern', first: 100 },
  })) as {
    data: {
      metaobjects: {
        edges: {
          node: {
            id: string;
            handle: string;
            displayName: string;
            fields: { key: string; value: string }[];
          };
        }[];
      };
    };
  };

  const map = new Map<string, ColorMetaobject>();
  for (const { node } of response.data.metaobjects.edges) {
    const colorField = node.fields.find((f) => f.key === 'color');
    map.set(node.handle, {
      id: node.id,
      handle: node.handle,
      displayName: node.displayName,
      color: colorField?.value,
    });
  }

  return map;
}

/** Shopify color taxonomy IDs mapped by keyword. */
const COLOR_TAXONOMY: Record<string, string> = {
  black: 'gid://shopify/TaxonomyValue/1',
  blue: 'gid://shopify/TaxonomyValue/2',
  royal: 'gid://shopify/TaxonomyValue/2',
  beige: 'gid://shopify/TaxonomyValue/3',
  white: 'gid://shopify/TaxonomyValue/3',
  sand: 'gid://shopify/TaxonomyValue/3',
  ivory: 'gid://shopify/TaxonomyValue/3',
  gold: 'gid://shopify/TaxonomyValue/4',
  tan: 'gid://shopify/TaxonomyValue/6',
  cream: 'gid://shopify/TaxonomyValue/6',
  camel: 'gid://shopify/TaxonomyValue/6',
  brown: 'gid://shopify/TaxonomyValue/7',
  maroon: 'gid://shopify/TaxonomyValue/7',
  grey: 'gid://shopify/TaxonomyValue/8',
  gray: 'gid://shopify/TaxonomyValue/8',
  charcoal: 'gid://shopify/TaxonomyValue/8',
  graphite: 'gid://shopify/TaxonomyValue/8',
  ash: 'gid://shopify/TaxonomyValue/8',
  heather: 'gid://shopify/TaxonomyValue/8',
  oxford: 'gid://shopify/TaxonomyValue/8',
  green: 'gid://shopify/TaxonomyValue/9',
  kelly: 'gid://shopify/TaxonomyValue/9',
  orange: 'gid://shopify/TaxonomyValue/10',
  pink: 'gid://shopify/TaxonomyValue/11',
  purple: 'gid://shopify/TaxonomyValue/12',
  red: 'gid://shopify/TaxonomyValue/13',
  cardinal: 'gid://shopify/TaxonomyValue/13',
  yellow: 'gid://shopify/TaxonomyValue/14',
  butter: 'gid://shopify/TaxonomyValue/14',
  navy: 'gid://shopify/TaxonomyValue/15',
};

const SOLID_PATTERN = 'gid://shopify/TaxonomyValue/2874';

/** Guess the Shopify color taxonomy value from a color name. */
function guessColorTaxonomy(colorName: string): string {
  const lower = colorName.toLowerCase();
  for (const [keyword, gid] of Object.entries(COLOR_TAXONOMY)) {
    if (lower.includes(keyword)) return gid;
  }
  // Default to black if unknown
  return 'gid://shopify/TaxonomyValue/1';
}

/**
 * Find a matching metaobject using fuzzy matching.
 * Tries: exact handle → existing label contained in color name → color name contained in existing label.
 */
function findFuzzyMatch(
  colorName: string,
  existing: Map<string, ColorMetaobject>,
): ColorMetaobject | null {
  const handle = toHandle(colorName);

  // 1. Exact handle match
  const exact = existing.get(handle);
  if (exact) return exact;

  const lower = colorName.toLowerCase();

  // 2. Find existing label that is a substring of the input color name
  // E.g., "Collegiate Navy" contains "navy" → match to navy metaobject
  for (const mo of existing.values()) {
    const moLabel = mo.displayName.toLowerCase();
    if (lower.includes(moLabel) && moLabel.length >= 3) {
      return mo;
    }
  }

  // 3. Check if input color name is contained in an existing label
  // E.g., "Red" is contained in "Red and white"
  // Skip this — too aggressive, could cause wrong matches

  return null;
}

/**
 * Create a new shopify--color-pattern metaobject with required taxonomy references.
 * Returns the created metaobject's GID.
 */
async function createColorPattern(
  client: ShopifyClient,
  label: string,
  hexColor: string,
): Promise<string> {
  const handle = toHandle(label);
  const colorTax = guessColorTaxonomy(label);

  const response = (await client.request(METAOBJECT_CREATE, {
    variables: {
      metaobject: {
        type: 'shopify--color-pattern',
        handle,
        fields: [
          { key: 'label', value: label },
          { key: 'color', value: hexColor },
          { key: 'color_taxonomy_reference', value: JSON.stringify([colorTax]) },
          { key: 'pattern_taxonomy_reference', value: SOLID_PATTERN },
        ],
      },
    },
  })) as {
    data: {
      metaobjectCreate: {
        metaobject: { id: string; handle: string; displayName: string } | null;
        userErrors: { field: string[]; message: string; code: string }[];
      };
    };
  };

  const { metaobject, userErrors } = response.data.metaobjectCreate;

  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => `[${e.field?.join('.')}] ${e.message}`).join('; ');
    throw new Error(`Failed to create color pattern "${label}": ${messages}`);
  }

  if (!metaobject) {
    throw new Error(`metaobjectCreate returned no metaobject for "${label}"`);
  }

  logger.info(`Created color pattern metaobject: "${label}" (${handle}) → ${metaobject.id}`);
  return metaobject.id;
}

export interface ColorInfo {
  gid: string;
  /** The metaobject's display name (e.g. "Black", "Navy") — used as option value name. */
  displayName: string;
}

/**
 * For each unique color in the rows, find or create a shopify--color-pattern metaobject.
 * Returns a Map<colorName, ColorInfo> with both GID and display name.
 *
 * Matching strategy:
 * 1. Exact handle match (e.g., "Black" → handle "black")
 * 2. Fuzzy match — existing label contained in color name (e.g., "Collegiate Navy" → "navy")
 * 3. If no match, create a new metaobject with hex color + taxonomy references
 */
export async function getOrCreateColorMetaobjects(
  client: ShopifyClient,
  rows: SheetRow[],
): Promise<Map<string, ColorInfo>> {
  const existing = await fetchExistingColorPatterns(client);
  const colorMap = new Map<string, ColorInfo>();

  // Collect unique colors with their hex values
  const uniqueColors = new Map<string, string>();
  for (const row of rows) {
    if (row.colorName && !uniqueColors.has(row.colorName)) {
      uniqueColors.set(row.colorName, row.color1 || '#000000');
    }
  }

  for (const [colorName, hexColor] of uniqueColors) {
    // Try fuzzy matching against existing metaobjects
    const match = findFuzzyMatch(colorName, existing);
    if (match) {
      logger.info(`Color "${colorName}" → existing metaobject "${match.handle}" (${match.id})`);
      colorMap.set(colorName, { gid: match.id, displayName: match.displayName });
      continue;
    }

    // No match — create new metaobject
    const gid = await createColorPattern(client, colorName, hexColor);
    colorMap.set(colorName, { gid, displayName: colorName });
  }

  return colorMap;
}

/**
 * Add a linked Color option to a product via productOptionsCreate.
 * The Color option references shopify.color-pattern metaobjects.
 */
export async function addLinkedColorOption(
  client: ShopifyClient,
  productGid: string,
): Promise<void> {
  const response = (await client.request(PRODUCT_OPTIONS_CREATE, {
    variables: {
      productId: productGid,
      options: [
        {
          name: 'Color',
          position: 1,
          linkedMetafield: {
            namespace: 'shopify',
            key: 'color-pattern',
          },
        },
      ],
    },
  })) as {
    data: {
      productOptionsCreate: {
        product: { id: string } | null;
        userErrors: { field: string[]; message: string; code: string }[];
      };
    };
  };

  const { userErrors } = response.data.productOptionsCreate;
  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => `[${e.field?.join('.')}] ${e.message}`).join('; ');
    throw new Error(`productOptionsCreate failed: ${messages}`);
  }

  logger.info('Added linked Color option (values from shopify.color-pattern metafield)');
}

/**
 * Build variant inputs for productVariantsBulkCreate.
 * Uses linkedMetafieldValue for Color option (linked to metaobjects).
 */
export interface LinkedVariantInput {
  optionValues: { optionName: string; name: string }[];
  price: string;
  inventoryItem: { sku: string };
  barcode: string;
  metafields: MetafieldInput[];
}

/**
 * Build variant inputs for productVariantsBulkCreate.
 * Uses the color's display name (from metaobject) for the Color option value.
 * The Color option is linked to metaobjects, but variant creation uses display names.
 * printAreaCoords are computed dynamically from the processed front image's garment placement.
 */
export function buildLinkedVariants(
  rows: SheetRow[],
  colorMap: Map<string, ColorInfo>,
  printAreaCoords: PrintAreaCoords | null,
): LinkedVariantInput[] {
  const coordsJson = printAreaCoords ? JSON.stringify(printAreaCoords) : '{}';
  const variants: LinkedVariantInput[] = [];

  for (const row of rows) {
    const colorInfo = colorMap.get(row.colorName);
    if (!colorInfo) {
      logger.warn(`No color metaobject for "${row.colorName}" — skipping variants`);
      continue;
    }

    const sku = `${row.productId}-${row.colorName}-${row.sizeName}`;
    const baseMetafields: MetafieldInput[] = [
      { namespace: 'custom', key: 'print_area_position', type: 'json', value: coordsJson },
    ];

    // 1 print area variant
    variants.push({
      optionValues: [
        { optionName: 'Color', name: colorInfo.displayName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '1' },
      ],
      price: (parseFloat(row.sellPrice1Area) || 0).toFixed(2),
      inventoryItem: { sku },
      barcode: row.PartID,
      metafields: [
        ...baseMetafields,
        { namespace: 'custom', key: 'number_of_print_areas', type: 'number_integer', value: '1' },
      ],
    });

    // 2 print areas variant
    variants.push({
      optionValues: [
        { optionName: 'Color', name: colorInfo.displayName },
        { optionName: 'Size', name: row.sizeName },
        { optionName: '# of Print Areas', name: '2' },
      ],
      price: (parseFloat(row.sellPrice2Area) || 0).toFixed(2),
      inventoryItem: { sku },
      barcode: row.PartID,
      metafields: [
        ...baseMetafields,
        { namespace: 'custom', key: 'number_of_print_areas', type: 'number_integer', value: '2' },
      ],
    });
  }

  return variants;
}

interface VariantResult {
  id: string;
  sku: string;
  selectedOptions: { name: string; value: string }[];
}

/**
 * Create variants, handling the auto-generated variant from option creation.
 *
 * When options are added, Shopify auto-creates one variant (first color × first size × first print area).
 * We skip creating that combination and update the existing one instead.
 *
 * @param autoVariant - The auto-generated variant to skip/update (null if re-run)
 */
export async function createLinkedVariants(
  client: ShopifyClient,
  productGid: string,
  variants: LinkedVariantInput[],
  autoVariant: { id: string; selectedOptions: { name: string; value: string }[] } | null,
): Promise<VariantResult[]> {
  const allCreated: VariantResult[] = [];

  // Build key for auto-generated variant to skip
  const autoKey = autoVariant
    ? autoVariant.selectedOptions.map((o) => `${o.name}=${o.value}`).join('|')
    : null;

  // Filter out the auto-generated variant
  const toCreate = autoKey
    ? variants.filter((v) => {
        const key = v.optionValues.map((o) => `${o.optionName}=${o.name}`).join('|');
        return key !== autoKey;
      })
    : variants;

  // Create new variants in batches
  for (let i = 0; i < toCreate.length; i += 250) {
    const batch = toCreate.slice(i, i + 250);

    const response = (await client.request(PRODUCT_VARIANTS_BULK_CREATE, {
      variables: { productId: productGid, variants: batch },
    })) as {
      data?: {
        productVariantsBulkCreate: {
          productVariants: VariantResult[] | null;
          userErrors: { field: string[]; message: string; code: string }[];
        };
      };
      errors?: { graphQLErrors?: { message: string }[] };
    };

    if (!response.data?.productVariantsBulkCreate) {
      const gqlErrors = response.errors?.graphQLErrors?.map((e) => e.message).join('; ') || 'Unknown error';
      throw new Error(`productVariantsBulkCreate failed (batch ${i / 250 + 1}): ${gqlErrors}`);
    }

    const { productVariants, userErrors } = response.data.productVariantsBulkCreate;

    if (userErrors.length > 0) {
      const messages = userErrors.map((e) => `[${e.field?.join('.')}] ${e.message}`).join('\n');
      throw new Error(`productVariantsBulkCreate errors (batch ${i / 250 + 1}):\n${messages}`);
    }

    if (productVariants) {
      allCreated.push(...productVariants);
    }

    logger.info(`Created variant batch ${i / 250 + 1}: ${batch.length} variants`);
  }

  // Update the auto-generated variant's price/sku/metafields
  if (autoVariant && autoKey) {
    const matchingVariant = variants.find((v) => {
      const key = v.optionValues.map((o) => `${o.optionName}=${o.name}`).join('|');
      return key === autoKey;
    });

    if (matchingVariant) {
      const updateResponse = (await client.request(
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id sku selectedOptions { name value } }
            userErrors { field message code }
          }
        }`,
        {
          variables: {
            productId: productGid,
            variants: [{
              id: autoVariant.id,
              price: matchingVariant.price,
              inventoryItem: matchingVariant.inventoryItem,
              barcode: matchingVariant.barcode,
              metafields: matchingVariant.metafields,
            }],
          },
        },
      )) as {
        data?: {
          productVariantsBulkUpdate: {
            productVariants: VariantResult[] | null;
            userErrors: { message: string }[];
          };
        };
      };

      const updateErrors = updateResponse.data?.productVariantsBulkUpdate?.userErrors;
      if (updateErrors && updateErrors.length > 0) {
        logger.warn(`Auto-variant update errors: ${updateErrors.map((e) => e.message).join(', ')}`);
      } else {
        logger.info('Updated auto-generated variant with correct price/sku/metafields');
        // Add to results with original variant ID
        allCreated.push({
          id: autoVariant.id,
          sku: matchingVariant.inventoryItem.sku,
          selectedOptions: autoVariant.selectedOptions,
        });
      }
    }
  }

  return allCreated;
}

/**
 * Delete the default "Default Title" variant created by productSet.
 * Shopify creates this when a product has no options/variants.
 */
export async function deleteDefaultVariant(
  client: ShopifyClient,
  productGid: string,
  defaultVariantId: string,
): Promise<void> {
  const response = (await client.request(PRODUCT_VARIANTS_BULK_DELETE, {
    variables: { productId: productGid, variantsIds: [defaultVariantId] },
  })) as {
    data: {
      productVariantsBulkDelete: {
        userErrors: { message: string }[];
      };
    };
  };

  const { userErrors } = response.data.productVariantsBulkDelete;
  if (userErrors.length > 0) {
    logger.warn(`Could not delete default variant: ${userErrors.map((e) => e.message).join(', ')}`);
  }
}

/**
 * Check if a product already exists by handle and has linked Color option.
 * Returns product info if exists, null otherwise.
 */
export async function checkExistingProduct(
  client: ShopifyClient,
  handle: string,
): Promise<{
  id: string;
  hasLinkedColor: boolean;
  defaultVariantId: string | null;
} | null> {
  const response = (await client.request(PRODUCT_BY_HANDLE, {
    variables: { handle },
  })) as {
    data: {
      productByIdentifier: {
        id: string;
        options: {
          id: string;
          name: string;
          linkedMetafield: { namespace: string; key: string } | null;
        }[];
        variants: { edges: { node: { id: string; title: string } }[] };
      } | null;
    };
  };

  const product = response.data.productByIdentifier;
  if (!product) return null;

  const colorOption = product.options.find((o) => o.name === 'Color');
  const hasLinkedColor = colorOption?.linkedMetafield != null;
  const firstVariant = product.variants.edges[0]?.node;
  const defaultVariantId = firstVariant?.title === 'Default Title' ? firstVariant.id : null;

  return { id: product.id, hasLinkedColor, defaultVariantId };
}
