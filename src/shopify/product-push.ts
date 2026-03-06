import { createLogger, transports, format } from 'winston';
import { google } from 'googleapis';
import { buildHandle, buildVariants, buildFiles } from './variants.js';
import { getTemplateSuffix } from './template-map.js';
import { createShopifyClient } from './client.js';
import { PRODUCT_SET } from './mutations.js';
import { upsertPrintAreas, linkPrintAreasToProduct } from './metaobjects.js';
import { resolveCategory, getDecorationRulesForCategory } from '../decoration/index.js';
import { readAllRows } from '../sheets/reader.js';
import type { SheetRow } from '../sheets/types.js';
import type { ProductSetInput, FileSetInput } from './types.js';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.simple()),
  transports: [new transports.Console()],
});

/**
 * Build a complete ProductSetInput from a group of sheet rows sharing the same styleID.
 * Uses first row for product-level fields; aggregates options and images from all rows.
 *
 * When isUpdate=true, files are omitted to avoid Shopify deleting existing images on re-push.
 */
export function buildProductSetInput(
  rows: SheetRow[],
  isUpdate: boolean,
): { input: ProductSetInput & { files?: FileSetInput[] }; identifier: { handle: string } } {
  const first = rows[0];
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
  const variants = buildVariants(rows);
  const files = isUpdate ? undefined : buildFiles(rows);

  const input: ProductSetInput & { files?: FileSetInput[] } = {
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
    ],
    variants,
    files: files ?? [],
  };

  if (templateSuffix) {
    input.templateSuffix = templateSuffix;
  }

  // Omit files entirely on update to avoid Shopify deleting existing images
  if (isUpdate) {
    delete input.files;
  }

  return { input, identifier: { handle } };
}

/**
 * Push a single product (by styleID) from the enriched Google Sheet to Shopify.
 *
 * Orchestrates: sheet read -> productSet mutation -> metaobject upsert -> metafield link.
 * Uses handle-based upsert so re-running updates instead of duplicating.
 */
export async function pushProduct(
  styleID: string,
): Promise<{ productGid: string; variantCount: number; metaobjectCount: number }> {
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

  // 3. Build productSet input (handle-based upsert makes this idempotent)
  const { input } = buildProductSetInput(rows, false);

  // 4. Call productSet mutation
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

  // 5. Handle decoration metaobjects
  let metaobjectCount = 0;
  const category = resolveCategory(rows[0].baseCategory);

  if (category) {
    const placements = getDecorationRulesForCategory(category);
    if (placements.length > 0) {
      logger.info(`Creating ${placements.length} Print Area metaobjects for category "${category}"...`);
      const metaobjectGids = await upsertPrintAreas(client, category, placements);
      metaobjectCount = metaobjectGids.length;

      if (metaobjectGids.length > 0) {
        logger.info(`Linking ${metaobjectGids.length} Print Areas to product...`);
        await linkPrintAreasToProduct(client, productGid, metaobjectGids);
      }
    }
  } else {
    logger.warn(`No decoration category found for "${rows[0].baseCategory}" -- skipping metaobjects`);
  }

  logger.info(`Product push complete: ${productGid}, ${variantCount} variants, ${metaobjectCount} print areas`);
  return { productGid, variantCount, metaobjectCount };
}
