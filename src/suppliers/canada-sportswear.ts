import * as cheerio from 'cheerio';
import { logger } from '../lib/logger.js';
import type { SupplierProduct, SupplierAdapter, ProductImage, SupplierVariant } from './types.js';

// --- Raw Shopify types ---

export interface CSWRawVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  sku: string;
  price: string;
  available: boolean;
}

export interface CSWRawImage {
  id: number;
  src: string;
  width: number;
  height: number;
  variant_ids: number[];
}

export interface CSWRawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: CSWRawVariant[];
  images: CSWRawImage[];
  options: Array<{ name: string; values: string[] }>;
}

// --- Body HTML Parsers ---

export function parseFabricComposition(bodyHtml: string): string {
  if (!bodyHtml) return '';

  const $ = cheerio.load(bodyHtml);
  const text = $.text();

  // Pattern: "XXX gsm ... XX% material, XX% material ..."
  const match = text.match(
    /(\d+\s*gsm[\s\S]{0,200}?(?:\d+%\s*[\w\s/]+[,.]?\s*)+)/i
  );

  if (!match) return '';

  return match[1].trim();
}

export function parseSizeChartUrl(bodyHtml: string): string | null {
  if (!bodyHtml) return null;

  const $ = cheerio.load(bodyHtml);

  const pdfLink = $('a[href$=".pdf"]')
    .filter((_, el) => {
      const href = $(el).attr('href') || '';
      return /size|spec/i.test(href);
    })
    .first()
    .attr('href');

  return pdfLink || null;
}

export function parseBodyHtml(bodyHtml: string): {
  fabricComposition: string;
  sizeChartUrl: string | null;
} {
  return {
    fabricComposition: parseFabricComposition(bodyHtml),
    sizeChartUrl: parseSizeChartUrl(bodyHtml),
  };
}

// --- Product Mapping ---

export function mapCSWProduct(raw: CSWRawProduct): SupplierProduct {
  const { fabricComposition, sizeChartUrl } = parseBodyHtml(raw.body_html || '');

  const $ = cheerio.load(raw.body_html || '');
  const description = $.text().trim();

  const images: ProductImage[] = raw.images.map((img) => ({
    url: img.src,
    alt: raw.title,
  }));

  const variants: SupplierVariant[] = raw.variants.map((v) => ({
    color: v.option1 || '',
    size: v.option2 || '',
    sku: v.sku,
    price: parseFloat(v.price),
  }));

  return {
    styleNumber: raw.handle,
    supplier: 'canada-sportswear',
    title: raw.title,
    description,
    category: raw.product_type,
    fabricComposition,
    sizeChartUrl,
    sizeChartData: null,
    images,
    variants,
    rawData: raw,
  };
}

// --- Paginated Fetch ---

const CSW_BASE_URL = 'https://canadasportswear.com/collections/all/products.json';

export async function fetchCSWProducts(): Promise<SupplierProduct[]> {
  const allProducts: SupplierProduct[] = [];
  let page = 1;

  while (true) {
    const url = `${CSW_BASE_URL}?limit=250&page=${page}`;
    logger.info(`Fetching CSW page ${page}: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`CSW fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { products: CSWRawProduct[] };

    if (!data.products || data.products.length === 0) {
      logger.info(`CSW pagination complete. Total pages: ${page - 1}`);
      break;
    }

    const mapped = data.products.map(mapCSWProduct);
    allProducts.push(...mapped);

    logger.info(`CSW page ${page}: ${data.products.length} products (total: ${allProducts.length})`);
    page++;
  }

  return allProducts;
}

// --- Adapter Class ---

export class CanadaSportswearAdapter implements SupplierAdapter {
  readonly supplier = 'canada-sportswear' as const;

  async fetchProducts(): Promise<SupplierProduct[]> {
    return fetchCSWProducts();
  }

  async fetchProduct(handle: string): Promise<SupplierProduct> {
    const url = `https://canadasportswear.com/products/${handle}.json`;
    logger.info(`Fetching single CSW product: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`CSW product fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { product: CSWRawProduct };
    return mapCSWProduct(data.product);
  }
}
