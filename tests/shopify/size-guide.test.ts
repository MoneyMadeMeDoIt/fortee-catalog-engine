import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSizeGuideMetaobjectFields,
  transformSpecsToSizeGuide,
  linkSizeGuideToProduct,
} from '../../src/shopify/metaobjects.js';
import { readSpecSheetStructured } from '../../src/sheets/spec-sheet.js';
import type { SizeSpec } from '../../src/suppliers/types.js';

// --- readSpecSheetStructured tests ---

describe('readSpecSheetStructured', () => {
  it('returns Map<string, SizeSpec[]> grouped by styleName', async () => {
    const mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ['specID', 'styleID', 'partNumber', 'brandName', 'styleName', 'sizeName', 'sizeOrder', 'specName', 'value'],
                ['1', '6128', 'P1', 'Brand', 'A230', 'S', '2', 'Chest', '34'],
                ['2', '6128', 'P2', 'Brand', 'A230', 'M', '3', 'Chest', '36'],
                ['3', '6129', 'P3', 'Brand', 'B500', 'L', '4', 'Body Length', '29'],
              ],
            },
          }),
        },
      },
    };

    const result = await readSpecSheetStructured(mockSheets as never, 'spreadsheet-id');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.has('A230')).toBe(true);
    expect(result.has('B500')).toBe(true);

    const a230Specs = result.get('A230')!;
    expect(a230Specs).toHaveLength(2);
    expect(a230Specs[0]).toEqual({ sizeName: 'S', specName: 'Chest', value: '34' });
    expect(a230Specs[1]).toEqual({ sizeName: 'M', specName: 'Chest', value: '36' });
  });

  it('sorts by sizeOrder when present', async () => {
    const mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ['styleName', 'sizeName', 'sizeOrder', 'specName', 'value'],
                // XL comes before S in sheet, but sizeOrder should reorder them
                ['A230', 'XL', '5', 'Chest', '42'],
                ['A230', 'S', '2', 'Chest', '34'],
                ['A230', 'M', '3', 'Chest', '36'],
              ],
            },
          }),
        },
      },
    };

    const result = await readSpecSheetStructured(mockSheets as never, 'spreadsheet-id');
    const specs = result.get('A230')!;

    // Should be sorted: S (order 2), M (order 3), XL (order 5)
    expect(specs[0].sizeName).toBe('S');
    expect(specs[1].sizeName).toBe('M');
    expect(specs[2].sizeName).toBe('XL');
  });

  it('falls back to standard size order when sizeOrder column is missing', async () => {
    const mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ['styleName', 'sizeName', 'specName', 'value'],
                // XL before S, M — no sizeOrder column
                ['A230', 'XL', 'Chest', '42'],
                ['A230', 'S', 'Chest', '34'],
                ['A230', 'M', 'Chest', '36'],
              ],
            },
          }),
        },
      },
    };

    const result = await readSpecSheetStructured(mockSheets as never, 'spreadsheet-id');
    const specs = result.get('A230')!;

    // Should be sorted by standard order: S, M, XL
    expect(specs[0].sizeName).toBe('S');
    expect(specs[1].sizeName).toBe('M');
    expect(specs[2].sizeName).toBe('XL');
  });

  it('returns empty Map when sheet has header row only (no data)', async () => {
    const mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ['styleName', 'sizeName', 'specName', 'value'],
              ],
            },
          }),
        },
      },
    };

    const result = await readSpecSheetStructured(mockSheets as never, 'spreadsheet-id');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns empty Map when values is null/undefined', async () => {
    const mockSheets = {
      spreadsheets: {
        values: {
          get: vi.fn().mockResolvedValue({
            data: { values: null },
          }),
        },
      },
    };

    const result = await readSpecSheetStructured(mockSheets as never, 'spreadsheet-id');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

// --- buildSizeGuideMetaobjectFields tests ---

