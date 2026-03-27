/**
 * Integration tests for auditProductImages() orchestrator (Phase 12).
 *
 * All external module dependencies are mocked. Tests verify:
 * - Correct pipeline branching (score → source → generate/enhance → standardize → write)
 * - Per-view status codes in AuditResult
 * - Which mocks were/were not called under each scenario
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditProductImages } from '../../src/lib/audit-runner.js';
import { CostTracker } from '../../src/lib/cost-tracker.js';
import type { SheetRow } from '../../src/sheets/types.js';
import type { sheets_v4, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Module mocks — must use .js extensions (ESM convention)
// ---------------------------------------------------------------------------

vi.mock('../../src/shopify/image-scorer.js', () => ({
  scoreImageQuality: vi.fn(),
}));

vi.mock('../../src/lib/image-sourcer.js', () => ({
  sourceImages: vi.fn(),
}));

vi.mock('../../src/lib/ai-image-generator.js', () => ({
  generateGarmentView: vi.fn(),
  enhanceFrontImage: vi.fn(),
}));

vi.mock('../../src/shopify/image-standardizer.js', () => ({
  standardizeImage: vi.fn(),
  buildStandardizationUpdates: vi.fn(),
  downloadImage: vi.fn(),
}));

vi.mock('../../src/sheets/drive.js', () => ({
  uploadToDrive: vi.fn(),
}));

vi.mock('../../src/sheets/writer.js', () => ({
  writeUpdates: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked functions
// ---------------------------------------------------------------------------

import { scoreImageQuality } from '../../src/shopify/image-scorer.js';
import { sourceImages } from '../../src/lib/image-sourcer.js';
import { generateGarmentView, enhanceFrontImage } from '../../src/lib/ai-image-generator.js';
import {
  standardizeImage,
  buildStandardizationUpdates,
  downloadImage,
} from '../../src/shopify/image-standardizer.js';
import { uploadToDrive } from '../../src/sheets/drive.js';
import { writeUpdates } from '../../src/sheets/writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a SheetRow with sensible defaults for testing. */
function makeRow(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    supplierCode: 'CSW',
    PartID: 'CSW-TEST-BLK',
    styleID: 'CSW-TEST',
    partNumber: 'CSW-TEST-S',
    brandName: 'Canada Sportswear',
    productId: '',
    colorName: 'Black',
    colorFamily: 'Black',
    productName: 'Test T-Shirt',
    description: 'A test t-shirt',
    FrontImage: 'https://example.com/front.jpg',
    BackImage: 'https://example.com/back.jpg',
    DirectSideImage: 'https://example.com/side.jpg',
    col14Empty: '',
    color1: '#000000',
    color2: '',
    sizeName: 'S',
    sizePriceCodeName: 'S',
    costPrice: '10.00',
    CaseQty: '12',
    unitWeight: '0.3',
    Qty: '100',
    CaseWeight: '3.6',
    BoxHeight: '10',
    BoxLength: '20',
    BoxWidth: '15',
    baseCategory: 't-shirts',
    weightGSM: '180',
    gender: 'Unisex',
    fit: 'Regular',
    keywords: 'test',
    categories: 'T-Shirts',
    careInstructions: 'Machine wash',
    sizeChart: '',
    embroideryAvailable: 'yes',
    dtfAvailable: 'yes',
    sellPrice1Area: '25.00',
    sellPrice2Area: '30.00',
    decorationPlacements: 'Front Print,Back Print',
    ...overrides,
  };
}

/** Default mock factories */
const mockDriveClient = {} as drive_v3.Drive;

const mockSheetsClient = {} as sheets_v4.Sheets;
const SPREADSHEET_ID = 'test-spreadsheet-id';
const SHEET_NAME = 'Products';

const FAKE_BUFFER = Buffer.from('fake-image-data');
const FAKE_STD_BUFFER = Buffer.from('std-image-data');
const FAKE_CDN_URL = 'https://drive.google.com/uc?id=fake-file-id';
const FAKE_UPDATES = [{ range: 'Products!K2', values: [['url']] }];

