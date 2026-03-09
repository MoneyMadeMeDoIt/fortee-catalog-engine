import { describe, it, expect } from 'vitest';
import { buildProductSetInput } from '../../src/shopify/product-push.js';
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

describe('buildProductSetInput', () => {
  it('uses first row for product-level fields', () => {
    const rows = [
      makeRow({ productName: 'Cool Tee', styleID: 'CT100', brandName: 'Acme', baseCategory: 'T-Shirt', description: 'A cool tee' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    expect(input.title).toBe('Cool Tee');
    expect(input.vendor).toBe('Acme');
    expect(input.productType).toBe('T-Shirt');
    expect(input.descriptionHtml).toBe('A cool tee');
  });

  it('generates correct handle', () => {
    const rows = [makeRow({ productName: 'Cool Tee', styleID: 'CT100' })];
    const { input, identifier } = buildProductSetInput(rows, false);
    expect(input.handle).toBe('cool-tee-ct100');
    expect(identifier.handle).toBe('cool-tee-ct100');
  });

  it('sets status to ACTIVE', () => {
    const rows = [makeRow()];
    const { input } = buildProductSetInput(rows, false);
    expect(input.status).toBe('ACTIVE');
  });

  it('sets templateSuffix to quick-order for supported categories', () => {
    const rows = [makeRow({ baseCategory: 'Hoodie' })];
    const { input } = buildProductSetInput(rows, false);
    expect(input.templateSuffix).toBe('quick-order');
  });

  it('includes brandName, baseCategory, and gender in tags', () => {
    const rows = [makeRow({ brandName: 'Acme', baseCategory: 'Cap', gender: 'Men' })];
    const { input } = buildProductSetInput(rows, false);
    expect(input.tags).toContain('Acme');
    expect(input.tags).toContain('Cap');
    expect(input.tags).toContain('Men');
  });

  it('filters empty values from tags', () => {
    const rows = [makeRow({ brandName: 'Acme', baseCategory: '', gender: 'Unisex' })];
    const { input } = buildProductSetInput(rows, false);
    expect(input.tags).toEqual(['Acme', 'Unisex']);
  });

  it('extracts unique colors for productOptions', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
      makeRow({ colorName: 'Blue', sizeName: 'S' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    const colorOption = input.productOptions.find((o) => o.name === 'Color');
    expect(colorOption).toBeDefined();
    expect(colorOption!.values.map((v) => v.name)).toEqual(['Red', 'Blue']);
  });

  it('extracts unique sizes for productOptions', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Blue', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    const sizeOption = input.productOptions.find((o) => o.name === 'Size');
    expect(sizeOption).toBeDefined();
    expect(sizeOption!.values.map((v) => v.name)).toEqual(['S', 'M']);
  });

  it('variants count is double the row count (1-area + 2-area per row)', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S' }),
      makeRow({ colorName: 'Red', sizeName: 'M' }),
      makeRow({ colorName: 'Blue', sizeName: 'L' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    expect(input.variants).toHaveLength(6);
  });

  it('includes files when isUpdate=false', () => {
    const rows = [
      makeRow({ FrontImage: 'https://img/front.jpg' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    expect(input.files).toBeDefined();
    expect(input.files!.length).toBeGreaterThan(0);
  });

  it('omits files when isUpdate=true', () => {
    const rows = [
      makeRow({ FrontImage: 'https://img/front.jpg' }),
    ];
    const { input } = buildProductSetInput(rows, true);
    expect(input.files).toBeUndefined();
  });

  it('collects files from ALL rows across colors', () => {
    const rows = [
      makeRow({ colorName: 'Red', sizeName: 'S', FrontImage: 'https://img/red-front.jpg' }),
      makeRow({ colorName: 'Red', sizeName: 'M', FrontImage: 'https://img/red-front.jpg' }),
      makeRow({ colorName: 'Blue', sizeName: 'S', FrontImage: 'https://img/blue-front.jpg' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    // 2 unique front images (Red deduped, Blue unique)
    expect(input.files).toHaveLength(2);
  });

  it('deduplicates identical URLs across rows', () => {
    const rows = [
      makeRow({ sizeName: 'S', FrontImage: 'https://img/same.jpg' }),
      makeRow({ sizeName: 'M', FrontImage: 'https://img/same.jpg' }),
      makeRow({ sizeName: 'L', FrontImage: 'https://img/same.jpg' }),
    ];
    const { input } = buildProductSetInput(rows, false);
    expect(input.files).toHaveLength(1);
  });

  it('sets Color option at position 1 and Size at position 2', () => {
    const rows = [makeRow()];
    const { input } = buildProductSetInput(rows, false);
    const colorOpt = input.productOptions.find((o) => o.name === 'Color');
    const sizeOpt = input.productOptions.find((o) => o.name === 'Size');
    expect(colorOpt!.position).toBe(1);
    expect(sizeOpt!.position).toBe(2);
  });
});
