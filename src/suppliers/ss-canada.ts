import 'dotenv/config';
import * as cheerio from 'cheerio';
import { logger } from '../lib/logger.js';
import {
  createOneSourceClient,
  parseProductFromXml,
  parseMediaContentFromXml,
  extractBool,
  type OneSourceConfig,
} from '../lib/onesource-client.js';
import type {
  SupplierAdapter,
  SupplierProduct,
  SupplierVariant,
  ProductImage,
  SizeSpec,
} from './types.js';

const PRODUCT_SERVICE_VERSION = '1.0.0';
const MEDIA_SERVICE_VERSION = '1.1.0';

/**
 * Scrape size chart data from S&S Activewear spec sheet page.
 * URL: https://en-ca.ssactivewear.com/ShopNow/ItemSpecSheet.aspx?ID={styleID}
 * Parses the specTable HTML table into SizeSpec entries.
 */
export async function fetchSizeChartFromWeb(styleId: string): Promise<SizeSpec[]> {
  const url = `https://en-ca.ssactivewear.com/ShopNow/ItemSpecSheet.aspx?ID=${encodeURIComponent(styleId)}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductEnrichBot/1.0)' },
    });
    if (!response.ok) {
      logger.warn(`Size chart fetch failed for styleId ${styleId}: HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();
    return parseSizeChartHtml(html);
  } catch (error) {
    logger.warn(`Size chart fetch error for styleId ${styleId}: ${error}`);
    return [];
  }
}

export function parseSizeChartHtml(html: string): SizeSpec[] {
  const $ = cheerio.load(html);
  const specs: SizeSpec[] = [];

  // Find the spec table (class="specTable" or id containing "spec")
  const table = $('table.specTable, table[id*="spec"], table[id*="Spec"]').first();
  if (!table.length) return specs;

  // First row is headers (measurement names), first column is size names
  const headerCells = table.find('tr').first().find('th, td');
  const headers: string[] = [];
  headerCells.each((i, el) => {
    headers.push($(el).text().trim());
  });

  // Remaining rows: first cell is size, rest are measurements
  table.find('tr').slice(1).each((_, row) => {
    const cells = $(row).find('th, td');
    const sizeName = cells.first().text().trim();
    if (!sizeName) return;

    cells.slice(1).each((colIdx, cell) => {
      const value = $(cell).text().trim();
      const specName = headers[colIdx + 1] || `spec${colIdx}`;
      if (value) {
        specs.push({ sizeName, specName, value });
      }
    });
  });

  return specs;
}

export function mapOneSourceProductToSupplierProduct(
  parsed: ReturnType<typeof parseProductFromXml>,
  mediaImages: ProductImage[],
  options?: { isCloseout?: boolean; webSizeChart?: SizeSpec[] },
): SupplierProduct {
  const category = parsed.categories.length > 0
    ? parsed.categories.map((c) => [c.category, c.subCategory].filter(Boolean).join(' > ')).join(', ')
    : '';

  // Extract fabric from primaryMaterial across parts, or from description
  let fabricComposition = '';
  for (const part of parsed.parts) {
    if (part.primaryMaterial) {
      fabricComposition = part.primaryMaterial;
      break;
    }
  }
  if (!fabricComposition) {
    for (const mp of parsed.marketingPoints) {
      if (/\d+%/.test(mp.pointCopy)) {
        fabricComposition = mp.pointCopy;
        break;
      }
    }
  }
  if (!fabricComposition) {
    const fabricMatch = parsed.description.match(
      /(\d+%\s*[\w\s/]+(?:,\s*\d+%\s*[\w\s/]+)*)/
    );
    if (fabricMatch) {
      fabricComposition = fabricMatch[1].trim();
    }
  }

  // Build variants from ProductParts
  const variants: SupplierVariant[] = parsed.parts.map((part) => {
    const colorName = part.colors.length > 0 ? part.colors[0].colorName : '';
    const size = part.apparelSize
      ? part.apparelSize.customSize || part.apparelSize.labelSize
      : '';

    return {
      color: colorName,
      size,
      sku: part.partId,
    };
  });

  // Build size chart data from specifications across parts
  const sizeChartData: SizeSpec[] = [];
  const seenSpecs = new Set<string>();
  for (const part of parsed.parts) {
    const size = part.apparelSize
      ? part.apparelSize.customSize || part.apparelSize.labelSize
      : part.partId;
    for (const spec of part.specifications) {
      const key = `${size}:${spec.specificationType}`;
      if (!seenSpecs.has(key)) {
        seenSpecs.add(key);
        sizeChartData.push({
          sizeName: size,
          specName: spec.specificationType,
          value: `${spec.value} ${spec.uom}`.trim(),
        });
      }
    }
  }

  // Images from media content (v1.0.0 has no primaryImageUrl)
  const images: ProductImage[] = [];
  const seenUrls = new Set<string>();

  // Still check primaryImageUrl in case it exists
  if (parsed.primaryImageUrl && !seenUrls.has(parsed.primaryImageUrl)) {
    images.push({ url: parsed.primaryImageUrl, alt: parsed.productName });
    seenUrls.add(parsed.primaryImageUrl);
  }

  for (const img of mediaImages) {
    if (!seenUrls.has(img.url)) {
      images.push(img);
      seenUrls.add(img.url);
    }
  }

  // Merge web-scraped size chart if API had no spec data
  const webSpecs = options?.webSizeChart ?? [];
  const finalSizeChart = sizeChartData.length > 0 ? sizeChartData : webSpecs.length > 0 ? webSpecs : null;

  return {
    styleNumber: parsed.productId,
    supplier: 'ss-canada',
    title: parsed.productName,
    description: parsed.description,
    category,
    fabricComposition,
    sizeChartUrl: null,
    sizeChartData: finalSizeChart,
    images,
    variants,
    isCloseout: options?.isCloseout ?? false,
    rawData: parsed,
  };
}

