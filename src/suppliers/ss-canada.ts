import * as cheerio from 'cheerio';
import 'dotenv/config';
import { createRateLimitedQueue } from '../lib/queue.js';
import { logger } from '../lib/logger.js';
import type {
  SupplierAdapter,
  SupplierProduct,
  SupplierVariant,
  ProductImage,
  SizeSpec,
} from './types.js';

// --- S&S API Types ---

export interface SSStyle {
  styleID: number;
  partNumber: string;
  brandName?: string;
  title: string;
  description: string;
  baseCategory: string;
  styleImage: string;
}

export interface SSProduct {
  sku: string;
  styleID: number;
  colorName: string;
  sizeName: string;
  piecePrice: number;
  customerPrice?: number;
  colorSwatchImage?: string;
  colorFrontImage?: string;
}

export interface SSSpec {
  sizeName: string;
  specName: string;
  value: string;
}

// --- Constants ---

const SS_API_BASE = 'https://api.ssactivewear.com/v2';

// --- Fabric Parsing ---

export function parseFabricFromDescription(htmlDescription: string): string {
  if (!htmlDescription) return '';

  const $ = cheerio.load(htmlDescription);
  const text = $.text();

  // Match patterns like "100% cotton" or "60% cotton, 40% polyester"
  // Supports multi-material with comma separation
  const fabricRegex = /(\d+%\s+\w+(?:\s*,\s*\d+%\s+\w+)*)/;
  const match = text.match(fabricRegex);

  return match ? match[1].trim() : '';
}

// --- API Client ---

export interface SSClient {
  getStyles(): Promise<SSStyle[]>;
  getStyle(styleId: number): Promise<SSStyle>;
  getProducts(styleId: number): Promise<SSProduct[]>;
  getSpecs(styleId: number): Promise<SSSpec[]>;
}

export function createSSClient(accountNumber: string, apiKey: string): SSClient {
  if (!accountNumber || !apiKey) {
    throw new Error(
      'S&S Activewear credentials are required. Set SS_ACCOUNT_NUMBER and SS_API_KEY environment variables.'
    );
  }

  const authHeader =
    'Basic ' + Buffer.from(`${accountNumber}:${apiKey}`).toString('base64');
  const queue = createRateLimitedQueue();

  async function apiFetch<T>(path: string): Promise<T> {
    return queue.add(async () => {
      const url = `${SS_API_BASE}${path}`;
      logger.info(`S&S API: GET ${path}`);

      const response = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        throw new Error(`S&S API: Resource not found: ${path}`);
      }

      if (response.status === 429) {
        throw new Error(
          `S&S API: Rate limit exceeded. Retry after ${response.headers.get('Retry-After') ?? 'unknown'} seconds.`
        );
      }

      if (!response.ok) {
        throw new Error(
          `S&S API: Request failed with status ${response.status}: ${path}`
        );
      }

      return (await response.json()) as T;
    }) as Promise<T>;
  }

  return {
    getStyles: () => apiFetch<SSStyle[]>('/styles/'),
    getStyle: (styleId) => apiFetch<SSStyle>(`/styles/${styleId}`),
    getProducts: (styleId) => apiFetch<SSProduct[]>(`/products/?style=${styleId}`),
    getSpecs: (styleId) => apiFetch<SSSpec[]>(`/specs/?style=${styleId}`),
  };
}

// --- Data Merging ---

export function mergeSSData(
  style: SSStyle,
  products: SSProduct[],
  specs: SSSpec[]
): SupplierProduct {
  const fabricComposition = parseFabricFromDescription(style.description);

  // Strip HTML from description for clean text
  const $ = cheerio.load(style.description);
  const cleanDescription = $.text().trim();

  // Build variants from products
  const variants: SupplierVariant[] = products.map((product) => ({
    color: product.colorName,
    size: product.sizeName,
    sku: product.sku,
    price: product.customerPrice ?? product.piecePrice,
    colorSwatchImage: product.colorSwatchImage,
    colorFrontImage: product.colorFrontImage,
  }));

  // Build size chart data from specs
  const sizeChartData: SizeSpec[] = specs.map((spec) => ({
    sizeName: spec.sizeName,
    specName: spec.specName,
    value: spec.value,
  }));

  // Deduplicate images: unique colorFrontImage from products + styleImage
  const imageUrls = new Set<string>();
  const images: ProductImage[] = [];

  for (const product of products) {
    if (product.colorFrontImage && !imageUrls.has(product.colorFrontImage)) {
      imageUrls.add(product.colorFrontImage);
      images.push({
        url: product.colorFrontImage,
        alt: `${style.title} - ${product.colorName}`,
      });
    }
  }

  if (style.styleImage && !imageUrls.has(style.styleImage)) {
    imageUrls.add(style.styleImage);
    images.push({
      url: style.styleImage,
      alt: style.title,
    });
  }

  return {
    styleNumber: style.partNumber,
    supplier: 'ss-canada',
    title: style.title,
    description: cleanDescription,
    category: style.baseCategory,
    fabricComposition,
    sizeChartUrl: null,
    sizeChartData: sizeChartData.length > 0 ? sizeChartData : null,
    images,
    variants,
    rawData: { style, products, specs },
  };
}

// --- Product Extraction ---

export async function extractSSProduct(
  client: SSClient,
  styleId: number
): Promise<SupplierProduct> {
  const [style, products, specs] = await Promise.all([
    client.getStyle(styleId),
    client.getProducts(styleId),
    client.getSpecs(styleId),
  ]);

  return mergeSSData(style, products, specs);
}

// --- Adapter ---

export class SSCanadaAdapter implements SupplierAdapter {
  readonly supplier = 'ss-canada' as const;
  private client: SSClient;

  constructor(accountNumber?: string, apiKey?: string) {
    const account = accountNumber ?? process.env.SS_ACCOUNT_NUMBER ?? '';
    const key = apiKey ?? process.env.SS_API_KEY ?? '';
    this.client = createSSClient(account, key);
  }

  async fetchProducts(): Promise<SupplierProduct[]> {
    logger.info('S&S Canada: Fetching all styles...');
    const styles = await this.client.getStyles();
    logger.info(`S&S Canada: Found ${styles.length} styles. Extracting products...`);

    const products: SupplierProduct[] = [];
    for (const style of styles) {
      try {
        const product = await extractSSProduct(this.client, style.styleID);
        products.push(product);
      } catch (error) {
        logger.error(
          `S&S Canada: Failed to extract style ${style.styleID} (${style.partNumber}): ${error}`
        );
      }
    }

    logger.info(`S&S Canada: Extracted ${products.length}/${styles.length} products.`);
    return products;
  }

  async fetchProduct(identifier: string): Promise<SupplierProduct> {
    const styleId = parseInt(identifier, 10);
    if (isNaN(styleId)) {
      throw new Error(`Invalid style ID: ${identifier}. Must be a numeric styleID.`);
    }
    return extractSSProduct(this.client, styleId);
  }
}
