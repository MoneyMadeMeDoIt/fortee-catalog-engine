/**
 * Unit tests for audit-images.ts CLI — argument handling and dispatch logic.
 *
 * Mocks all external dependencies (readAllRows, auditProductImages, clients)
 * and tests the runAudit() function with injected deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditResult } from '../../src/lib/audit-runner.js';
import type { SheetRow } from '../../src/sheets/types.js';

// We import runAudit from the CLI script — it exports a testable function
// with dependency injection.
import { runAudit } from '../../scripts/audit-images.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(styleID: string, colorName: string): SheetRow {
  return {
    supplierCode: 'CSW',
    PartID: '1',
    styleID,
    partNumber: 'PN-1',
    brandName: 'Test',
    productId: 'P1',
    colorName,
    colorFamily: 'Black',
    productName: `${styleID} ${colorName}`,
    description: 'Test product',
    FrontImage: '',
    BackImage: '',
    DirectSideImage: '',
    col14Empty: '',
    color1: '#000',
    color2: '',
    sizeName: 'S',
    sizePriceCodeName: 'S',
    costPrice: '10',
    CaseQty: '1',
    unitWeight: '1',
    Qty: '1',
    CaseWeight: '1',
    BoxHeight: '1',
    BoxLength: '1',
    BoxWidth: '1',
    baseCategory: 'T-Shirt',
    weightGSM: '200',
    gender: 'Unisex',
    fit: 'Regular',
    keywords: '',
    categories: '',
    careInstructions: '',
    sizeChart: '',
    embroideryAvailable: 'true',
    dtfAvailable: 'true',
    sellPrice1Area: '30',
    sellPrice2Area: '35',
    decorationPlacements: '',
  } as SheetRow;
}

function makeAuditResult(styleId: string, colorName: string): AuditResult {
  return {
    styleId,
    colorName,
    views: [
      { view: 'front', status: 'pass-existing', score: 85, cdnUrl: 'https://drive.google.com/uc?id=f1' },
      { view: 'back', status: 'generated', score: 72, cdnUrl: 'https://drive.google.com/uc?id=b1' },
      { view: 'side', status: 'sourced', score: 90, cdnUrl: 'https://drive.google.com/uc?id=s1' },
    ],
    cellsWritten: 2,
    aiCostIncurred: 0.05,
  };
}

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const fakeRows: SheetRow[] = [
  makeRow('CSW-100', 'Black'),
  makeRow('CSW-100', 'White'),
  makeRow('CSW-200', 'Red'),
];

let mockReadAllRows: ReturnType<typeof vi.fn>;
let mockAuditFn: ReturnType<typeof vi.fn>;
let mockDriveClient: unknown;
let mockSheetsClient: unknown;
let mockCostTracker: { total: number; remaining: number };
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockReadAllRows = vi.fn().mockResolvedValue({ headers: ['styleID'], rows: fakeRows });
  mockAuditFn = vi.fn().mockImplementation(async (row: SheetRow) =>
    makeAuditResult(row.styleID, row.colorName),
  );
  mockDriveClient = {};
  mockSheetsClient = {};
  mockCostTracker = { total: 0.15, remaining: 199.85 };
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit-images CLI — runAudit()', () => {
  it('Test 1: --style-id matching a row calls auditProductImages once with that row and correct 0-based index', async () => {
    const rows = [makeRow('CSW-200', 'Red')];
    mockReadAllRows.mockResolvedValue({ headers: ['styleID'], rows });

    await runAudit({
      args: { styleId: 'CSW-200', all: false, dryRun: false, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    expect(mockAuditFn).toHaveBeenCalledTimes(1);
    // Row index should be 0 (first row in data array)
    expect(mockAuditFn).toHaveBeenCalledWith(
      rows[0], 0,
      mockDriveClient, mockSheetsClient,
      'test-id', 'Sheet1', mockCostTracker,
    );
  });

  it('Test 2: --style-id matching multiple rows calls auditProductImages for each matching row', async () => {
    await runAudit({
      args: { styleId: 'CSW-100', all: false, dryRun: false, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    expect(mockAuditFn).toHaveBeenCalledTimes(2);
    // First call: row 0 (CSW-100 Black)
    expect(mockAuditFn).toHaveBeenCalledWith(
      fakeRows[0], 0,
      mockDriveClient, mockSheetsClient,
      'test-id', 'Sheet1', mockCostTracker,
    );
    // Second call: row 1 (CSW-100 White)
    expect(mockAuditFn).toHaveBeenCalledWith(
      fakeRows[1], 1,
      mockDriveClient, mockSheetsClient,
      'test-id', 'Sheet1', mockCostTracker,
    );
  });

  it('Test 3: --all calls auditProductImages for every row returned by readAllRows', async () => {
    await runAudit({
      args: { styleId: undefined, all: true, dryRun: false, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    expect(mockAuditFn).toHaveBeenCalledTimes(3);
    expect(mockAuditFn).toHaveBeenCalledWith(fakeRows[0], 0, mockDriveClient, mockSheetsClient, 'test-id', 'Sheet1', mockCostTracker);
    expect(mockAuditFn).toHaveBeenCalledWith(fakeRows[1], 1, mockDriveClient, mockSheetsClient, 'test-id', 'Sheet1', mockCostTracker);
    expect(mockAuditFn).toHaveBeenCalledWith(fakeRows[2], 2, mockDriveClient, mockSheetsClient, 'test-id', 'Sheet1', mockCostTracker);
  });

  it('Test 4: --dry-run --all does NOT call auditProductImages; logs product list', async () => {
    await runAudit({
      args: { styleId: undefined, all: true, dryRun: true, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    expect(mockAuditFn).not.toHaveBeenCalled();
    // Should log product info
    const logCalls = consoleSpy.mock.calls.map(c => c[0]);
    const joined = logCalls.join('\n');
    expect(joined).toContain('CSW-100');
    expect(joined).toContain('CSW-200');
  });

  it('Test 5: neither --style-id nor --all throws with error message', async () => {
    await expect(
      runAudit({
        args: { styleId: undefined, all: false, dryRun: false, help: false },
        driveClient: mockDriveClient,
        sheetsClient: mockSheetsClient,
        readAllRowsFn: mockReadAllRows,
        auditFn: mockAuditFn,
        costTracker: mockCostTracker as any,
        spreadsheetId: 'test-id',
        sheetName: 'Sheet1',
      }),
    ).rejects.toThrow(/--style-id.*--all|--all.*--style-id/i);
  });

  it('Test 6: --style-id for an unknown ID throws with error', async () => {
    await expect(
      runAudit({
        args: { styleId: 'UNKNOWN-999', all: false, dryRun: false, help: false },
        driveClient: mockDriveClient,
        sheetsClient: mockSheetsClient,
        readAllRowsFn: mockReadAllRows,
        auditFn: mockAuditFn,
        costTracker: mockCostTracker as any,
        spreadsheetId: 'test-id',
        sheetName: 'Sheet1',
      }),
    ).rejects.toThrow(/UNKNOWN-999/);
  });

  it('Test 7: a single CostTracker is passed to every auditProductImages call (same reference)', async () => {
    await runAudit({
      args: { styleId: undefined, all: true, dryRun: false, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    // All 3 calls receive the exact same CostTracker reference
    const trackerArgs = mockAuditFn.mock.calls.map((c: unknown[]) => c[6]);
    expect(trackerArgs[0]).toBe(mockCostTracker);
    expect(trackerArgs[1]).toBe(mockCostTracker);
    expect(trackerArgs[2]).toBe(mockCostTracker);
  });

  it('Test 8: after processing, summary includes total products, errors count, AI cost', async () => {
    // Make the third call return an error result
    mockAuditFn
      .mockResolvedValueOnce(makeAuditResult('CSW-100', 'Black'))
      .mockResolvedValueOnce(makeAuditResult('CSW-100', 'White'))
      .mockResolvedValueOnce({
        ...makeAuditResult('CSW-200', 'Red'),
        error: 'something broke',
      });

    await runAudit({
      args: { styleId: undefined, all: true, dryRun: false, help: false },
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      readAllRowsFn: mockReadAllRows,
      auditFn: mockAuditFn,
      costTracker: mockCostTracker as any,
      spreadsheetId: 'test-id',
      sheetName: 'Sheet1',
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    const summaryText = logCalls.join('\n');
    // Summary should mention 3 products
    expect(summaryText).toMatch(/3/);
    // Summary should mention 1 error
    expect(summaryText).toMatch(/1.*error|error.*1/i);
    // Summary should mention AI cost
    expect(summaryText).toMatch(/cost|budget/i);
  });
});