export class SSCanadaAdapter implements SupplierAdapter {
  readonly supplier = 'ss-canada' as const;
  private client: ReturnType<typeof createOneSourceClient>;

  constructor(config?: Partial<OneSourceConfig>) {
    this.client = createOneSourceClient({
      keyId: config?.keyId ?? process.env.ONESOURCE_KEY_ID ?? '',
      keyPassword: config?.keyPassword ?? process.env.ONESOURCE_KEY_PASSWORD ?? '',
      supplierCode: config?.supplierCode ?? process.env.SS_SUPPLIER_CODE ?? 'SSCANADA',
    });
  }

  async fetchProducts(): Promise<SupplierProduct[]> {
    logger.info('S&S Canada: Fetching product list via OneSource...');

    const productIds = await this.client.getProductDateModified(
      PRODUCT_SERVICE_VERSION,
      '2000-01-01T00:00:00'
    );

    logger.info(`S&S Canada: Found ${productIds.length} products. Fetching details...`);

    const products: SupplierProduct[] = [];

    for (const productId of productIds) {
      try {
        const product = await this.fetchProduct(productId);
        products.push(product);
      } catch (error) {
        logger.error(
          `S&S Canada: Failed to fetch product ${productId}: ${error}`
        );
      }
    }

    logger.info(
      `S&S Canada: Extracted ${products.length}/${productIds.length} products.`
    );
    return products;
  }

  async fetchProduct(productId: string): Promise<SupplierProduct> {
    logger.info(`S&S Canada: Fetching product ${productId}...`);

    const $ = await this.client.getProduct(PRODUCT_SERVICE_VERSION, productId);
    const parsed = parseProductFromXml($);

    // Fetch media content and web size chart in parallel
    const [mediaImages, webSizeChart] = await Promise.all([
      (async (): Promise<ProductImage[]> => {
        try {
          const media$ = await this.client.getMediaContent(productId, MEDIA_SERVICE_VERSION);
          const mediaItems = parseMediaContentFromXml(media$);
          return mediaItems
            .filter((m) => m.mediaType === 'Image' || m.url.match(/\.(jpg|jpeg|png|gif|webp)/i))
            .map((m) => ({
              url: m.url,
              alt: m.color
                ? `${parsed.productName} - ${m.color}`
                : parsed.productName,
            }));
        } catch (error) {
          logger.warn(`S&S Canada: Could not fetch media for ${productId}: ${error}`);
          return [];
        }
      })(),
      fetchSizeChartFromWeb(productId),
    ]);

    return mapOneSourceProductToSupplierProduct(parsed, mediaImages, {
      isCloseout: parsed.isCloseout,
      webSizeChart,
    });
  }
}
