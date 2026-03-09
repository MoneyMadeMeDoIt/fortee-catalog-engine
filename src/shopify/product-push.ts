import { google } from 'googleapis';
import { buildHandle, buildVariants, getCategoryGroup, SUPPORTED_CATEGORIES } from './variants.js';
import { getTemplateSuffix } from './template-map.js';
import { processProductImages } from './image-standardizer.js';
import { createShopifyClient } from './client.js';
import { PRODUCT_SET, METAFIELDS_SET } from './mutations.js';
import { getExistingPrintAreaGids } from './metaobjects.js';
import { readAllRows } from '../sheets/reader.js';
import { logger } from '../lib/logger.js';
import type { SheetRow } from '../sheets/types.js';
import type { ProductSetInput, FileSetInput } from './types.js';

/**
 * Build a complete ProductSetInput from a group of sheet rows sharing the same styleID.
 * Uses first row for product-level fields; aggregates options and images from all rows.
 *
 * Returns null for unsupported categories (e.g., Cap, Beanie).
 * Uses the files parameter directly (from processProductImages or empty array).
 */
export function buildProductSetInput(
  rows: SheetRow[],
  files: FileSetInput[],
): { input: ProductSetInput; identifier: { handle: string } } | null {
  const first = rows[0];

  // Check category support -- return null if unsupported
  const categoryGroup = getCategoryGroup(first.baseCategory);
  if (!categoryGroup) {
    return null;
  }

  const handle = buildHandle(first.productName, first.styleID);

  // Extract unique color and size values preserving insertion order
  const uniqueColors: string[] = [];
  const uniqueSizes: string[] = [];
  const seenColors = new Set<string>();
  const seenSizes = new Set<string>();

  for (const row of rows) {
    if (row.colorName && !seenColors.has(row.colorName)) {
      seenColors.add(row.colorName);
      uniqueColors.push(row.colorName);
    }
    if (row.sizeName && !seenSizes.has(row.sizeName)) {
      seenSizes.add(row.sizeName);
      uniqueSizes.push(row.sizeName);
    }
  }

  const tags = [first.brandName, first.baseCategory, first.gender].filter(Boolean);
  const templateSuffix = getTemplateSuffix(first.baseCategory);
  const variants = buildVariants(rows, categoryGroup);

  const input: ProductSetInput = {
    title: first.productName,
    handle,
    descriptionHtml: first.description,
    vendor: first.brandName,
    productType: first.baseCategory,
    status: 'ACTIVE',
    tags,
    productOptions: [
      {
        name: 'Color',
        position: 1,
        values: uniqueColors.map((name) => ({ name })),
      },
      {
        name: 'Size',
        position: 2,
        values: uniqueSizes.map((name) => ({ name })),
      },
      {
        name: '# of Print Areas',
        position: 3,
        values: [{ name: '1' }, { name: '2' }],
      },
    ],
    variants,
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
 * Orchestrates: category check -> image processing -> productSet -> metafieldsSet.
 * Uses handle-based upsert so re-running updates instead of duplicating.
 */
export async function pushProduct(
  styleID: string,
): Promise<{ productGid: string; variantCount: number }> {
  logger.info(`Starting product push for styleID: ${styleID}`);

  // 1. Create Shopify client
  const client = createShopifyClient();

  // 2. Read sheet rows and filter to matching styleID
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('Missing GOOGLE_SHEET_ID environment variable.');
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
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
  const metaobjectGids = await getExistingPrintAreaGids(client);

  // 5. Process images via staged uploads
  const files = await processProductImages(
    client,
    {
      front: rows[0].FrontImage || undefined,
      back: rows[0].BackImage || undefined,
      side: rows[0].DirectSideImage || undefined,
    },
    rows[0].productName,
    rows[0].colorName,
  );

  // 6. Build productSet input
  const result = buildProductSetInput(rows, files);
  if (!result) {
    throw new Error(`buildProductSetInput returned null for category "${rows[0].baseCategory}".`);
  }

  const { input } = result;

  // 7. Call productSet mutation (handle-based upsert makes this idempotent)
  logger.info('Creating/updating product in Shopify...');
  const response = (await client.request(PRODUCT_SET, {
    variables: { input, synchronous: true },
  })) as {
    data: {
      productSet: {
        product: { id: string; handle: string; variants: { edges: { node: { id: string } }[] } } | null;
        userErrors: { field: string[]; message: string; code: string }[];
      };
    };
  };

  const { product, userErrors } = response.data.productSet;

  // 8. Handle userErrors
  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => `[${e.field?.join('.')}] ${e.message}`).join('\n');
    throw new Error(`Shopify productSet errors:\n${messages}`);
  }

  if (!product) {
    throw new Error('productSet returned no product and no errors -- unexpected response.');
  }

  const productGid = product.id;
  const variantCount = product.variants.edges.length;
  logger.info(`Product created/updated: ${productGid} with ${variantCount} variants`);

  // 9. Set product-level metafields via METAFIELDS_SET
  logger.info('Setting product-level metafields (Print Areas + MOQ)...');
  const metafieldsResponse = (await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: productGid,
          namespace: 'custom',
          key: 'print_areas',
          type: 'list.metaobject_reference',
          value: JSON.stringify(metaobjectGids),
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

  // 10. Log success
  logger.info(`Product push complete: ${productGid}, ${variantCount} variants`);
  return { productGid, variantCount };
}
