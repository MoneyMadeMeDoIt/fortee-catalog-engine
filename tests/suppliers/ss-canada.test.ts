import { describe, it, expect } from 'vitest';
import ssStyleSample from './fixtures/ss-style-sample.json';
import ssProductsSample from './fixtures/ss-products-sample.json';
import ssSpecsSample from './fixtures/ss-specs-sample.json';
import {
  parseFabricFromDescription,
  extractSSProduct,
  createSSClient,
  mergeSSData,
} from '../../src/suppliers/ss-canada.js';
import type { SupplierProduct } from '../../src/suppliers/types.js';

describe('parseFabricFromDescription', () => {
  it('extracts fabric composition from HTML with percentage pattern', () => {
    const html = '<p>Classic fit. <b>5.3 oz., 100% cotton</b>. Double-needle collar.</p>';
    expect(parseFabricFromDescription(html)).toBe('100% cotton');
  });

  it('extracts multi-material fabric composition', () => {
    const html = '<p>Made from <b>60% cotton, 40% polyester</b>. Soft hand feel.</p>';
    expect(parseFabricFromDescription(html)).toBe('60% cotton, 40% polyester');
  });

  it('returns empty string for empty input', () => {
    expect(parseFabricFromDescription('')).toBe('');
  });

  it('returns empty string when no percentage patterns found', () => {
    const html = '<p>A great shirt with no fabric info mentioned.</p>';
    expect(parseFabricFromDescription(html)).toBe('');
  });

  it('strips HTML tags before parsing', () => {
    const html = '<div><span>50% cotton</span>, <em>50% polyester</em></div>';
    expect(parseFabricFromDescription(html)).toBe('50% cotton, 50% polyester');
  });

  it('extracts from fixture style description', () => {
    const result = parseFabricFromDescription(ssStyleSample[0].description);
    expect(result).toBe('100% cotton');
  });
});

describe('mergeSSData', () => {
  it('merges style + products + specs into SupplierProduct', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);

    expect(result.styleNumber).toBe('G500');
    expect(result.supplier).toBe('ss-canada');
    expect(result.title).toBe('Heavy Cotton T-Shirt');
    expect(result.category).toBe('T-Shirts');
    expect(result.fabricComposition).toBe('100% cotton');
  });

  it('builds correct number of variants from products', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);
    expect(result.variants).toHaveLength(ssProductsSample.length);
  });

  it('maps variant fields correctly', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);
    const firstVariant = result.variants[0];

    expect(firstVariant.color).toBe('Black');
    expect(firstVariant.size).toBe('S');
    expect(firstVariant.sku).toBe('G500-BLK-S');
    // customerPrice is preferred over piecePrice
    expect(firstVariant.price).toBe(2.45);
    expect(firstVariant.colorSwatchImage).toBe(
      'https://www.ssactivewear.com/Images/Color/G500-Black-swatch.jpg'
    );
    expect(firstVariant.colorFrontImage).toBe(
      'https://www.ssactivewear.com/Images/Color/G500-Black-front.jpg'
    );
  });

  it('builds sizeChartData from specs', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);
    expect(result.sizeChartData).toHaveLength(ssSpecsSample.length);
    expect(result.sizeChartData![0]).toEqual({
      sizeName: 'S',
      specName: 'Body Width',
      value: '18',
    });
  });

  it('deduplicates images from products and style', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);
    // 2 unique colorFrontImage (Black, White) + 1 styleImage = 3
    expect(result.images).toHaveLength(3);

    const urls = result.images.map((img) => img.url);
    // No duplicates
    expect(new Set(urls).size).toBe(urls.length);
    // styleImage included
    expect(urls).toContain('https://www.ssactivewear.com/Images/Style/G500-front.jpg');
  });

  it('stores raw data', () => {
    const result = mergeSSData(ssStyleSample[0], ssProductsSample, ssSpecsSample);
    expect(result.rawData).toBeDefined();
  });
});

describe('createSSClient', () => {
  it('throws error when account number is empty', () => {
    expect(() => createSSClient('', 'some-key')).toThrow(/credentials/i);
  });

  it('throws error when API key is empty', () => {
    expect(() => createSSClient('12345', '')).toThrow(/credentials/i);
  });

  it('throws error when both are empty', () => {
    expect(() => createSSClient('', '')).toThrow(/credentials/i);
  });

  it('returns client object with valid credentials', () => {
    const client = createSSClient('12345', 'test-key');
    expect(client).toBeDefined();
    expect(typeof client.getStyles).toBe('function');
    expect(typeof client.getStyle).toBe('function');
    expect(typeof client.getProducts).toBe('function');
    expect(typeof client.getSpecs).toBe('function');
  });
});
