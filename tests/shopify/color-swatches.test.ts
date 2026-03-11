import { describe, it, expect } from 'vitest';
import { buildLinkedVariants } from '../../src/shopify/color-swatches.js';
import type { ColorInfo } from '../../src/shopify/color-swatches.js';
import type { PrintAreaCoords } from '../../src/shopify/types.js';
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

/** Sample computed print area coords (as would come from processProductImages). */
const SAMPLE_TOPS_COORDS: PrintAreaCoords = {
  'Front Print': { x: '31.60', y: '15.87', width: '36.20', height: '50.80' },
  'Back Print': { x: '30.60', y: '16.07', width: '39.40', height: '48.40' },
};

const SAMPLE_HOODIES_COORDS: PrintAreaCoords = {
  'Front Print': { x: '33.60', y: '25.53', width: '31.20', height: '36.00' },
  'Back Print': { x: '32.48', y: '33.67', width: '33.80', height: '39.40' },
};

describe('buildLinkedVariants', () => {
  const colorMap = new Map<string, ColorInfo>([
    ['Black', { gid: 'gid://shopify/Metaobject/111', displayName: 'Black' }],
    ['Navy', { gid: 'gid://shopify/Metaobject/222', displayName: 'Navy' }],
  ]);

  it('produces 2 variants per row (1-area and 2-area)', () => {
    const rows = [makeRow()];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants).toHaveLength(2);
  });

  it('uses display name for Color option value', () => {
    const rows = [makeRow({ colorName: 'Black' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    for (const v of variants) {
      const colorOpt = v.optionValues.find((o) => o.optionName === 'Color');
      expect(colorOpt?.name).toBe('Black');
    }
  });

  it('uses regular name for Size and # of Print Areas options', () => {
    const rows = [makeRow({ sizeName: 'L' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    for (const v of variants) {
      const sizeOpt = v.optionValues.find((o) => o.optionName === 'Size');
      const areaOpt = v.optionValues.find((o) => o.optionName === '# of Print Areas');
      expect(sizeOpt?.name).toBe('L');
      expect(areaOpt?.name).toBeDefined();
    }
  });

  it('1-area uses sellPrice1Area, 2-area uses sellPrice2Area', () => {
    const rows = [makeRow({ sellPrice1Area: '25.99', sellPrice2Area: '31.99' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants[0].price).toBe('25.99');
    expect(variants[1].price).toBe('31.99');
  });

  it('SKU format is ProductId-Color-Size inside inventoryItem', () => {
    const rows = [makeRow({ productId: 'S05280', colorName: 'Black', sizeName: 'M' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants[0].inventoryItem.sku).toBe('S05280-Black-M');
    expect(variants[1].inventoryItem.sku).toBe('S05280-Black-M');
  });

  it('barcode is PartID', () => {
    const rows = [makeRow({ PartID: 'PART-XYZ' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants[0].barcode).toBe('PART-XYZ');
  });

  it('includes print_area_position and number_of_print_areas metafields', () => {
    const rows = [makeRow()];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    const expected = JSON.stringify(SAMPLE_TOPS_COORDS);
    for (const v of variants) {
      expect(v.metafields).toHaveLength(2);
      expect(v.metafields[0]).toEqual({
        namespace: 'custom',
        key: 'print_area_position',
        type: 'json',
        value: expected,
      });
    }
    expect(variants[0].metafields[1].value).toBe('1');
    expect(variants[1].metafields[1].value).toBe('2');
  });

  it('uses provided hoodies coords when passed in', () => {
    const rows = [makeRow()];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_HOODIES_COORDS);
    const hoodieCoords = JSON.stringify(SAMPLE_HOODIES_COORDS);
    expect(variants[0].metafields[0].value).toBe(hoodieCoords);
  });

  it('uses empty JSON object when printAreaCoords is null', () => {
    const rows = [makeRow()];
    const variants = buildLinkedVariants(rows, colorMap, null);
    expect(variants[0].metafields[0].value).toBe('{}');
  });

  it('skips rows with missing color mapping (warns)', () => {
    const rows = [makeRow({ colorName: 'UnknownColor' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants).toHaveLength(0);
  });

  it('3 rows produce 6 variants', () => {
    const rows = [
      makeRow({ colorName: 'Black', sizeName: 'S' }),
      makeRow({ colorName: 'Black', sizeName: 'M' }),
      makeRow({ colorName: 'Navy', sizeName: 'L' }),
    ];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants).toHaveLength(6);
  });

  it('defaults price to 0.00 for empty sellPrice', () => {
    const rows = [makeRow({ sellPrice1Area: '', sellPrice2Area: '' })];
    const variants = buildLinkedVariants(rows, colorMap, SAMPLE_TOPS_COORDS);
    expect(variants[0].price).toBe('0.00');
    expect(variants[1].price).toBe('0.00');
  });
});
