import 'dotenv/config';
import { logger } from '../lib/logger.js';
import {
  createOneSourceClient,
  parseProductFromXml,
  parseMediaContentFromXml,
  type OneSourceConfig,
} from '../lib/onesource-client.js';
import type {
  SupplierProduct,
  SupplierAdapter,
  ProductImage,
  SupplierVariant,
} from './types.js';

const PRODUCT_SERVICE_VERSION = '2.0.0';
const MEDIA_SERVICE_VERSION = '1.1.0';

export function mapOneSourceProductToSupplierProduct(
  parsed: ReturnType<typeof parseProductFromXml>,
  mediaImages: ProductImage[]
): SupplierProduct {
  const category = parsed.categories.length > 0
    ? parsed.categories.map((c) => [c.category, c.subCategory].filter(Boolean).join(' > ')).join(', ')
    : '';

  // Extract fabric from primaryMaterial across parts, or from description/marketing points
  let fabricComposition = '';
  for (const part of parsed.parts) {
    if (part.primaryMaterial) {
      fabricComposition = part.primaryMaterial;
      break;
    }
  }
  if (!fabricComposition) {
    // Try marketing points for fabric info
    for (const mp of parsed.marketingPoints) {
      if (/\d+%/.test(mp.pointCopy)) {
        fabricComposition = mp.pointCopy;
        break;
      }
    }
  }
  if (!fabricComposition) {
    // Try description for fabric patterns
    const fabricMatch = parsed.description.match(
      /(\d+%\s*[\w\s/]+(?:,\s*\d+%\s*[\w\s/]+)*)/
    );
    if (fabricMatch) {
      fabricComposition = fabricMatch[1].trim();
    }
  }

  // Build variants from ProductParts (each part = one color+size combo)
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

  // Images: prefer primaryImageUrl (available in 2.0.0), then media content
  const images: ProductImage[] = [];
  const seenUrls = new Set<string>();

  if (parsed.primaryImageUrl) {
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
    supplier: 'canada-sportswear',
    title: parsed.productName,
    description: parsed.description,
    category,
    fabricComposition,
    sizeChartUrl: null,
    sizeChartData: null,
    images,
    variants,
    isCloseout: parsed.isCloseout,
    rawData: parsed,
  };
}

export class CanadaSportswearAdapter implements SupplierAdapter {
  readonly supplier = 'canada-sportswear' as const;
  private client: ReturnType<typeof createOneSourceClient>;

  constructor(config?: Partial<OneSourceConfig>) {
    this.client = createOneSourceClient({
      keyId: config?.keyId ?? process.env.ONESOURCE_KEY_ID ?? '',
      keyPassword: config?.keyPassword ?? process.env.ONESOURCE_KEY_PASSWORD ?? '',
      supplierCode: config?.supplierCode ?? process.env.CSW_SUPPLIER_CODE ?? 'CANADASPORTSWEAR',
    });
  }

  async fetchProducts(): Promise<SupplierProduct[]> {
    logger.info('Canada Sportswear: Fetching product list via OneSource...');

    // Get all product IDs (use epoch start to get everything)
    const productIds = await this.client.getProductDateModified(
      PRODUCT_SERVICE_VERSION,
      '2000-01-01T00:00:00'
    );

    logger.info(`Canada Sportswear: Found ${productIds.length} products. Fetching details...`);

    const products: SupplierProduct[] = [];

    for (const productId of productIds) {
      try {
        const product = await this.fetchProduct(productId);
        products.push(product);
      } catch (error) {
        logger.error(
          `Canada Sportswear: Failed to fetch product ${productId}: ${error}`
        );
      }
    }

    logger.info(
      `Canada Sportswear: Extracted ${products.length}/${productIds.length} products.`
    );
    return products;
  }

  async fetchProduct(productId: string): Promise<SupplierProduct> {
    logger.info(`Canada Sportswear: Fetching product ${productId}...`);

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
      logger.warn(`Canada Sportswear: Could not fetch media for ${productId}: ${error}`);
    }

    return mapOneSourceProductToSupplierProduct(parsed, mediaImages);
  }
}
