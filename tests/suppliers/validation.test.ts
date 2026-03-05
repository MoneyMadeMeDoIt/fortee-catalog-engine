import { describe, it, expect } from 'vitest';
import { validateProduct, type SupplierProduct } from '../../src/suppliers/types.js';

function makeValidCSWProduct(): SupplierProduct {
  return {
    styleNumber: 'L00450',
    supplier: 'canada-sportswear',
    title: 'L00450 - Weekender Vintage Wash Pullover Hooded Sweatshirt',
    description: 'Relaxed fit. Attached hood with flat drawcord. Rib knit cuffs and hem.',
    category: 'Hooded Sweatshirts',
    fabricComposition: '70% cotton, 30% polyester vintage wash fleece',
    sizeChartUrl: 'https://canadasportswear.com/cdn/size-charts/L00450-size-chart.pdf',
    sizeChartData: null,
    images: [
      { url: 'https://canadasportswear.com/cdn/images/L00450-black-front.jpg', alt: 'Black front' },
    ],
    variants: [
      { color: 'Black', size: 'S', sku: 'L00450-BLK-S' },
      { color: 'Black', size: 'M', sku: 'L00450-BLK-M' },
    ],
    rawData: {},
  };
}

function makeValidSSProduct(): SupplierProduct {
  return {
    styleNumber: 'G500',
    supplier: 'ss-canada',
    title: 'Heavy Cotton T-Shirt',
    description: 'Classic fit, preshrunk jersey knit. Seamless double-needle collar.',
    category: 'T-Shirts',
    fabricComposition: '100% cotton',
    sizeChartUrl: null,
    sizeChartData: [
      { sizeName: 'S', specName: 'Body Width', value: '18' },
      { sizeName: 'M', specName: 'Body Width', value: '20' },
    ],
    images: [
      { url: 'https://www.ssactivewear.com/Images/Style/G500-front.jpg' },
    ],
    variants: [
      { color: 'Black', size: 'S', sku: 'G500-BLK-S', price: 2.45 },
      { color: 'White', size: 'M', sku: 'G500-WHT-M', price: 2.45 },
    ],
    rawData: {},
  };
}

describe('validateProduct', () => {
  it('accepts a valid Canada Sportswear product', () => {
    const result = validateProduct(makeValidCSWProduct());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.supplier).toBe('canada-sportswear');
      expect(result.data.sizeChartUrl).toBeTruthy();
      expect(result.data.sizeChartData).toBeNull();
    }
  });

  it('accepts a valid S&S product', () => {
    const result = validateProduct(makeValidSSProduct());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.supplier).toBe('ss-canada');
      expect(result.data.sizeChartData).toHaveLength(2);
      expect(result.data.sizeChartUrl).toBeNull();
    }
  });

  it('rejects product with missing title', () => {
    const product = makeValidCSWProduct();
    // @ts-expect-error intentionally removing required field
    delete product.title;
    const result = validateProduct(product);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e: string) => e.includes('title'))).toBe(true);
    }
  });

  it('rejects product with empty images array', () => {
    const product = makeValidCSWProduct();
    product.images = [];
    const result = validateProduct(product);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e: string) => e.includes('images'))).toBe(true);
    }
  });

  it('rejects product with empty variants array', () => {
    const product = makeValidCSWProduct();
    product.variants = [];
    const result = validateProduct(product);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e: string) => e.includes('variants'))).toBe(true);
    }
  });

  it('rejects product with missing fabricComposition', () => {
    const product = makeValidCSWProduct();
    // @ts-expect-error intentionally removing required field
    delete product.fabricComposition;
    const result = validateProduct(product);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e: string) => e.includes('fabricComposition'))).toBe(true);
    }
  });

  it('returns multiple errors when multiple fields are missing', () => {
    const result = validateProduct({
      styleNumber: '',
      supplier: 'canada-sportswear',
      description: 'short',
      category: 'Test',
      sizeChartUrl: null,
      sizeChartData: null,
      images: [],
      variants: [],
      rawData: {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    }
  });
});
