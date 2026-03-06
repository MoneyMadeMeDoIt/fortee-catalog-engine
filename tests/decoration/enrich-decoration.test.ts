import { describe, it, expect } from 'vitest';
import { formatPlacements, buildDecorationUpdates } from '../../src/sheets/enrich-decoration.js';
import type { DecorationPlacement } from '../../src/decoration/types.js';
import type { SheetRow } from '../../src/sheets/types.js';
import { SHEET_COLUMNS } from '../../src/sheets/types.js';

function makeEmptyRow(overrides: Partial<SheetRow> = {}): SheetRow {
  const row: Record<string, string> = {};
  for (const col of SHEET_COLUMNS) {
    row[col] = '';
  }
  return { ...row, ...overrides } as unknown as SheetRow;
}

const HEADERS = [...SHEET_COLUMNS] as string[];

describe('formatPlacements', () => {
  it('groups placements by method with semicolon separator', () => {
    const placements: DecorationPlacement[] = [
      {
        method: 'Print',
        bodyCategory: 'Front',
        placementName: 'Left Chest',
        commonSizes: '3.5x3.5',
        maxSize: '4.5x4.5',
        verticalRef: '',
        horizontalRef: '',
        notes: '',
      },
      {
        method: 'Print',
        bodyCategory: 'Front',
        placementName: 'Full Front',
        commonSizes: '12x14',
        maxSize: '14x19',
        verticalRef: '',
        horizontalRef: '',
        notes: '',
      },
      {
        method: 'Embroidery',
        bodyCategory: 'Front',
        placementName: 'Left Chest',
        commonSizes: '3.5x3.5',
        maxSize: '4.5x4.5',
        verticalRef: '',
        horizontalRef: '',
        notes: '',
      },
    ];

    const result = formatPlacements(placements);
    expect(result).toBe('Print: Left Chest, Full Front; Embroidery: Left Chest');
  });

  it('returns single method without semicolon', () => {
    const placements: DecorationPlacement[] = [
      {
        method: 'Print',
        bodyCategory: 'Headwear',
        placementName: 'Cap Front Panel',
        commonSizes: '',
        maxSize: '',
        verticalRef: '',
        horizontalRef: '',
        notes: '',
      },
    ];

    expect(formatPlacements(placements)).toBe('Print: Cap Front Panel');
  });

  it('returns empty string for no placements', () => {
    expect(formatPlacements([])).toBe('');
  });
});

describe('buildDecorationUpdates', () => {
  it('builds updates for empty cells only (fill-gaps-only)', () => {
    const row = makeEmptyRow({ baseCategory: 'T-Shirt' });
    const data = {
      embroideryAvailable: 'Yes',
      dtfAvailable: 'Yes',
      sellPrice: '25.00',
      decorationPlacements: 'Print: Left Chest',
    };

    const updates = buildDecorationUpdates(row, data, HEADERS, 0, 'Sheet1');

    expect(updates.length).toBe(4);
    // Check that all fields got updates
    const ranges = updates.map((u) => u.range);
    expect(ranges.some((r) => r.includes('Sheet1!'))).toBe(true);
  });

  it('skips cells that already have data', () => {
    const row = makeEmptyRow({
      embroideryAvailable: 'Yes',
      dtfAvailable: 'No',
    });
    const data = {
      embroideryAvailable: 'Yes',
      dtfAvailable: 'Yes',
      sellPrice: '25.00',
      decorationPlacements: 'Print: Left Chest',
    };

    const updates = buildDecorationUpdates(row, data, HEADERS, 0, 'Sheet1');

    // embroideryAvailable and dtfAvailable already have values, so only 2 updates
    expect(updates.length).toBe(2);
    const fields = updates.map((u) => u.values[0][0]);
    expect(fields).toContain('25.00');
    expect(fields).toContain('Print: Left Chest');
  });

  it('returns empty array when all cells already populated', () => {
    const row = makeEmptyRow({
      embroideryAvailable: 'Yes',
      dtfAvailable: 'Yes',
      sellPrice: '30.00',
      decorationPlacements: 'Print: Full Front',
    });
    const data = {
      embroideryAvailable: 'Yes',
      dtfAvailable: 'Yes',
      sellPrice: '25.00',
      decorationPlacements: 'Print: Left Chest',
    };

    const updates = buildDecorationUpdates(row, data, HEADERS, 0, 'Sheet1');
    expect(updates.length).toBe(0);
  });

  it('computes correct sheet row number (rowIndex 0 = row 2)', () => {
    const row = makeEmptyRow();
    const data = { sellPrice: '10.00' };
    const updates = buildDecorationUpdates(row, data, HEADERS, 5, 'Products');

    expect(updates.length).toBe(1);
    // Row index 5 = sheet row 7 (5 + 2)
    expect(updates[0].range).toMatch(/Products!.*7$/);
  });
});

describe('decoration enrichment integration', () => {
  it('resolves T-Shirt category and gets correct availability', async () => {
    const { resolveCategory, getDecorationRulesForCategory } = await import(
      '../../src/decoration/index.js'
    );

    const category = resolveCategory('T-Shirt');
    expect(category).toBe('T-Shirt');

    const placements = getDecorationRulesForCategory(category!);
    const hasPrint = placements.some((p: DecorationPlacement) => p.method === 'Print');
    const hasEmbroidery = placements.some((p: DecorationPlacement) => p.method === 'Embroidery');

    expect(hasPrint).toBe(true);
    expect(hasEmbroidery).toBe(true);
  });

  it('returns null for unknown category', async () => {
    const { resolveCategory } = await import('../../src/decoration/index.js');
    expect(resolveCategory('Unknown Widget')).toBeNull();
  });

  it('calculates sell price correctly for a product', async () => {
    const { calculateSellPrice } = await import('../../src/decoration/index.js');

    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });

    // MSRP = 10 * 2 = 20, Print = $10, Total = 30, Discount = 13.5, Sell = 16.50
    expect(result.sellPrice).toBe(16.5);
  });
});
