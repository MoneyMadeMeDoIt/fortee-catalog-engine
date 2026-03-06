import { describe, it, expect } from 'vitest';
import { formatSizeChart, mapSupplierToSheetFields, buildUpdates } from '../../src/sheets/merge.js';
import type { SizeSpec, SupplierProduct } from '../../src/suppliers/types.js';
import type { SheetRow } from '../../src/sheets/types.js';

describe('formatSizeChart', () => {
  it('formats 2 sizes with 2 specs each into structured text', () => {
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest', value: '36' },
      { sizeName: 'S', specName: 'Length', value: '28' },
      { sizeName: 'M', specName: 'Chest', value: '38' },
      { sizeName: 'M', specName: 'Length', value: '29' },
    ];
    expect(formatSizeChart(specs)).toBe(
      'S: Chest 36, Length 28 | M: Chest 38, Length 29'
    );
  });

  it('returns empty string for empty array', () => {
    expect(formatSizeChart([])).toBe('');
  });
});

describe('mapSupplierToSheetFields', () => {
  const baseProduct: SupplierProduct = {
    styleNumber: 'ABC123',
    supplier: 'canada-sportswear',
    title: 'Premium Jacket',
    description: 'A warm jacket for winter',
    category: 'Outerwear',
    fabricComposition: '100% Polyester',
    sizeChartUrl: null,
    sizeChartData: [
      { sizeName: 'S', specName: 'Chest', value: '36' },
      { sizeName: 'M', specName: 'Chest', value: '38' },
    ],
    images: [
      { url: 'https://example.com/front.jpg' },
      { url: 'https://example.com/back.jpg' },
      { url: 'https://example.com/side.jpg' },
    ],
    variants: [{ color: 'Black', size: 'S' }],
    isCloseout: false,
    rawData: {},
  };

  it('maps images, description, sizeChart correctly', () => {
    const result = mapSupplierToSheetFields(baseProduct);
    expect(result.FrontImage).toBe('https://example.com/front.jpg');
    expect(result.BackImage).toBe('https://example.com/back.jpg');
    expect(result.DirectSideImage).toBe('https://example.com/side.jpg');
    expect(result.description).toBe('A warm jacket for winter');
    expect(result.careInstructions).toBeUndefined();
    expect(result.sizeChart).toBe('S: Chest 36 | M: Chest 38');
    expect(result.productName).toBe('Premium Jacket');
    expect(result.baseCategory).toBe('Outerwear');
  });

  it('handles product with no images gracefully', () => {
    const noImgProduct = { ...baseProduct, images: [] };
    const result = mapSupplierToSheetFields(noImgProduct);
    expect(result.FrontImage).toBeUndefined();
    expect(result.BackImage).toBeUndefined();
    expect(result.DirectSideImage).toBeUndefined();
  });
});

describe('buildUpdates', () => {
  const headers = [
    'supplierCode', 'PartID', 'styleID', 'partNumber', 'brandName',
    'productId', 'colorName', 'colorFamily', 'productName', 'description',
    'FrontImage', 'BackImage', 'DirectSideImage', 'col14Empty',
    'color1', 'color2', 'sizeName', 'sizePriceCodeName', 'costPrice',
    'CaseQty', 'unitWeight', 'Qty', 'CaseWeight', 'BoxHeight',
    'BoxLength', 'BoxWidth', 'baseCategory', 'weightGSM', 'gender',
    'fit', 'keywords', 'categories', 'careInstructions', 'sizeChart',
    'embroideryAvailable', 'dtfAvailable',
  ];

  function makeRow(overrides: Partial<SheetRow> = {}): SheetRow {
    const base: Record<string, string> = {};
    for (const h of headers) {
      base[h] = '';
    }
    return { ...base, ...overrides } as unknown as SheetRow;
  }

  it('produces update for empty description when supplier has data', () => {
    const row = makeRow({ description: '' });
    const supplierData = { description: 'Warm jacket' };
    const updates = buildUpdates(row, supplierData, headers, 0, 'Sheet1');
    expect(updates).toHaveLength(1);
    expect(updates[0].range).toBe('Sheet1!J2');
    expect(updates[0].values).toEqual([['Warm jacket']]);
  });

  it('produces 0 updates when row already has description', () => {
    const row = makeRow({ description: 'Existing desc' });
    const supplierData = { description: 'Warm jacket' };
    const updates = buildUpdates(row, supplierData, headers, 0, 'Sheet1');
    expect(updates).toHaveLength(0);
  });

  it('produces update for empty FrontImage when supplier has image', () => {
    const row = makeRow({ FrontImage: '' });
    const supplierData = { FrontImage: 'https://example.com/img.jpg' };
    const updates = buildUpdates(row, supplierData, headers, 0, 'Sheet1');
    expect(updates).toHaveLength(1);
    expect(updates[0].range).toBe('Sheet1!K2');
  });

  it('skips FrontImage when row already has image (image priority rule)', () => {
    const row = makeRow({ FrontImage: 'https://existing.com/img.jpg' });
    const supplierData = { FrontImage: 'https://example.com/new.jpg' };
    const updates = buildUpdates(row, supplierData, headers, 0, 'Sheet1');
    expect(updates).toHaveLength(0);
  });

  it('uses correct sheet row number (rowIndex 0 -> sheet row 2)', () => {
    const row = makeRow({ description: '' });
    const supplierData = { description: 'Test' };

    const updates0 = buildUpdates(row, supplierData, headers, 0, 'Sheet1');
    expect(updates0[0].range).toBe('Sheet1!J2');

    const updates5 = buildUpdates(row, supplierData, headers, 5, 'Sheet1');
    expect(updates5[0].range).toBe('Sheet1!J7');
  });
});
