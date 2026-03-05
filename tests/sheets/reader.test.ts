import { describe, it, expect, vi } from 'vitest';
import { readAllRows } from '../../src/sheets/reader.js';
import { SHEET_COLUMNS } from '../../src/sheets/types.js';
import type { sheets_v4 } from 'googleapis';

function createMockSheets(values: string[][] | undefined): sheets_v4.Sheets {
  return {
    spreadsheets: {
      values: {
        get: vi.fn().mockResolvedValue({
          data: { values },
        }),
      },
    },
  } as unknown as sheets_v4.Sheets;
}

/** Build a full row of 36 values for testing. */
function buildFullRow(prefix: string): string[] {
  return SHEET_COLUMNS.map((col, i) => `${prefix}-${col}-${i}`);
}

describe('readAllRows', () => {
  it('returns headers and SheetRow objects for valid data', async () => {
    const headers = [...SHEET_COLUMNS];
    const row1 = buildFullRow('r1');
    const row2 = buildFullRow('r2');

    const sheets = createMockSheets([headers as string[], row1, row2]);
    const result = await readAllRows(sheets, 'test-spreadsheet-id');

    expect(result.headers).toEqual(headers);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].supplierCode).toBe('r1-supplierCode-0');
    expect(result.rows[1].PartID).toBe('r2-PartID-1');
  });

  it('pads ragged rows with empty strings', async () => {
    const headers = [...SHEET_COLUMNS];
    // Only 30 values instead of 36
    const raggedRow = buildFullRow('r1').slice(0, 30);

    const sheets = createMockSheets([headers as string[], raggedRow]);
    const result = await readAllRows(sheets, 'test-spreadsheet-id');

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    // First 30 fields should have values
    expect(row.supplierCode).toBe('r1-supplierCode-0');
    // Fields 31-36 (0-indexed 30-35) should be empty strings
    expect(row.keywords).toBe('');
    expect(row.categories).toBe('');
    expect(row.careInstructions).toBe('');
    expect(row.sizeChart).toBe('');
    expect(row.embroideryAvailable).toBe('');
    expect(row.dtfAvailable).toBe('');
  });

  it('throws when sheet is empty (no values)', async () => {
    const sheets = createMockSheets(undefined);
    await expect(readAllRows(sheets, 'test-id')).rejects.toThrow('Sheet has no data');
  });

  it('throws when sheet has only a header row', async () => {
    const headers = [...SHEET_COLUMNS];
    const sheets = createMockSheets([headers as string[]]);
    await expect(readAllRows(sheets, 'test-id')).rejects.toThrow('Sheet has no data rows');
  });

  it('correctly maps PartID from column position', async () => {
    const headers = [...SHEET_COLUMNS];
    const row = buildFullRow('test');

    const sheets = createMockSheets([headers as string[], row]);
    const result = await readAllRows(sheets, 'test-id');

    // PartID is the 2nd column (index 1)
    expect(result.rows[0].PartID).toBe('test-PartID-1');
  });

  it('uses provided sheetName parameter', async () => {
    const headers = [...SHEET_COLUMNS];
    const row = buildFullRow('r1');
    const sheets = createMockSheets([headers as string[], row]);

    await readAllRows(sheets, 'test-id', 'CustomTab');

    const getMock = sheets.spreadsheets.values.get as ReturnType<typeof vi.fn>;
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'CustomTab' })
    );
  });
});