describe('buildSizeGuideMetaobjectFields', () => {
  it('encodes sizes as JSON string array', () => {
    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S', 'M'],
      variables: [{ label: 'Chest', values: [34, 36] }],
      title: 'A230 Size Guide',
    });

    const sizesField = fields.find(f => f.key === 'sizes');
    expect(sizesField).toBeDefined();
    expect(sizesField!.value).toBe(JSON.stringify(['S', 'M']));
  });

  it('encodes variable values as list of {value, unit} objects', () => {
    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S', 'M'],
      variables: [{ label: 'Chest', values: [34, 36] }],
      title: 'A230 Size Guide',
    });

    const valuesField = fields.find(f => f.key === 'variable_1_values');
    expect(valuesField).toBeDefined();
    expect(valuesField!.value).toBe(
      JSON.stringify([{ value: 34, unit: 'in' }, { value: 36, unit: 'in' }])
    );
  });

  it('includes empty rich text for description field', () => {
    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S', 'M'],
      variables: [],
      title: 'A230 Size Guide',
    });

    const descField = fields.find(f => f.key === 'description');
    expect(descField).toBeDefined();
    const parsed = JSON.parse(descField!.value);
    expect(parsed.type).toBe('root');
    expect(parsed.children[0].type).toBe('paragraph');
    expect(parsed.children[0].children[0].type).toBe('text');
    expect(parsed.children[0].children[0].value).toBe('');
  });

  it('includes title field', () => {
    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S', 'M'],
      variables: [],
      title: 'A230 Size Guide',
    });

    const titleField = fields.find(f => f.key === 'title');
    expect(titleField).toBeDefined();
    expect(titleField!.value).toBe('A230 Size Guide');
  });

  it('includes only first 5 variables and logs warning if >5', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S'],
      variables: [
        { label: 'Chest', values: [34] },
        { label: 'Waist', values: [28] },
        { label: 'Hip', values: [36] },
        { label: 'Inseam', values: [30] },
        { label: 'Shoulder', values: [16] },
        { label: 'Sleeve', values: [24] }, // 6th — should be excluded
      ],
      title: 'Test',
    });

    // Should have: title, description, sizes, then 5 label+values pairs = 5*2 = 10 variable fields
    const variableLabelFields = fields.filter(f => f.key.startsWith('variable_') && f.key.endsWith('_label'));
    expect(variableLabelFields).toHaveLength(5);

    // The 6th variable should NOT be present
    const var6 = fields.find(f => f.key === 'variable_6_label');
    expect(var6).toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns correct field structure for 2 sizes and 2 variables', () => {
    const fields = buildSizeGuideMetaobjectFields({
      sizes: ['S', 'M'],
      variables: [
        { label: 'Chest', values: [34, 36] },
        { label: 'Waist', values: [28, 30] },
      ],
      title: 'A230 Size Guide',
    });

    // Check label fields
    const var1Label = fields.find(f => f.key === 'variable_1_label');
    expect(var1Label!.value).toBe('Chest');
    const var2Label = fields.find(f => f.key === 'variable_2_label');
    expect(var2Label!.value).toBe('Waist');

    // Check values fields
    const var1Values = fields.find(f => f.key === 'variable_1_values');
    expect(var1Values!.value).toBe(
      JSON.stringify([{ value: 34, unit: 'in' }, { value: 36, unit: 'in' }])
    );
    const var2Values = fields.find(f => f.key === 'variable_2_values');
    expect(var2Values!.value).toBe(
      JSON.stringify([{ value: 28, unit: 'in' }, { value: 30, unit: 'in' }])
    );
  });
});

// --- transformSpecsToSizeGuide tests ---

