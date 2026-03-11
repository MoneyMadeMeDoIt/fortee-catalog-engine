import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
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
  it('returns product metadata with no options or variants (shell only)', () => {
    const rows = [makeRow()];
    const files: FileSetInput[] = [];
    const result = buildProductSetInput(rows, files);
    expect(result).not.toBeNull();
    const { input } = result!;
    expect(input.productOptions).toEqual([]);
    expect(input.variants).toEqual([]);
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

  it('includes tags from brandName, baseCategory, gender', () => {
    const rows = [makeRow({ brandName: 'Acme', baseCategory: 'T-Shirt', gender: 'Unisex' })];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.tags).toEqual(['Acme', 'T-Shirt', 'Unisex']);
  });

  it('sets taxonomy category for T-Shirts', () => {
    const rows = [makeRow({ baseCategory: 'T-Shirt' })];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.category).toBe('gid://shopify/TaxonomyCategory/aa-1-13-8');
  });

  it('sets taxonomy category for Hoodies', () => {
    const rows = [makeRow({ baseCategory: 'Hoodie' })];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.category).toBe('gid://shopify/TaxonomyCategory/aa-1-13-13');
  });

  it('sets taxonomy category for Crewneck/Fleece Crew', () => {
    const rows = [makeRow({ baseCategory: 'Fleece - Premium - Crew' })];
    const { input } = buildProductSetInput(rows, [])!;
    expect(input.category).toBe('gid://shopify/TaxonomyCategory/aa-1-13-14');
  });
});

describe('product-push.ts size guide wiring', () => {
  it('imports upsertSizeGuideMetaobject and linkSizeGuideToProduct from metaobjects.ts', () => {
    // Verify the size guide functions are imported in product-push.ts source
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/shopify/product-push.ts');
    const src = readFileSync(srcPath, 'utf8');
    expect(src).toContain('upsertSizeGuideMetaobject');
    expect(src).toContain('linkSizeGuideToProduct');
    expect(src).toContain("from './metaobjects.js'");
  });

  it('imports readSpecSheetStructured from spec-sheet.ts', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/shopify/product-push.ts');
    const src = readFileSync(srcPath, 'utf8');
    expect(src).toContain('readSpecSheetStructured');
    expect(src).toContain("from '../sheets/spec-sheet.js'");
  });

  it('guards size guide step with SPEC_SHEET_GOOGLE_SPREADSHEET_ID check', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/shopify/product-push.ts');
    const src = readFileSync(srcPath, 'utf8');
    expect(src).toContain('SPEC_SHEET_GOOGLE_SPREADSHEET_ID');
    // Should wrap in try/catch for non-fatal behavior
    expect(src).toContain('Size guide creation failed (non-fatal)');
  });

  it('logs warning when no spec data found for product', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/shopify/product-push.ts');
    const src = readFileSync(srcPath, 'utf8');
    expect(src).toContain('No spec data for productId');
    expect(src).toContain('skipping size guide');
  });
});