/** Default mock return values — applied in beforeEach */
function setupDefaultMocks() {
  vi.mocked(downloadImage).mockResolvedValue(FAKE_BUFFER);
  vi.mocked(scoreImageQuality).mockResolvedValue({
    score: 85,
    verdict: 'pass',
    reasons: [],
    dimensions: { blur: 90, resolution: 80, proportion: 85, content: 85 },
  });
  vi.mocked(sourceImages).mockResolvedValue({
    front: null,
    back: null,
    side: null,
  });
  vi.mocked(generateGarmentView).mockResolvedValue(null);
  vi.mocked(enhanceFrontImage).mockResolvedValue(null);
  vi.mocked(standardizeImage).mockResolvedValue({
    buffer: FAKE_STD_BUFFER,
    garmentPlacement: { left: 0, top: 150, width: 2000, height: 1700 },
  });
  vi.mocked(uploadToDrive).mockResolvedValue(FAKE_CDN_URL);
  vi.mocked(buildStandardizationUpdates).mockReturnValue(FAKE_UPDATES);
  vi.mocked(writeUpdates).mockResolvedValue(3);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditProductImages', () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    vi.resetAllMocks();  // Clears call history AND queued .once() values
    costTracker = new CostTracker(200);
    setupDefaultMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: All-passing — standardize existing, no sourcing or generation
  // -------------------------------------------------------------------------
  it('Test 1 (all-passing): standardizes existing images without sourcing or generating', async () => {
    const row = makeRow();

    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // sourceImages NOT called — all views passed
    expect(sourceImages).not.toHaveBeenCalled();
    // generateGarmentView NOT called
    expect(generateGarmentView).not.toHaveBeenCalled();
    // enhanceFrontImage NOT called
    expect(enhanceFrontImage).not.toHaveBeenCalled();

    // All 3 views should be 'pass-existing'
    expect(result.views).toHaveLength(3);
    const statuses = result.views.map(v => v.status);
    expect(statuses).toContain('pass-existing');
    expect(statuses.every(s => s === 'pass-existing')).toBe(true);

    // CDN URLs should be set
    result.views.forEach(v => {
      expect(v.cdnUrl).toBe(FAKE_CDN_URL);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Missing back — sourceImages called, back is sourced
  // -------------------------------------------------------------------------
  it('Test 2 (missing-back): sources back view when BackImage is empty', async () => {
    const row = makeRow({ BackImage: '' });

    vi.mocked(sourceImages).mockResolvedValue({
      front: null,
      back: { url: 'https://sourced.example.com/back.jpg', score: 80, verdict: 'pass' },
      side: null,
    });

    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // sourceImages MUST be called (back was missing)
    expect(sourceImages).toHaveBeenCalledWith('CSW-TEST', 'Black');

    // Back view should be 'sourced'
    const backResult = result.views.find(v => v.view === 'back');
    expect(backResult).toBeDefined();
    expect(backResult!.status).toBe('sourced');
    expect(backResult!.cdnUrl).toBe(FAKE_CDN_URL);
  });

  // -------------------------------------------------------------------------
  // Test 3: Failing front — enhanceFrontImage called
  // -------------------------------------------------------------------------
  it('Test 3 (failing-front): calls enhanceFrontImage when front score fails', async () => {
    const row = makeRow();

    // Front fails scoring
    vi.mocked(scoreImageQuality)
      .mockResolvedValueOnce({ score: 30, verdict: 'fail', reasons: ['too blurry'], dimensions: { blur: 10, resolution: 80, proportion: 80, content: 80 } })  // front
      .mockResolvedValue({ score: 85, verdict: 'pass', reasons: [], dimensions: { blur: 90, resolution: 80, proportion: 85, content: 85 } });  // back, side

    // Enhancement succeeds
    const enhancedBuffer = Buffer.from('enhanced-front');
    vi.mocked(enhanceFrontImage).mockResolvedValue({
      buffer: enhancedBuffer,
      score: 88,
      verdict: 'pass',
      cost: 0.042,
    });

    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // enhanceFrontImage MUST be called
    expect(enhanceFrontImage).toHaveBeenCalledWith(FAKE_BUFFER, costTracker, expect.anything());

    // Front view should be 'enhanced'
    const frontResult = result.views.find(v => v.view === 'front');
    expect(frontResult).toBeDefined();
    expect(frontResult!.status).toBe('enhanced');
    expect(frontResult!.cdnUrl).toBe(FAKE_CDN_URL);
  });

  // -------------------------------------------------------------------------
  // Test 4: Missing back + no sourced back → AI generation
  // -------------------------------------------------------------------------
  it('Test 4 (ai-generation): calls generateGarmentView when sourceImages returns null for back', async () => {
    const row = makeRow({ BackImage: '' });

    vi.mocked(sourceImages).mockResolvedValue({
      front: null,
      back: null,  // No sourced back available
      side: null,
    });

    const generatedBuffer = Buffer.from('generated-back');
    vi.mocked(generateGarmentView).mockResolvedValue({
      buffer: generatedBuffer,
      score: 82,
      verdict: 'pass',
      totalCost: 0.126,
      callCount: 1,
      usedRetry: false,
      hueDrift: 5,
    });

    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // generateGarmentView MUST be called for back
    expect(generateGarmentView).toHaveBeenCalledWith(
      FAKE_BUFFER, 'back', expect.anything(), 'Black', costTracker,
    );

    // Back view should be 'generated'
    const backResult = result.views.find(v => v.view === 'back');
    expect(backResult).toBeDefined();
    expect(backResult!.status).toBe('generated');
    expect(backResult!.cdnUrl).toBe(FAKE_CDN_URL);
  });

  // -------------------------------------------------------------------------
  // Test 5: Budget exhausted — generateGarmentView returns null → skipped
  // -------------------------------------------------------------------------
  it('Test 5 (budget-exhausted): status is skipped when generateGarmentView returns null', async () => {
    const row = makeRow({ BackImage: '' });

    vi.mocked(sourceImages).mockResolvedValue({
      front: null,
      back: null,
      side: null,
    });

    // Budget exhausted — returns null
    vi.mocked(generateGarmentView).mockResolvedValue(null);

    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // No throw — function completes
    const backResult = result.views.find(v => v.view === 'back');
    expect(backResult).toBeDefined();
    expect(backResult!.status).toBe('skipped');
    expect(backResult!.cdnUrl).toBeNull();
    expect(backResult!.reason).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: Sheet write — buildStandardizationUpdates and writeUpdates called correctly
  // -------------------------------------------------------------------------
  it('Test 6 (sheet-write): passes correct sheetName, rowIndex, and CDN URLs to buildStandardizationUpdates', async () => {
    const row = makeRow();

    await auditProductImages(
      row, 5, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // buildStandardizationUpdates must receive 0-based rowIndex (not rowIndex+2)
    expect(buildStandardizationUpdates).toHaveBeenCalledWith(
      SHEET_NAME,
      5,
      expect.objectContaining({
        front: expect.any(String),
        back: expect.any(String),
        side: expect.any(String),
      }),
    );

    // writeUpdates must be called with the result
    expect(writeUpdates).toHaveBeenCalledWith(mockSheetsClient, SPREADSHEET_ID, FAKE_UPDATES);
  });

  // -------------------------------------------------------------------------
  // Test 7: Unknown category — defaults to 'tops', warns
  // -------------------------------------------------------------------------
  it('Test 7 (null-category): defaults to tops and completes when baseCategory is unsupported', async () => {
    const row = makeRow({ baseCategory: 'caps' });

    // Should NOT throw — caps is unsupported but runner defaults to tops
    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    // Function completes without error
    expect(result.error).toBeUndefined();
    // Views are still processed
    expect(result.views.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 8: downloadImage throws for existing URL → treat as missing, no throw
  // -------------------------------------------------------------------------
  it('Test 8 (download-error): treats view as missing when downloadImage throws, does not throw', async () => {
    const row = makeRow();

    // Front download fails; back and side succeed
    vi.mocked(downloadImage)
      .mockRejectedValueOnce(new Error('HTTP 404 Not Found'))  // front fails
      .mockResolvedValue(FAKE_BUFFER);  // back, side succeed

    vi.mocked(sourceImages).mockResolvedValue({
      front: { url: 'https://sourced.example.com/front.jpg', score: 80, verdict: 'pass' },
      back: null,
      side: null,
    });

    // Should NOT throw — download errors are non-fatal
    const result = await auditProductImages(
      row, 0, mockDriveClient, mockSheetsClient, SPREADSHEET_ID, SHEET_NAME, costTracker,
    );

    expect(result.error).toBeUndefined();
    // sourceImages must be called (front was treated as missing)
    expect(sourceImages).toHaveBeenCalled();
  });
});
