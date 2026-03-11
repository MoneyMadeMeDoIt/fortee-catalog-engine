import { buildHandle, getCategoryGroup, getTaxonomyCategoryId, SUPPORTED_CATEGORIES } from './variants.js';
import { getTemplateSuffix } from './template-map.js';
import { processProductImages } from './image-standardizer.js';
import { createShopifyClient } from './client.js';
import { PRODUCT_SET, METAFIELDS_SET, PRODUCT_MEDIA } from './mutations.js';
import { getExistingPrintAreaGids, upsertSizeGuideMetaobject, linkSizeGuideToProduct } from './metaobjects.js';
import { readSpecSheetStructured } from '../sheets/spec-sheet.js';
import {
  getOrCreateColorMetaobjects,
  addLinkedColorOption,
  buildLinkedVariants,
  createLinkedVariants,
  checkExistingProduct,
} from './color-swatches.js';
import { createSheetsClient } from '../sheets/client.js';
import { readAllRows } from '../sheets/reader.js';
import { logger } from '../lib/logger.js';
import type { SheetRow } from '../sheets/types.js';
import type { ProductSetInput, FileSetInput } from './types.js';

/**
 * Build a ProductSetInput for product metadata and images only.
 * Does NOT include Color option or variants — those are created separately
 * via productOptionsCreate (linked color swatches) and productVariantsBulkCreate.
 *
 * Returns null for unsupported categories (e.g., Cap, Beanie).
 */
export function buildProductSetInput(
  rows: SheetRow[],
  files: FileSetInput[],
): { input: ProductSetInput; identifier: { handle: string } } | null {
  const first = rows[0];

  const categoryGroup = getCategoryGroup(first.baseCategory);
  if (!categoryGroup) {
    return null;
  }

  const handle = buildHandle(first.productName, first.styleID);
  const tags = [first.brandName, first.baseCategory, first.gender].filter(Boolean);
  const templateSuffix = getTemplateSuffix(first.baseCategory);

  const taxonomyId = getTaxonomyCategoryId(first.baseCategory);

  const input: ProductSetInput = {
    title: first.productName,
    handle,
    descriptionHtml: first.description,
    vendor: first.brandName,
    productType: first.baseCategory,
    category: taxonomyId,
    status: 'ACTIVE',
    tags,
    productOptions: [],
    variants: [],
    files,
  };

  if (templateSuffix) {
    input.templateSuffix = templateSuffix;
  }

  return { input, identifier: { handle } };
}

/**
 * Push a single product (by styleID) from the enriched Google Sheet to Shopify.
 *
 * Flow:
 * 1. productSet — create product shell with metadata + images (no Color, no variants)
 * 2. Color metaobject lookup/creation — find or create shopify--color-pattern metaobjects
 * 3. productOptionsCreate — add Color (linked), Size, # of Print Areas options
 * 4. productVariantsBulkCreate — create all variants with linked Color values
 * 5. metafieldsSet — product-level (print_areas, MOQ) and variant-level (print_area_media)
 *
 * Uses handle-based upsert so re-running updates product metadata/images.
 * On re-run, if linked Color option already exists, skips option/variant creation.
 */
