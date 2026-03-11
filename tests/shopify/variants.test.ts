import { describe, it, expect } from 'vitest';
import { buildFiles, getCategoryGroup, SUPPORTED_CATEGORIES } from '../../src/shopify/variants.js';
import type { SheetRow } from '../../src/sheets/types.js';

function makeRow(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    supplierCode: 'TEST',
    PartID: 'PART-001',
    styleID: 'ST100',
    partNumber: 'PN-001',
    brandName: 'TestBrand',
    productId: 'S05280',
    colorName: 'Black',
    colorFamily: 'Black',
    productName: 'Test Tee',
    description: 'A test t-shirt',
    FrontImage: '',
    BackImage: '',
    DirectSideImage: '',
    col14Empty: '',
    color1: '#000000',
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
    embroideryAvailable: 'No',
    dtfAvailable: 'Yes',
    sellPrice1Area: '25.99',
    sellPrice2Area: '31.99',
    decorationPlacements: '',
    ...overrides,
  };
}

describe('getCategoryGroup', () => {
  it('returns tops for T-Shirts - Premium', () => {
    expect(getCategoryGroup('T-Shirts - Premium')).toBe('tops');
  });

  it('returns tops for T-Shirts - Core', () => {
    expect(getCategoryGroup('T-Shirts - Core')).toBe('tops');
  });

  it('returns tops for T-Shirts - Long Sleeve', () => {
    expect(getCategoryGroup('T-Shirts - Long Sleeve')).toBe('tops');
  });

  it('returns tops for Fleece - Premium - Crew', () => {
    expect(getCategoryGroup('Fleece - Premium - Crew')).toBe('tops');
  });

  it('returns tops for Fleece - Core - Crew', () => {
    expect(getCategoryGroup('Fleece - Core - Crew')).toBe('tops');
  });

  it('returns hoodies for Fleece - Premium - Hood', () => {
    expect(getCategoryGroup('Fleece - Premium - Hood')).toBe('hoodies');
  });

  it('returns hoodies for Fleece - Core - Hood', () => {
    expect(getCategoryGroup('Fleece - Core - Hood')).toBe('hoodies');
  });

  it('returns null for Headwear (unsupported)', () => {
    expect(getCategoryGroup('Headwear')).toBeNull();
  });

  it('returns null for Outerwear (unsupported)', () => {
    expect(getCategoryGroup('Outerwear')).toBeNull();
  });

  it('returns null for unknown category', () => {
    expect(getCategoryGroup('Unknown')).toBeNull();
  });
});

describe('SUPPORTED_CATEGORIES', () => {
  it('contains the real sheet category names', () => {
    expect(SUPPORTED_CATEGORIES.has('T-Shirts - Premium')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('T-Shirts - Core')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('Fleece - Premium - Hood')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('Fleece - Premium - Crew')).toBe(true);
  });
});

describe('buildFiles', () => {
  it('sets alt text "Front Print" for FrontImage and "Back Print" for BackImage', () => {
    const rows = [makeRow({
      FrontImage: 'https://img/front.jpg',
      BackImage: 'https://img/back.jpg',
    })];
    const files = buildFiles(rows);
    const front = files.find(f => f.originalSource === 'https://img/front.jpg');
    const back = files.find(f => f.originalSource === 'https://img/back.jpg');
    expect(front!.alt).toBe('Front Print');
    expect(back!.alt).toBe('Back Print');
  });

  it('sets descriptive alt text for side images', () => {
    const rows = [makeRow({
      productName: 'Cool Tee',
      colorName: 'Navy',
      DirectSideImage: 'https://img/side.jpg',
    })];
    const files = buildFiles(rows);
    expect(files[0].alt).toBe('Cool Tee - Navy Side');
  });

  it('deduplicates by URL', () => {
    const rows = [
      makeRow({ sizeName: 'S', FrontImage: 'https://img/front.jpg' }),
      makeRow({ sizeName: 'M', FrontImage: 'https://img/front.jpg' }),
    ];
    const files = buildFiles(rows);
    expect(files).toHaveLength(1);
  });

  it('returns empty array when no images', () => {
    const rows = [makeRow()];
    const files = buildFiles(rows);
    expect(files).toHaveLength(0);
  });

  it('sets contentType to IMAGE', () => {
    const rows = [makeRow({ FrontImage: 'https://img/f.jpg' })];
    const files = buildFiles(rows);
    expect(files[0].contentType).toBe('IMAGE');
  });
});
