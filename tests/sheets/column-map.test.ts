import { describe, it, expect } from 'vitest';
import { columnToLetter, FIELD_MAPPING, SUPPLIER_CODE_MAP } from '../../src/sheets/column-map.js';
import { SHEET_COLUMNS } from '../../src/sheets/types.js';

describe('columnToLetter', () => {
  it('converts 0 to A', () => {
    expect(columnToLetter(0)).toBe('A');
  });

  it('converts 25 to Z', () => {
    expect(columnToLetter(25)).toBe('Z');
  });

  it('converts 26 to AA', () => {
    expect(columnToLetter(26)).toBe('AA');
  });

  it('converts 51 to AZ', () => {
    expect(columnToLetter(51)).toBe('AZ');
  });

  it('converts 52 to BA', () => {
    expect(columnToLetter(52)).toBe('BA');
  });
});

describe('SHEET_COLUMNS', () => {
  it('has exactly 38 entries matching the master sheet columns', () => {
    expect(SHEET_COLUMNS).toHaveLength(38);
  });
});

describe('SUPPLIER_CODE_MAP', () => {
  it('maps CANADASPORTSWEAR to canada-sportswear', () => {
    expect(SUPPLIER_CODE_MAP.CANADASPORTSWEAR).toBe('canada-sportswear');
  });

  it('maps SSCANADA to ss-canada', () => {
    expect(SUPPLIER_CODE_MAP.SSCANADA).toBe('ss-canada');
  });
});

describe('FIELD_MAPPING', () => {
  it('contains FrontImage mapping', () => {
    expect(FIELD_MAPPING).toHaveProperty('FrontImage');
  });

  it('contains BackImage mapping', () => {
    expect(FIELD_MAPPING).toHaveProperty('BackImage');
  });

  it('contains description mapping', () => {
    expect(FIELD_MAPPING).toHaveProperty('description');
  });

  it('contains sizeChart mapping', () => {
    expect(FIELD_MAPPING).toHaveProperty('sizeChart');
  });

  it('contains careInstructions mapping', () => {
    expect(FIELD_MAPPING).toHaveProperty('careInstructions');
  });
});
