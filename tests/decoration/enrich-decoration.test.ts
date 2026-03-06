import { describe, it, expect } from 'vitest';
import type { SheetRow } from '../../src/sheets/types.js';
import { SHEET_COLUMNS } from '../../src/sheets/types.js';

function makeEmptyRow(overrides: Partial<SheetRow> = {}): SheetRow {
  const row: Record<string, string> = {};
  for (const col of SHEET_COLUMNS) {
    row[col] = '';
  }
  return { ...row, ...overrides } as unknown as SheetRow;
}

describe('decoration pricing formulas', () => {
  function calc1Area(cost: number): number {
    return cost * 2 + 10;
  }
  function calc2Area(cost: number): number {
    return cost * 2 + 16;
  }

  it('1 area: cost*2+10', () => {
    expect(calc1Area(7.80)).toBeCloseTo(25.60);
    expect(calc1Area(10)).toBe(30);
    expect(calc1Area(0)).toBe(10);
  });

  it('2 areas: cost*2+16', () => {
    expect(calc2Area(7.80)).toBeCloseTo(31.60);
    expect(calc2Area(10)).toBe(36);
    expect(calc2Area(0)).toBe(16);
  });

  it('2 area price is always $6 more than 1 area price', () => {
    for (const cost of [5, 7.80, 10, 15, 20]) {
      expect(calc2Area(cost) - calc1Area(cost)).toBe(6);
    }
  });
});

describe('decoration enrichment data model', () => {
  it('SheetRow has sellPrice1Area and sellPrice2Area fields', () => {
    const row = makeEmptyRow();
    expect(row).toHaveProperty('sellPrice1Area');
    expect(row).toHaveProperty('sellPrice2Area');
  });

  it('SheetRow has decorationPlacements field', () => {
    const row = makeEmptyRow();
    expect(row).toHaveProperty('decorationPlacements');
  });

  it('SheetRow has embroideryAvailable and dtfAvailable fields', () => {
    const row = makeEmptyRow();
    expect(row).toHaveProperty('embroideryAvailable');
    expect(row).toHaveProperty('dtfAvailable');
  });

  it('SHEET_COLUMNS includes new price columns', () => {
    expect(SHEET_COLUMNS).toContain('sellPrice1Area');
    expect(SHEET_COLUMNS).toContain('sellPrice2Area');
  });

  it('SHEET_COLUMNS does not include old sellPrice column', () => {
    expect(SHEET_COLUMNS).not.toContain('sellPrice');
  });
});