describe('transformSpecsToSizeGuide', () => {
  it('groups specs correctly into SizeGuideFields', () => {
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest', value: '34' },
      { sizeName: 'S', specName: 'Body Length', value: '28' },
      { sizeName: 'M', specName: 'Chest', value: '36' },
      { sizeName: 'M', specName: 'Body Length', value: '29' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);

    expect(guide.title).toBe('Style A230 Size Guide');
    expect(guide.sizes).toEqual(['S', 'M']);
    expect(guide.variables).toHaveLength(2);

    const chestVar = guide.variables.find(v => v.label === 'Chest');
    expect(chestVar).toBeDefined();
    expect(chestVar!.values).toEqual([34, 36]);

    const bodyLengthVar = guide.variables.find(v => v.label === 'Body Length');
    expect(bodyLengthVar).toBeDefined();
    expect(bodyLengthVar!.values).toEqual([28, 29]);
  });

  it('parses value strings to floats', () => {
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest', value: '34.5' },
      { sizeName: 'M', specName: 'Chest', value: '36.25' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);
    expect(guide.variables[0].values[0]).toBe(34.5);
    expect(guide.variables[0].values[1]).toBe(36.25);
  });

  it('parses fractional values like "24 1/2" to 24.5', () => {
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest', value: '17 1/2' },
      { sizeName: 'M', specName: 'Chest', value: '19 1/2' },
      { sizeName: 'S', specName: 'Body Length', value: '24 1/2' },
      { sizeName: 'M', specName: 'Body Length', value: '25' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);
    const chestVar = guide.variables.find(v => v.label === 'Chest')!;
    expect(chestVar.values).toEqual([17.5, 19.5]);
    const bodyVar = guide.variables.find(v => v.label === 'Body Length')!;
    expect(bodyVar.values).toEqual([24.5, 25]);
  });

  it('filters out non-numeric specs like tolerance values', () => {
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest Width', value: '17 1/2' },
      { sizeName: 'S', specName: 'Chest Tolerance', value: '+/- 1/2' },
      { sizeName: 'S', specName: 'Body Length', value: '24 1/2' },
      { sizeName: 'S', specName: 'Body Length Tolerance', value: '+/- 3/4' },
      { sizeName: 'M', specName: 'Chest Width', value: '19 1/2' },
      { sizeName: 'M', specName: 'Chest Tolerance', value: '+/- 1/2' },
      { sizeName: 'M', specName: 'Body Length', value: '25' },
      { sizeName: 'M', specName: 'Body Length Tolerance', value: '+/- 3/4' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);
    // Tolerance specs should be filtered out
    expect(guide.variables).toHaveLength(2);
    expect(guide.variables.map(v => v.label)).toEqual(['Chest Width', 'Body Length']);
    expect(guide.variables[0].values).toEqual([17.5, 19.5]);
    expect(guide.variables[1].values).toEqual([24.5, 25]);
  });

  it('preserves size order from input specs (caller is responsible for ordering)', () => {
    // Input is already sorted (S, M, L) — function should preserve this order
    const specs: SizeSpec[] = [
      { sizeName: 'S', specName: 'Chest', value: '34' },
      { sizeName: 'M', specName: 'Chest', value: '36' },
      { sizeName: 'L', specName: 'Chest', value: '38' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);
    expect(guide.sizes).toEqual(['S', 'M', 'L']);
    expect(guide.variables[0].values).toEqual([34, 36, 38]);
  });

  it('handles sizes in non-standard order from specs (values parallel to sizes)', () => {
    // Input has XL before S — values must be parallel to sizes
    const specs: SizeSpec[] = [
      { sizeName: 'XL', specName: 'Chest', value: '42' },
      { sizeName: 'S', specName: 'Chest', value: '34' },
    ];

    const guide = transformSpecsToSizeGuide('A230', 'Style A230', specs);
    // Sizes in order of first appearance
    expect(guide.sizes).toEqual(['XL', 'S']);
    // Values parallel: XL=42, S=34
    expect(guide.variables[0].values).toEqual([42, 34]);
  });
});

// --- linkSizeGuideToProduct tests ---

describe('linkSizeGuideToProduct', () => {
  it('calls METAFIELDS_SET with correct metafield input', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          metafieldsSet: {
            metafields: [{ id: 'gid://shopify/Metafield/1' }],
            userErrors: [],
          },
        },
      }),
    };

    await linkSizeGuideToProduct(
      mockClient,
      'gid://shopify/Product/123',
      'gid://shopify/Metaobject/456'
    );

    expect(mockClient.request).toHaveBeenCalledTimes(1);
    const callArgs = mockClient.request.mock.calls[0];
    const variables = callArgs[1].variables;

    expect(variables.metafields).toHaveLength(1);
    const mf = variables.metafields[0];
    expect(mf.ownerId).toBe('gid://shopify/Product/123');
    expect(mf.namespace).toBe('custom');
    expect(mf.key).toBe('size_guide');
    expect(mf.type).toBe('metaobject_reference');
    // Value is raw GID string, NOT JSON array
    expect(mf.value).toBe('gid://shopify/Metaobject/456');
  });

  it('throws on userErrors', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          metafieldsSet: {
            metafields: null,
            userErrors: [{ message: 'Invalid metaobject reference' }],
          },
        },
      }),
    };

    await expect(
      linkSizeGuideToProduct(
        mockClient,
        'gid://shopify/Product/123',
        'gid://shopify/Metaobject/456'
      )
    ).rejects.toThrow('Invalid metaobject reference');
  });
});
