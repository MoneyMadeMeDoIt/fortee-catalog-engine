import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFabricComposition,
  parseSizeChartUrl,
  parseBodyHtml,
  mapCSWProduct,
} from '../../src/suppliers/canada-sportswear.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load fixtures
const sampleBodyHtml = readFileSync(
  join(__dirname, 'fixtures/csw-body-html-sample.html'),
  'utf-8'
);
const sampleProducts = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/csw-products-sample.json'),
    'utf-8'
  )
);

describe('parseFabricComposition', () => {
  it('extracts fabric composition from body_html with gsm and percentages', () => {
    const result = parseFabricComposition(sampleBodyHtml);
    expect(result).toContain('280 gsm');
    expect(result).toContain('70% cotton');
    expect(result).toContain('30% polyester');
  });

  it('returns empty string when body_html is empty', () => {
    const result = parseFabricComposition('');
    expect(result).toBe('');
  });

  it('returns empty string when body_html has no fabric info', () => {
    const result = parseFabricComposition(
      '<p>Just a description with no fabric details.</p>'
    );
    expect(result).toBe('');
  });
});

describe('parseSizeChartUrl', () => {
  it('extracts PDF URL from body_html', () => {
    const result = parseSizeChartUrl(sampleBodyHtml);
    expect(result).toBe(
      'https://canadasportswear.com/cdn/size-charts/L00450-size-chart.pdf'
    );
  });

  it('returns null when body_html has no PDF links', () => {
    const result = parseSizeChartUrl(
      '<p>No links here at all.</p>'
    );
    expect(result).toBeNull();
  });

  it('returns null when body_html has non-PDF links', () => {
    const result = parseSizeChartUrl(
      '<p><a href="https://example.com/page">Link</a></p>'
    );
    expect(result).toBeNull();
  });
});

describe('parseBodyHtml', () => {
  it('returns both fabricComposition and sizeChartUrl', () => {
    const result = parseBodyHtml(sampleBodyHtml);
    expect(result.fabricComposition).toContain('280 gsm');
    expect(result.sizeChartUrl).toBe(
      'https://canadasportswear.com/cdn/size-charts/L00450-size-chart.pdf'
    );
  });
});

describe('mapCSWProduct', () => {
  const rawProduct = sampleProducts[0];

  it('maps styleNumber from handle', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.styleNumber).toBe(rawProduct.handle);
  });

  it('sets supplier to canada-sportswear', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.supplier).toBe('canada-sportswear');
  });

  it('maps title from raw title', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.title).toBe(rawProduct.title);
  });

  it('maps category from product_type', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.category).toBe('Hooded Sweatshirts');
  });

  it('parses fabric composition from body_html', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.fabricComposition).toContain('280 gsm');
    expect(product.fabricComposition).toContain('70% cotton');
  });

  it('extracts size chart URL from body_html', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.sizeChartUrl).toBe(
      'https://canadasportswear.com/cdn/size-charts/L00450-size-chart.pdf'
    );
  });

  it('maps images from images[].src with alt from title', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.images).toHaveLength(2);
    expect(product.images[0]).toEqual({
      url: 'https://canadasportswear.com/cdn/images/L00450-black-front.jpg',
      alt: rawProduct.title,
    });
  });

  it('maps variants with color from option1 and size from option2', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.variants).toHaveLength(3);
    expect(product.variants[0]).toEqual({
      color: 'Black',
      size: 'S',
      sku: 'L00450-BLK-S',
      price: 32.5,
    });
    expect(product.variants[2]).toEqual({
      color: 'Heather Grey',
      size: 'S',
      sku: 'L00450-HGY-S',
      price: 32.5,
    });
  });

  it('stores rawData as the original raw product', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.rawData).toBe(rawProduct);
  });

  it('sets sizeChartData to null', () => {
    const product = mapCSWProduct(rawProduct);
    expect(product.sizeChartData).toBeNull();
  });
});
