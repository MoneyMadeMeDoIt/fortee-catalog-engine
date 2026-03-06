import { describe, it, expect } from 'vitest';
import { mapOneSourceProductToSupplierProduct } from '../../src/suppliers/canada-sportswear.js';
import type { ProductImage } from '../../src/suppliers/types.js';

function makeParsedProduct() {
  return {
    productId: 'L00450',
    productName: 'Weekender Vintage Wash Pullover Hooded Sweatshirt',
    description: 'Relaxed fit. Attached hood. 280 gsm. 70% cotton, 30% polyester vintage wash fleece.',
    productBrand: 'Canada Sportswear',
    primaryImageUrl: 'https://example.com/images/L00450-front.jpg',
    categories: [
      { category: 'Hooded Sweatshirts', subCategory: 'Pullover' },
    ],
    parts: [
      {
        partId: 'L00450-BLK-S',
        description: 'Black Small',
        primaryMaterial: '70% cotton, 30% polyester',
        colors: [{ colorName: 'Black', hex: '#000000' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'S' as const },
        specifications: [],
      },
      {
        partId: 'L00450-BLK-M',
        description: 'Black Medium',
        primaryMaterial: '70% cotton, 30% polyester',
        colors: [{ colorName: 'Black', hex: '#000000' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'M' as const },
        specifications: [],
      },
      {
        partId: 'L00450-NAV-S',
        description: 'Navy Small',
        primaryMaterial: '70% cotton, 30% polyester',
        colors: [{ colorName: 'Navy', hex: '#000080' }],
        apparelSize: { apparelStyle: 'Unisex', labelSize: 'S' as const },
        specifications: [],
      },
    ],
    marketingPoints: [
      { pointType: 'Highlights', pointCopy: 'Relaxed fit with attached hood' },
    ],
    keywords: ['hoodie', 'sweatshirt', 'vintage'],
    isCloseout: false,
    rawXml: '<Product>...</Product>',
  };
}

describe('mapOneSourceProductToSupplierProduct', () => {
  it('maps product fields correctly', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.styleNumber).toBe('L00450');
    expect(result.supplier).toBe('canada-sportswear');
    expect(result.title).toBe('Weekender Vintage Wash Pullover Hooded Sweatshirt');
    expect(result.description).toContain('Relaxed fit');
  });

  it('extracts fabric composition from primaryMaterial', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.fabricComposition).toBe('70% cotton, 30% polyester');
  });

  it('falls back to description for fabric if primaryMaterial is empty', () => {
    const parsed = makeParsedProduct();
    for (const part of parsed.parts) {
      part.primaryMaterial = '';
    }
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.fabricComposition).toContain('70% cotton');
  });

  it('maps categories correctly', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.category).toBe('Hooded Sweatshirts > Pullover');
  });

  it('builds variants from parts with color and size', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.variants).toHaveLength(3);
    expect(result.variants[0]).toEqual({
      color: 'Black',
      size: 'S',
      sku: 'L00450-BLK-S',
    });
    expect(result.variants[2]).toEqual({
      color: 'Navy',
      size: 'S',
      sku: 'L00450-NAV-S',
    });
  });

  it('uses primaryImageUrl and deduplicates media images', () => {
    const parsed = makeParsedProduct();
    const mediaImages: ProductImage[] = [
      { url: 'https://example.com/images/L00450-front.jpg', alt: 'Front' },
      { url: 'https://example.com/images/L00450-back.jpg', alt: 'Back' },
    ];
    const result = mapOneSourceProductToSupplierProduct(parsed, mediaImages);

    expect(result.images).toHaveLength(2);
    expect(result.images[0].url).toBe('https://example.com/images/L00450-front.jpg');
    expect(result.images[1].url).toBe('https://example.com/images/L00450-back.jpg');
  });

  it('works with no images', () => {
    const parsed = makeParsedProduct();
    parsed.primaryImageUrl = '';
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.images).toHaveLength(0);
  });

  it('sets sizeChartUrl and sizeChartData to null', () => {
    const parsed = makeParsedProduct();
    const result = mapOneSourceProductToSupplierProduct(parsed, []);

    expect(result.sizeChartUrl).toBeNull();
    expect(result.sizeChartData).toBeNull();
  });
});
