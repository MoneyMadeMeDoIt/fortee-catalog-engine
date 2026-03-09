import { describe, it, expect } from 'vitest';
import { buildVariants, buildFiles, getCategoryGroup, SUPPORTED_CATEGORIES, PRINT_AREA_COORDINATES } from '../../src/shopify/variants.js';
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

describe('buildVariants', () => {
  it('produces 2 variants per row (1-area and 2-area)', () => {
    const rows = [makeRow()];
    const variants = buildVariants(rows, 'tops');
    expect(variants).toHaveLength(2);
  });

  it('each variant has 3 optionValues: Color, Size, # of Print Areas', () => {
    const rows = [makeRow()];
    const variants = buildVariants(rows, 'tops');
    for (const v of variants) {
      expect(v.optionValues).toHaveLength(3);
      expect(v.optionValues[0].optionName).toBe('Color');
      expect(v.optionValues[1].optionName).toBe('Size');
      expect(v.optionValues[2].optionName).toBe('# of Print Areas');
    }
  });

  it('1-area variant has optionValues[2].name === "1", 2-area === "2"', () => {
    const rows = [makeRow()];
    const variants = buildVariants(rows, 'tops');
    expect(variants[0].optionValues[2].name).toBe('1');
    expect(variants[1].optionValues[2].name).toBe('2');
  });

  it('1-area uses sellPrice1Area, 2-area uses sellPrice2Area', () => {
    const rows = [makeRow({ sellPrice1Area: '25.99', sellPrice2Area: '31.99' })];
    const variants = buildVariants(rows, 'tops');
    expect(variants[0].price).toBe(25.99);
    expect(variants[1].price).toBe(31.99);
  });

  it('SKU format is ProductId-Color-Size for all variants', () => {
    const rows = [makeRow({ productId: 'S05280', colorName: 'Black', sizeName: 'M' })];
    const variants = buildVariants(rows, 'tops');
    expect(variants[0].sku).toBe('S05280-Black-M');
    expect(variants[1].sku).toBe('S05280-Black-M');
  });

  it('barcode is PartID', () => {
    const rows = [makeRow({ PartID: 'PART-XYZ' })];
    const variants = buildVariants(rows, 'tops');
    expect(variants[0].barcode).toBe('PART-XYZ');
    expect(variants[1].barcode).toBe('PART-XYZ');
  });

  it('variant metafields contain print_area_position with tops coordinates', () => {
    const rows = [makeRow()];
    const variants = buildVariants(rows, 'tops');
    const expected = JSON.stringify(PRINT_AREA_COORDINATES.tops);
    for (const v of variants) {
      expect(v.metafields).toBeDefined();
      expect(v.metafields).toHaveLength(1);
      expect(v.metafields![0]).toEqual({
        namespace: 'custom',
        key: 'print_area_position',
        type: 'json',
        value: expected,
      });
    }
  });

  it('variant metafields for hoodies have different coordinates than tops', () => {
    const rows = [makeRow()];
    const topsVariants = buildVariants(rows, 'tops');
    const hoodieVariants = buildVariants(rows, 'hoodies');
    expect(topsVariants[0].metafields![0].value).not.toBe(hoodieVariants[0].metafields![0].value);
    expect(hoodieVariants[0].metafields![0].value).toBe(JSON.stringify(PRINT_AREA_COORDINATES.hoodies));
  });

  it('3 rows produce 6 variants', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
      makeRow({ colorName: 'Blue', sizeName: 'L' }),
    ];
    const variants = buildVariants(rows, 'tops');
    expect(variants).toHaveLength(6);
  });

  it('defaults price to 0 for empty sellPrice', () => {
    const rows = [makeRow({ sellPrice1Area: '', sellPrice2Area: '' })];
    const variants = buildVariants(rows, 'tops');
    expect(variants[0].price).toBe(0);
    expect(variants[1].price).toBe(0);
  });
});

describe('getCategoryGroup', () => {
  it('returns tops for T-Shirt', () => {
    expect(getCategoryGroup('T-Shirt')).toBe('tops');
  });

  it('returns tops for Long Sleeve', () => {
    expect(getCategoryGroup('Long Sleeve')).toBe('tops');
  });

  it('returns tops for Crewneck', () => {
    expect(getCategoryGroup('Crewneck')).toBe('tops');
  });

  it('returns hoodies for Hoodie', () => {
    expect(getCategoryGroup('Hoodie')).toBe('hoodies');
  });

  it('returns null for Cap (unsupported)', () => {
    expect(getCategoryGroup('Cap')).toBeNull();
  });

  it('returns null for unknown category', () => {
    expect(getCategoryGroup('Unknown')).toBeNull();
  });
});

describe('SUPPORTED_CATEGORIES', () => {
  it('contains exactly T-Shirt, Long Sleeve, Crewneck, Hoodie', () => {
    expect(SUPPORTED_CATEGORIES.size).toBe(4);
    expect(SUPPORTED_CATEGORIES.has('T-Shirt')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('Long Sleeve')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('Crewneck')).toBe(true);
    expect(SUPPORTED_CATEGORIES.has('Hoodie')).toBe(true);
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