export async function pushProduct(
  styleID: string,
): Promise<{ productGid: string; variantCount: number }> {
  logger.info(`Starting product push for styleID: ${styleID}`);

  // 1. Create Shopify client
  const client = await createShopifyClient();

  // 2. Read sheet rows and filter to matching styleID
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Missing GOOGLE_SPREADSHEET_ID environment variable.');
  }

  const sheets = createSheetsClient();
  const { rows: allRows } = await readAllRows(sheets, spreadsheetId);
  const rows = allRows.filter((r) => r.styleID === styleID);

  if (rows.length === 0) {
    throw new Error(`No rows found for styleID "${styleID}". Check the Google Sheet.`);
  }

  logger.info(`Found ${rows.length} rows for styleID ${styleID}`);

  // 3. Check category support
  const categoryGroup = getCategoryGroup(rows[0].baseCategory);
  if (!categoryGroup) {
    const supported = [...SUPPORTED_CATEGORIES].join(', ');
    throw new Error(
      `Unsupported category "${rows[0].baseCategory}" for styleID "${styleID}". ` +
      `Supported categories: ${supported}`
    );
  }

  // 4. Look up existing metaobject GIDs (front-dtf and back-print)
  const printAreaGids = await getExistingPrintAreaGids(client);

  // 5. Process images via staged uploads
  const imageResult = await processProductImages(
    client,
    {
      front: rows[0].FrontImage || undefined,
      back: rows[0].BackImage || undefined,
      side: rows[0].DirectSideImage || undefined,
    },
    rows[0].productName,
    rows[0].colorName,
    categoryGroup,
  );
  const { files, printAreaCoords } = imageResult;

  // 6. Build productSet input (metadata + images only, no options/variants)
  const result = buildProductSetInput(rows, files);
  if (!result) {
    throw new Error(`buildProductSetInput returned null for category "${rows[0].baseCategory}".`);
  }

  const { input, identifier } = result;

  // 7. Check if product already exists with linked Color
  const existing = await checkExistingProduct(client, identifier.handle);

  // If product exists, include its GID so productSet updates instead of creating
  if (existing) {
    input.id = existing.id;
    // Don't send empty options/variants — would clear existing ones
    delete input.productOptions;
    delete input.variants;
    logger.info(`Product already exists (${existing.id}) — updating metadata only`);
  }

  // 8. Call productSet mutation (creates/updates product shell)
  logger.info('Creating/updating product in Shopify...');
  const response = (await client.request(PRODUCT_SET, {
    variables: { input, synchronous: true },
  })) as {
    data: {
      productSet: {
        product: {
          id: string;
          handle: string;
          variants: {
            edges: {
              node: { id: string; title: string };
            }[];
          };
        } | null;
        userErrors: { field: string[]; message: string; code: string }[];
      };
    };
  };

  const { product, userErrors } = response.data.productSet;

  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => `[${e.field?.join('.')}] ${e.message}`).join('\n');
    throw new Error(`Shopify productSet errors:\n${messages}`);
  }

  if (!product) {
    throw new Error('productSet returned no product and no errors -- unexpected response.');
  }

  const productGid = product.id;
  logger.info(`Product created/updated: ${productGid}`);

  // 9. Get or create color-pattern metaobjects for each unique color
  logger.info('Looking up/creating color pattern metaobjects...');
  const colorMap = await getOrCreateColorMetaobjects(client, rows);

  // Collect unique color GIDs preserving insertion order
  const uniqueColorGids: string[] = [];
  const seenColorGids = new Set<string>();
  for (const row of rows) {
    const info = colorMap.get(row.colorName);
    if (info && !seenColorGids.has(info.gid)) {
      seenColorGids.add(info.gid);
      uniqueColorGids.push(info.gid);
    }
  }

  // 10. Set shopify.color-pattern metafield on the product (requires category to be set)
  logger.info('Setting shopify.color-pattern metafield on product...');
  const colorPatternResponse = (await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: productGid,
          namespace: 'shopify',
          key: 'color-pattern',
          type: 'list.metaobject_reference',
          value: JSON.stringify(uniqueColorGids),
        },
      ],
    },
  })) as {
    data: { metafieldsSet: { userErrors: { message: string }[] } };
  };

  const colorPatternErrors = colorPatternResponse.data.metafieldsSet.userErrors;
  if (colorPatternErrors.length > 0) {
    throw new Error(
      `Failed to set shopify.color-pattern metafield: ${colorPatternErrors.map((e) => e.message).join(', ')}`
    );
  }

  let createdVariants: { id: string; sku: string; selectedOptions: { name: string; value: string }[] }[];

  if (existing?.hasLinkedColor) {
    // Product already has linked Color option — skip option/variant creation
    logger.info('Product already has linked Color option — skipping option/variant creation');
    const mediaQueryResponse = (await client.request(
      `query ($id: ID!) { product(id: $id) { variants(first: 250) { edges { node { id sku selectedOptions { name value } } } } } }`,
      { variables: { id: productGid } },
    )) as { data: { product: { variants: { edges: { node: { id: string; sku: string; selectedOptions: { name: string; value: string }[] } }[] } } } };
    createdVariants = mediaQueryResponse.data.product.variants.edges.map((e) => e.node);
  } else {
    // 11. Add linked Color option + regular Size and # of Print Areas options
    logger.info('Adding linked Color option and Size/# of Print Areas options...');

    const uniqueSizes: string[] = [];
    const seenSizes = new Set<string>();
    for (const row of rows) {
      if (row.sizeName && !seenSizes.has(row.sizeName)) {
        seenSizes.add(row.sizeName);
        uniqueSizes.push(row.sizeName);
      }
    }

    await addLinkedColorOption(client, productGid);

    const addRegularOptionsResponse = (await client.request(
      `mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product { id }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          productId: productGid,
          options: [
            { name: 'Size', position: 2, values: uniqueSizes.map((s) => ({ name: s })) },
            { name: '# of Print Areas', position: 3, values: [{ name: '1' }, { name: '2' }] },
          ],
        },
      },
    )) as { data: { productOptionsCreate: { userErrors: { message: string }[] } } };

    const optionErrors = addRegularOptionsResponse.data.productOptionsCreate.userErrors;
    if (optionErrors.length > 0) {
      throw new Error(`Failed to add Size/# of Print Areas options: ${optionErrors.map((e) => e.message).join(', ')}`);
    }

    // 12. Query auto-generated variant (Shopify creates one when options are added)
    const autoQueryResponse = (await client.request(
      `query ($id: ID!) { product(id: $id) { variants(first: 1) { edges { node { id selectedOptions { name value } } } } } }`,
      { variables: { id: productGid } },
    )) as { data: { product: { variants: { edges: { node: { id: string; selectedOptions: { name: string; value: string }[] } }[] } } } };
    const autoVariant = autoQueryResponse.data.product.variants.edges[0]?.node || null;

    // 13. Create all variants (skipping auto-generated, updating it instead)
    logger.info('Creating variants with linked color swatches...');
    const variantInputs = buildLinkedVariants(rows, colorMap, printAreaCoords);
    createdVariants = await createLinkedVariants(client, productGid, variantInputs, autoVariant);
    logger.info(`Created ${createdVariants.length} variants`);
  }

  // 13. Set product-level metafields (Print Areas + MOQ)
  logger.info('Setting product-level metafields (Print Areas + MOQ)...');
  const metafieldsResponse = (await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: productGid,
          namespace: 'custom',
          key: 'print_areas',
          type: 'list.metaobject_reference',
          value: JSON.stringify(printAreaGids),
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
  })) as {
    data: {
      metafieldsSet: {
        metafields: unknown[] | null;
        userErrors: { message: string }[];
      };
    };
  };

  const metafieldErrors = metafieldsResponse.data.metafieldsSet.userErrors;
  if (metafieldErrors.length > 0) {
    throw new Error(
      `Metafield errors: ${metafieldErrors.map((e) => e.message).join(', ')}`
    );
  }

  // 13b. Upsert size guide metaobject and link to product
  const specSpreadsheetId = process.env.SPEC_SHEET_GOOGLE_SPREADSHEET_ID;
  if (specSpreadsheetId) {
    try {
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
        logger.warn(`No spec data for productId "${rows[0].productId}" -- skipping size guide`);
      }
    } catch (err) {
      logger.warn(`Size guide creation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // 14. Query product media to get image GIDs by alt text
  logger.info('Querying product media for print area image linking...');
  const mediaResponse = (await client.request(PRODUCT_MEDIA, {
    variables: { id: productGid },
  })) as {
    data: {
      product: {
        media: {
          edges: {
            node: { id: string; alt: string | null; image: { url: string } | null };
          }[];
        };
      };
    };
  };

  const mediaByAlt = new Map<string, string>();
  for (const { node } of mediaResponse.data.product.media.edges) {
    if (node.alt) {
      mediaByAlt.set(node.alt, node.id);
    }
  }

  const frontMediaGid = mediaByAlt.get('Front Print');
  const backMediaGid = mediaByAlt.get('Back Print');

  // 15. Set print_area_media metafield on each variant
  if (frontMediaGid || backMediaGid) {
    logger.info('Setting print_area_media metafields on variants...');
    const variantMetafields: { ownerId: string; namespace: string; key: string; type: string; value: string }[] = [];

    for (const variant of createdVariants) {
      const printAreaOption = variant.selectedOptions.find((o) => o.name === '# of Print Areas');
      const areaCount = printAreaOption?.value;

      // Always include both images — product display needs all media regardless of print area count
      const mediaGids: string[] = [];
      if (frontMediaGid) mediaGids.push(frontMediaGid);
      if (backMediaGid) mediaGids.push(backMediaGid);

      if (mediaGids.length > 0) {
        variantMetafields.push({
          ownerId: variant.id,
          namespace: 'custom',
          key: 'print_area_media',
          type: 'list.file_reference',
          value: JSON.stringify(mediaGids),
        });
      }
    }

    if (variantMetafields.length > 0) {
      for (let i = 0; i < variantMetafields.length; i += 25) {
        const batch = variantMetafields.slice(i, i + 25);
        const mediaMetaResponse = (await client.request(METAFIELDS_SET, {
          variables: { metafields: batch },
        })) as {
          data: { metafieldsSet: { userErrors: { message: string }[] } };
        };

        const mediaErrors = mediaMetaResponse.data.metafieldsSet.userErrors;
        if (mediaErrors.length > 0) {
          logger.warn(`print_area_media errors (batch ${i / 25 + 1}): ${mediaErrors.map((e) => e.message).join(', ')}`);
        }
      }
      logger.info(`Set print_area_media on ${variantMetafields.length} variants`);
    }
  } else {
    logger.warn('No media with "Front Print" or "Back Print" alt text found — skipping print_area_media');
  }

  // 16. Log success
  const variantCount = createdVariants.length;
  logger.info(`Product push complete: ${productGid}, ${variantCount} variants`);
  return { productGid, variantCount };
}
