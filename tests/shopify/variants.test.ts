import { describe, it, expect } from 'vitest';
import { buildVariants, buildFiles } from '../../src/shopify/variants.js';
import type { SheetRow } from '../../src/sheets/types.js';

function makeRow(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    supplierCode: 'TEST',
    PartID: 'PART-001',
    styleID: 'ST100',
    partNumber: 'PN-001',
    brandName: 'TestBrand',
    productId: 'PID-001',
    colorName: 'Red',
    colorFamily: 'Red',
    productName: 'Test Tee',
    description: 'A test t-shirt',
    FrontImage: '',
    BackImage: '',
    DirectSideImage: '',
    col14Empty: '',
    color1: '#FF0000',
    color2: '',
    sizeName: 'M',
    sizePriceCodeName: 'Medium',
    costPrice: '10.00',
    CaseQty: '12',
    unitWeight: '0.5',
    Qty: '100',
    CaseWeight: '6.0',
    BoxHeight: '10',
    BoxLength: '20',
    BoxWidth: '15',
    baseCategory: 'T-Shirt',
    weightGSM: '180',
    gender: 'Unisex',
    fit: 'Regular',
    keywords: 'test',
    categories: 'Apparel',
    careInstructions: 'Machine wash cold',
    sizeChart: '',
    embroideryAvailable: 'true',
    dtfAvailable: 'true',
    sellPrice1Area: '25.99',
    sellPrice2Area: '31.99',
    decorationPlacements: '',
    ...overrides,
  };
}

describe('buildVariants', () => {
  it('produces correct variant count from rows', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S', partNumber: 'PN-S', PartID: 'P-S', sellPrice1Area: '20.00', sellPrice2Area: '26.00' }),
      makeRow({ colorName: 'Red', sizeName: 'M', partNumber: 'PN-M', PartID: 'P-M', sellPrice1Area: '21.00', sellPrice2Area: '27.00' }),
      makeRow({ colorName: 'Blue', sizeName: 'L', partNumber: 'PN-L', PartID: 'P-L', sellPrice1Area: '22.00', sellPrice2Area: '28.00' }),
    ];
    const variants = buildVariants(rows);
    expect(variants).toHaveLength(3);
  });

  it('maps optionValues correctly', () => {
    const rows = [makeRow({ colorName: 'Red', sizeName: 'XL' })];
    const [v] = buildVariants(rows);
    expect(v.optionValues).toEqual([
      { optionName: 'Color', name: 'Red' },
      { optionName: 'Size', name: 'XL' },
    ]);
  });

  it('maps sellPrice1Area to price', () => {
    const rows = [makeRow({ sellPrice1Area: '29.99' })];
    const [v] = buildVariants(rows);
    expect(v.price).toBe(29.99);
  });

  it('maps partNumber to sku', () => {
    const rows = [makeRow({ partNumber: 'SKU-ABC' })];
    const [v] = buildVariants(rows);
    expect(v.sku).toBe('SKU-ABC');
  });

  it('maps PartID to barcode', () => {
    const rows = [makeRow({ PartID: 'BAR-123' })];
    const [v] = buildVariants(rows);
    expect(v.barcode).toBe('BAR-123');
  });

  it('defaults price to 0 for empty sellPrice1Area', () => {
    const rows = [makeRow({ sellPrice1Area: '' })];
    const [v] = buildVariants(rows);
    expect(v.price).toBe(0);
  });

  it('defaults price to 0 for non-numeric sellPrice1Area', () => {
    const rows = [makeRow({ sellPrice1Area: 'abc' })];
    const [v] = buildVariants(rows);
    expect(v.price).toBe(0);
  });
});

describe('buildFiles', () => {
  it('collects unique images across all rows', () => {
    const rows = [
      makeRow({ colorName: 'Red', FrontImage: 'https://img/red-front.jpg', BackImage: 'https://img/red-back.jpg' }),
      makeRow({ colorName: 'Blue', FrontImage: 'https://img/blue-front.jpg', BackImage: 'https://img/blue-back.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files).toHaveLength(4);
  });

  it('deduplicates identical URLs across rows', () => {
    const rows = [
      makeRow({ sizeName: 'S', FrontImage: 'https://img/front.jpg' }),
      makeRow({ sizeName: 'M', FrontImage: 'https://img/front.jpg' }),
      makeRow({ sizeName: 'L', FrontImage: 'https://img/front.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files).toHaveLength(1);
    expect(files[0].originalSource).toBe('https://img/front.jpg');
  });

  it('includes side images', () => {
    const rows = [
      makeRow({ FrontImage: 'https://img/f.jpg', DirectSideImage: 'https://img/s.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files).toHaveLength(2);
  });

  it('returns empty array when no images', () => {
    const rows = [makeRow(), makeRow()];
    const files = buildFiles(rows);
    expect(files).toHaveLength(0);
  });

  it('sets correct alt text with color and position', () => {
    const rows = [
      makeRow({ productName: 'Cool Tee', colorName: 'Navy', FrontImage: 'https://img/f.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files[0].alt).toBe('Cool Tee - Navy Front');
  });

  it('sets contentType to IMAGE', () => {
    const rows = [makeRow({ FrontImage: 'https://img/f.jpg' })];
    const files = buildFiles(rows);
    expect(files[0].contentType).toBe('IMAGE');
  });

  it('handles 3 rows with 2 different FrontImage URLs (2 colors)', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S', FrontImage: 'https://img/red.jpg' }),
      makeRow({ colorName: 'Red', sizeName: 'M', FrontImage: 'https://img/red.jpg' }),
      makeRow({ colorName: 'Blue', sizeName: 'S', FrontImage: 'https://img/blue.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files).toHaveLength(2);
    const sources = files.map(f => f.originalSource);
    expect(sources).toContain('https://img/red.jpg');
    expect(sources).toContain('https://img/blue.jpg');
  });
});
