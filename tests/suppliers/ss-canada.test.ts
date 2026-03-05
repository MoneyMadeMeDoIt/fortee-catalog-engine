import { describe, it, expect } from 'vitest';
import { mapOneSourceProductToSupplierProduct } from '../../src/suppliers/ss-canada.js';
import type { ProductImage } from '../../src/suppliers/types.js';

function makeParsedProduct() {
  return {
    productId: 'G500',
    productName: 'Heavy Cotton T-Shirt',
    description: 'Classic fit, preshrunk jersey knit. 100% cotton.',
    productBrand: 'Gildan',
    primaryImageUrl: '',
    categories: [
      { category: 'T-Shirts', subCategory: 'Short Sleeve' },
    ],
    parts: [
      {
        partId: 'G500-BLK-S',
        description: 'Black Small',
        primaryMaterial: '100% cotton',
        colors: [{ colorName: 'Black', hex: '#000000' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'S' as const },
        specifications: [
          { specificationType: 'Chest', uom: 'IN', value: '18' },
          { specificationType: 'Length', uom: 'IN', value: '28' },
        ],
      },
      {
        partId: 'G500-BLK-M',
        description: 'Black Medium',
        primaryMaterial: '100% cotton',
        colors: [{ colorName: 'Black', hex: '#000000' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'M' as const },
        specifications: [
          { specificationType: 'Chest', uom: 'IN', value: '20' },
          { specificationType: 'Length', uom: 'IN', value: '29' },
        ],
      },
      {
        partId: 'G500-WHT-S',
        description: 'White Small',
        primaryMaterial: '100% cotton',
        colors: [{ colorName: 'White' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'S' as const },
        specifications: [
          { specificationType: 'Chest', uom: 'IN', value: '18' },
          { specificationType: 'Length', uom: 'IN', value: '28' },
        ],
      },
    ],
    marketingPoints: [
      { pointType: 'Highlights', pointCopy: 'Preshrunk jersey knit' },
    ],
    keywords: ['t-shirt', 'cotton'],
    rawXml: '<Product>...</Product>',
  };
}

describe('S&S Canada mapOneSourceProductToSupplierProduct', () => {
  it('maps product fields correctly', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.styleNumber).toBe('G500');
    expect(result.supplier).toBe('ss-canada');
    expect(result.title).toBe('Heavy Cotton T-Shirt');
  });

  it('extracts fabric composition from primaryMaterial', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.fabricComposition).toBe('100% cotton');
  });

  it('falls back to description for fabric if primaryMaterial is empty', () => {
    const parsed = makeParsedProduct();
    for (const part of parsed.parts) {
      part.primaryMaterial = '';
    }
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.fabricComposition).toContain('100% cotton');
  });

  it('builds variants from parts', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.variants).toHaveLength(3);
    expect(result.variants[0]).toEqual({
      color: 'Black',
      size: 'S',
      sku: 'G500-BLK-S',
    });
  });

  it('builds size chart data from specifications', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.sizeChartData).not.toBeNull();
    expect(result.sizeChartData!.length).toBeGreaterThanOrEqual(4);

    const sChest = result.sizeChartData!.find(
      (s) => s.sizeName === 'S' && s.specName === 'Chest'
    );
    expect(sChest).toBeDefined();
    expect(sChest!.value).toBe('18 IN');

    const mChest = result.sizeChartData!.find(
      (s) => s.sizeName === 'M' && s.specName === 'Chest'
    );
    expect(mChest).toBeDefined();
    expect(mChest!.value).toBe('20 IN');
  });

  it('deduplicates specifications across parts with same size', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    const sChestEntries = result.sizeChartData!.filter(
      (s) => s.sizeName === 'S' && s.specName === 'Chest'
    );
    expect(sChestEntries).toHaveLength(1);
  });

  it('uses media images when no primaryImageUrl', () => {
    const parsed = makeParsedProduct();
    const mediaImages: ProductImage[] = [
      { url: 'https://example.com/G500-black-front.jpg', alt: 'Black front' },
      { url: 'https://example.com/G500-white-front.jpg', alt: 'White front' },
    ];
    const result = mapOneSourceProductToSupplierProduct(parsed, mediaImages);

    expect(result.images).toHaveLength(2);
    expect(result.images[0].url).toBe('https://example.com/G500-black-front.jpg');
  });

  it('maps category with subcategory', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.category).toBe('T-Shirts > Short Sleeve');
  });

  it('returns null sizeChartData when no specifications exist', () => {
    const parsed = makeParsedProduct();
    for (const part of parsed.parts) {
      part.specifications = [];
    }
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.sizeChartData).toBeNull();
  });
});
