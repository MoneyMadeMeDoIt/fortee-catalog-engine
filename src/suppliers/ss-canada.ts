import 'dotenv/config';
import { logger } from '../lib/logger.js';
import {
  createOneSourceClient,
  parseProductFromXml,
  parseMediaContentFromXml,
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

export function mapOneSourceProductToSupplierProduct(
  parsed: ReturnType<typeof parseProductFromXml>,
  mediaImages: ProductImage[]
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

  return {
    styleNumber: parsed.productId,
    supplier: 'ss-canada',
    title: parsed.productName,
    description: parsed.description,
    category,
    fabricComposition,
    sizeChartUrl: null,
    sizeChartData: sizeChartData.length > 0 ? sizeChartData : null,
    images,
    variants,
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

    // Fetch media content for images
    let mediaImages: ProductImage[] = [];
    try {
      const media$ = await this.client.getMediaContent(productId, MEDIA_SERVICE_VERSION);
      const mediaItems = parseMediaContentFromXml(media$);
      mediaImages = mediaItems
        .filter((m) => m.mediaType === 'Image' || m.url.match(/\.(jpg|jpeg|png|gif|webp)/i))
        .map((m) => ({
          url: m.url,
          alt: m.color
            ? `${parsed.productName} - ${m.color}`
            : parsed.productName,
        }));
    } catch (error) {
      logger.warn(`S&S Canada: Could not fetch media for ${productId}: ${error}`);
    }

    return mapOneSourceProductToSupplierProduct(parsed, mediaImages);
  }
}
