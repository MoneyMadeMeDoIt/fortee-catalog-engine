import { describe, it, expect } from 'vitest';
import { buildProductSetInput } from '../../src/shopify/product-push.js';
import type { SheetRow } from '../../src/sheets/types.js';
import type { FileSetInput } from '../../src/shopify/types.js';

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

describe('buildProductSetInput', () => {
  it('creates 3 productOptions: Color, Size, # of Print Areas', () => {
    const rows = [makeRow()];
    const files: FileSetInput[] = [];
    const result = buildProductSetInput(rows, files);
    expect(result).not.toBeNull();
    const { input } = result!;
    expect(input.productOptions).toHaveLength(3);
    expect(input.productOptions[0].name).toBe('Color');
    expect(input.productOptions[0].position).toBe(1);
    expect(input.productOptions[1].name).toBe('Size');
    expect(input.productOptions[1].position).toBe(2);
    expect(input.productOptions[2].name).toBe('# of Print Areas');
    expect(input.productOptions[2].position).toBe(3);
  });

  it('includes # of Print Areas option with values 1 and 2', () => {
    const rows = [makeRow()];
    const result = buildProductSetInput(rows, []);
    const printAreasOpt = result!.input.productOptions[2];
    expect(printAreasOpt.values).toEqual([{ name: '1' }, { name: '2' }]);
  });

  it('uses getCategoryGroup and passes it to buildVariants', () => {
    const rows = [makeRow({ baseCategory: 'T-Shirt' })];
    const result = buildProductSetInput(rows, []);
    expect(result).not.toBeNull();
    // Variants should exist (T-Shirt is supported)
    expect(result!.input.variants.length).toBeGreaterThan(0);
  });

  it('sets templateSuffix to quick-order for supported categories', () => {
    const rows = [makeRow({ baseCategory: 'Hoodie' })];
    const result = buildProductSetInput(rows, []);
    expect(result).not.toBeNull();
    expect(result!.input.templateSuffix).toBe('quick-order');
  });

  it('returns null for unsupported categories (e.g., Cap)', () => {
    const rows = [makeRow({ baseCategory: 'Cap' })];
    const result = buildProductSetInput(rows, []);
    expect(result).toBeNull();
  });

  it('returns null for unknown categories', () => {
    const rows = [makeRow({ baseCategory: 'Pants' })];
    const result = buildProductSetInput(rows, []);
    expect(result).toBeNull();
  });

  it('uses files parameter directly', () => {
    const rows = [makeRow()];
    const files: FileSetInput[] = [
      { originalSource: 'https://staged/front.png', alt: 'Front Print', contentType: 'IMAGE' },
    ];
    const result = buildProductSetInput(rows, files);
    expect(result!.input.files).toEqual(files);
  });

  it('uses first row for product-level fields', () => {
    const rows = [
      makeRow({ productName: 'Cool Tee', styleID: 'CT100', brandName: 'Acme', description: 'A cool tee' }),
    ];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.title).toBe('Cool Tee');
    expect(input.vendor).toBe('Acme');
    expect(input.descriptionHtml).toBe('A cool tee');
  });

  it('generates correct handle', () => {
    const rows = [makeRow({ productName: 'Cool Tee', styleID: 'CT100' })];
    const { input, identifier } = buildProductSetInput(rows, [])!;
    expect(input.handle).toBe('cool-tee-ct100');
    expect(identifier.handle).toBe('cool-tee-ct100');
  });

  it('variants count is double the row count (1-area + 2-area per row)', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
      makeRow({ colorName: 'Blue', sizeName: 'L' }),
    ];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.variants).toHaveLength(6);
  });

  it('extracts unique colors and sizes for productOptions', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
      makeRow({ colorName: 'Blue', sizeName: 'S' }),
    ];
    const { input } = buildProductSetInput(rows, [])!;
    const colorOpt = input.productOptions.find((o) => o.name === 'Color');
    const sizeOpt = input.productOptions.find((o) => o.name === 'Size');
    expect(colorOpt!.values.map((v) => v.name)).toEqual(['Red', 'Blue']);
    expect(sizeOpt!.values.map((v) => v.name)).toEqual(['S', 'M']);
  });
});
