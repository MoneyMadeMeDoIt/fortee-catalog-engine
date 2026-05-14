/**
 * Smoke tests for scripts/fix-image-pollution.ts — Phase 16-03.
 *
 * Task 1: Tests 1–9 cover orchestrator skeleton + Tier 1 (supplier fetch):
 *   1 DI seam shape
 *   2 audit TSV parser
 *   3 resume-from-trail (D-15)
 *   4 Tier 1 happy path — FrontImage replacement skips verifier (D-17 Exception)
 *   5 Tier 1 — back/side replacement runs verifier-after-fix
 *   6 Tier 1 verifier-fail safety rail (R9, D-18)
 *   7 T-16-01 Drive update-in-place compare-before-trash
 *   8 Front-first ordering within a pid
 *   9 no_canonical_available → cascade to Tier 2/3
 *
 * Task 2: Tests 10–17 cover Tier 2, R6 gate, manual queue, summary JSON:
 *   10 Tier 2 happy path — generateGarmentView with NO double verifier
 *   11 Tier 2 retry-fail (null) → cascade to Tier 3
 *   12 T-16-01 in Tier 2 — same compare-before-trash logic
 *   13 D-21 ordering — Tier 1 fully complete before Tier 2 starts
 *   14 R6 gate — 19 manual queue → exit 0, status OK
 *   15 R6 gate — 21 manual queue → exit 2, BLOCKED-QUEUE-OVERFLOW
 *   16 Manual queue TSV format
 *   17 Summary JSON shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  runImagePollutionFix,
  tier1Fix,
  parseAuditTsv,
  type RunImagePollutionFixDeps,
  type PollutionRow,
} from '../../scripts/fix-image-pollution.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock OpenAI so importing the script never constructs a real client.
// Phase 17 17-08 (B-4): expose BadRequestError so tests can throw the typed
// error that the production code checks for via `instanceof`.
vi.mock('openai', () => {
  class BadRequestError extends Error {
    code?: string;
    status: number = 400;
    type: string = 'invalid_request_error';
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
      this.name = 'BadRequestError';
    }
  }
  class OpenAI {
    chat = { completions: { create: vi.fn() } };
    static BadRequestError = BadRequestError;
  }
  return { default: OpenAI };
});

// Mock fs — capture writeFileSync / appendFileSync calls so the tests can
// inspect the manual queue + summary JSON written by Task 2.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const writes = new Map<string, string>();
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: string) => {
      // Default: pretend tmp/ exists so mkdirSync is a no-op
      if (typeof p === 'string' && p === 'tmp') return true;
      return false;
    }),
    writeFileSync: vi.fn().mockImplementation((p: string, c: string) => {
      writes.set(p, c);
    }),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    __writes: writes,
  } as never;
});

// Reach into the fs mock to inspect what was written.
async function getFsWrites(): Promise<Map<string, string>> {
  const fs = await import('fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (fs as any).__writes as Map<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BR_HEADER = [
  'supplierCode',     // 0
  'PartID',           // 1
  'styleID',          // 2
  'partNumber',       // 3
  'brandName',        // 4
  'productId',        // 5
  'colorName',        // 6
  'colorFamily',      // 7
  'productName',      // 8
  'description',      // 9
  'FrontImage',       // 10
  'BackImage',        // 11
  'DirectSideImage',  // 12
  'col14Empty',       // 13
  'color1',           // 14
  'color2',           // 15
  'sizeName',         // 16
  'sizePriceCodeName',// 17
  'costPrice',        // 18
  'CaseQty',          // 19
  'unitWeight',       // 20
  'Qty',              // 21
  'CaseWeight',       // 22
  'BoxHeight',        // 23
  'BoxLength',        // 24
  'BoxWidth',         // 25
  'baseCategory',     // 26
  'weightGSM',        // 27
  'gender',           // 28
  'fit',              // 29
  'keywords',         // 30
  'categories',       // 31
  'careInstructions', // 32
  'sizeChart',        // 33
  'embroideryAvailable', // 34
  'dtfAvailable',     // 35
  'sellPrice1Area',   // 36
  'sellPrice2Area',   // 37
  'decorationPlacements', // 38
  'ModelFrontImage',  // 39
  'ModelSideImage',   // 40
  'ModelBackImage',   // 41
];

function makeBrRow(overrides: Record<string, string> = {}): string[] {
  const row = new Array(BR_HEADER.length).fill('');
  const defaults: Record<string, string> = {
    supplierCode: 'SSCANADA',
    productId: 'S05610',
    styleID: '5610',
    colorName: 'Navy',
  };
  const merged = { ...defaults, ...overrides };
  for (const [key, val] of Object.entries(merged)) {
    const idx = BR_HEADER.indexOf(key);
    if (idx >= 0) row[idx] = val;
  }
  return row;
}

function driveUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}`;
}

function makeDeps(
  overrides: Partial<RunImagePollutionFixDeps> = {},
): RunImagePollutionFixDeps {
  const fakeOpenAI = { chat: { completions: { create: vi.fn() } } } as never;

  const readRawRowsFn = vi
    .fn()
    .mockResolvedValue([
      BR_HEADER,
      makeBrRow({ FrontImage: driveUrl('FRONT_OLD_ID_AAAAAAAAAAAAA') }),
    ]);

  const downloadImageFn = vi.fn().mockResolvedValue(Buffer.from('supplier-png'));
  const downloadFromDriveFn = vi.fn().mockResolvedValue(Buffer.from('drive-png'));
  const supplierCanonicalFn = vi.fn().mockResolvedValue({
    url: 'https://www.ssactivewear.com/style/5610_fl.jpg',
    source: 'ss',
    styleId: 5610,
  });
  const verifySameProductFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'same product' });
  // Cast through never to relax the strict GenerateViewResult shape — tests
  // care only about null vs non-null returns.
  const generateGarmentViewFn = vi
    .fn()
    .mockResolvedValue({
      buffer: Buffer.from('regen-png'),
      score: 90,
      verdict: 'pass',
      totalCost: 0.042,
      callCount: 1,
      usedRetry: false,
      hueDrift: 0,
    } as never) as never;
  const uploadToDriveFn = vi
    .fn()
    .mockResolvedValue(driveUrl('FRONT_NEW_ID_BBBBBBBBBBBBB'));
  const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);
  const writeUpdatesFn = vi.fn().mockResolvedValue(1);
  const appendTrailRowFn = vi.fn().mockResolvedValue(undefined);
  const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set<string>());

  return {
    args: {
      auditFile: undefined,
      limit: undefined,
      dryRun: false,
      pid: undefined,
      help: false,
    },
    sheetsClient: {} as never,
    driveClient: {} as never,
    openai: fakeOpenAI,
    readRawRowsFn: readRawRowsFn as never,
    downloadImageFn: downloadImageFn as never,
    downloadFromDriveFn: downloadFromDriveFn as never,
    supplierCanonicalFn: supplierCanonicalFn as never,
    verifySameProductFn: verifySameProductFn as never,
    generateGarmentViewFn,
    uploadToDriveFn: uploadToDriveFn as never,
    trashDriveFileFn: trashDriveFileFn as never,
    writeUpdatesFn: writeUpdatesFn as never,
    appendTrailRowFn: appendTrailRowFn as never,
    loadProcessedPidsFn: loadProcessedPidsFn as never,
    spreadsheetId: 'SHEET-X',
    sheetName: 'Bestsellers-Ready',
    ...overrides,
  };
}

// Helper to make a polluted-row entry for a pid
function makePollutionRow(overrides: Partial<PollutionRow> = {}): PollutionRow {
  return {
    pid: 'S05610',
    pollution_class: 'content_mismatch',
    affected_columns: ['BackImage'],
    affected_drive_urls: [driveUrl('BACK_OLD_ID_CCCCCCCCCCCC')],
    expected_supplier_url: '',
    recommended_fix_tier: 1,
    pass_detected_in: 2,
    notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 1 tests — Tier 1 + skeleton
// ---------------------------------------------------------------------------

describe('runImagePollutionFix — Task 1 (orchestrator + Tier 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1 (DI seam): returns summary with tier1Fixed/tier2Fixed/manualQueueSize keys', async () => {
    const deps = makeDeps({
      // No audit rows → zero work
      auditRowsOverride: [] as never,
    } as never);
    const result = await runImagePollutionFix(deps);

    expect(result).toHaveProperty('tier1Fixed');
    expect(result).toHaveProperty('tier2Fixed');
    expect(result).toHaveProperty('cascadedToTier3');
    expect(result).toHaveProperty('manualQueueSize');
    expect(result).toHaveProperty('manualQueuePath');
    expect(typeof result.tier1Fixed).toBe('number');
    expect(typeof result.manualQueueSize).toBe('number');
  });

  it('Test 2 (audit TSV parser): parses 3-row TSV into PollutionRow objects', async () => {
    const fs = await import('fs');
    const readFileSyncMock = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
    const tsv = [
      '# audit_run_id=2026-05-12T00:00:00Z',
      '# pids_scanned=3',
      '# pids_polluted=3',
      '# class_counts: shared_url=1 invalid_image_format=0 content_mismatch=1 model_pollution=0 shape_drift=1',
      '# headwear_skipped_count=0',
      'pid\tpollution_class\taffected_columns\taffected_drive_urls\texpected_supplier_url\trecommended_fix_tier\tpass_detected_in\tnotes',
      'S05610\tcontent_mismatch\tFrontImage\thttps://drive.google.com/uc?id=AAA\thttps://ss.com/x.jpg\t1\t2\tbaby onesie vs t-shirt',
      'L00450\tshape_drift\tBackImage\thttps://drive.google.com/uc?id=BBB\t\t2\t3\thoodie back on crewneck',
      '8882\tshared_url\tFrontImage,ModelFrontImage\thttps://drive.google.com/uc?id=CCC\t\t3\t1\tshared with: 5200,CE520L',
    ].join('\n');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.tsv') ? true : p === 'tmp',
    );
    readFileSyncMock.mockReturnValue(tsv);

    const rows = await parseAuditTsv('tmp/image-pollution-audit-2026-05-12.tsv');

    expect(rows.length).toBe(3);
    expect(rows[0].pid).toBe('S05610');
    expect(rows[0].pollution_class).toBe('content_mismatch');
    expect(rows[0].affected_columns).toEqual(['FrontImage']);
    expect(rows[0].expected_supplier_url).toBe('https://ss.com/x.jpg');
    expect(rows[0].recommended_fix_tier).toBe(1);

    expect(rows[2].pid).toBe('8882');
    expect(rows[2].affected_columns).toEqual(['FrontImage', 'ModelFrontImage']);
    expect(rows[2].pollution_class).toBe('shared_url');
  });

  it('Test 3 (resume from trail): loadProcessedPids skips already-processed pid', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({ pid: 'pidA' }),
      makePollutionRow({ pid: 'pidB' }),
    ];
    const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set(['pidA']));
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({ productId: 'pidA', BackImage: driveUrl('BACKA0000000000000000000') }),
      makeBrRow({ productId: 'pidB', BackImage: driveUrl('BACKB0000000000000000000') }),
    ]);
    const supplierCanonicalFn = vi.fn().mockResolvedValue({
      url: 'https://ss/x_fl.jpg',
      source: 'ss',
      styleId: 1,
    });
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: true, reason: 'ok' });

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      loadProcessedPidsFn: loadProcessedPidsFn as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      verifySameProductFn: verifySameProductFn as never,
    } as never);

    await runImagePollutionFix(deps);

    // supplierCanonicalFn called exactly once — for pidB only (pidA skipped).
    // Phase 17 17-02: now also threads the BR row's colorName as 2nd arg.
    expect(supplierCanonicalFn).toHaveBeenCalledTimes(1);
    expect(supplierCanonicalFn).toHaveBeenCalledWith('pidB', expect.any(String));
  });

  it('Test 4 (R3 Tier 1 happy — FrontImage replacement, D-17 verifier skipped)', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl('FRONT_OLD_ID_AAAAAAAAAAAAA')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_OLD_ID_AAAAAAAAAAAAA'),
      }),
    ]);
    const verifySameProductFn = vi.fn();
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      verifySameProductFn: verifySameProductFn as never,
    } as never);

    const result = await runImagePollutionFix(deps);

    // D-17 EXCEPTION: verifier NEVER called for FrontImage replacement
    expect(verifySameProductFn).not.toHaveBeenCalled();

    // trashDriveFile called with origFileId (different from newFileId)
    expect(deps.trashDriveFileFn).toHaveBeenCalledTimes(1);
    expect(deps.trashDriveFileFn).toHaveBeenCalledWith(
      expect.anything(),
      'FRONT_OLD_ID_AAAAAAAAAAAAA',
    );

    // writeUpdates called with the new URL
    expect(deps.writeUpdatesFn).toHaveBeenCalled();
    const writeArgs = (deps.writeUpdatesFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const updates = writeArgs[2] as Array<{ range: string; values: string[][] }>;
    expect(updates[0].values[0][0]).toBe(driveUrl('FRONT_NEW_ID_BBBBBBBBBBBBB'));

    // Trail received SUPPLIER_FETCH with verifier_skipped_tautology + DRIVE_UPLOAD + DRIVE_DELETE + BR_WRITE
    const trailCalls = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls;
    const ops = trailCalls.map((c) => c[0].operation);
    expect(ops).toContain('SUPPLIER_FETCH');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('DRIVE_DELETE');
    expect(ops).toContain('BR_WRITE');
    // No VERIFIER_PASS row emitted for FrontImage replacement.
    expect(ops).not.toContain('VERIFIER_PASS');

    // The SUPPLIER_FETCH row has the tautology marker.
    const supplierRow = trailCalls.find((c) => c[0].operation === 'SUPPLIER_FETCH');
    expect(supplierRow?.[0].notes).toBe('verifier_skipped_tautology');
    expect(supplierRow?.[0].tier).toBe(1);

    expect(result.tier1Fixed).toBe(1);
  });

  it('Test 5 (R3 Tier 1 — BackImage replacement runs verifier-after-fix)', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_OLD_ID_CCCCCCCCCCCC')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_REAL_ID_DDDDDDDDDDDD'),
        BackImage: driveUrl('BACK_OLD_ID_CCCCCCCCCCCC'),
      }),
    ]);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: true, reason: 'same product' });

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      verifySameProductFn: verifySameProductFn as never,
    } as never);

    const result = await runImagePollutionFix(deps);

    expect(verifySameProductFn).toHaveBeenCalledTimes(1);
    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('VERIFIER_PASS');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('BR_WRITE');
    expect(result.tier1Fixed).toBe(1);
  });

  it('Test 6 (R9 verifier-fail safety rail): no write + cascade to Tier 2/3', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_OLD_ID_FAIL00000000')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_REAL_ID_DDDDDDDDDDDD'),
        BackImage: driveUrl('BACK_OLD_ID_FAIL00000000'),
      }),
    ]);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: false, reason: 'shape drift detected' });
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      verifySameProductFn: verifySameProductFn as never,
      // generateGarmentView returns null too — pid ends in queue
      generateGarmentViewFn: vi.fn().mockResolvedValue(null) as never,
    } as never);

    const result = await runImagePollutionFix(deps);

    // No Drive trash, no BR write, no Drive upload for this column
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();

    const trailCalls = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls;
    const verifierFail = trailCalls.find(
      (c) => c[0].operation === 'VERIFIER_FAIL',
    );
    expect(verifierFail).toBeTruthy();
    expect(verifierFail?.[0].notes).toContain('shape drift detected');

    expect(result.tier1Fixed).toBe(0);
    expect(result.cascadedToTier3).toBeGreaterThanOrEqual(1);
  });

  it('Test 7 (T-16-01 — Drive update-in-place compare-before-trash)', async () => {
    const SAME_ID = 'SAME_FILE_ID_NEVERTRASH00000';
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl(SAME_ID)],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({ productId: 'S05610', FrontImage: driveUrl(SAME_ID) }),
    ]);
    // uploadToDrive returns SAME fileId (update-in-place)
    const uploadToDriveFn = vi.fn().mockResolvedValue(driveUrl(SAME_ID));
    const trashDriveFileFn = vi.fn();
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      uploadToDriveFn: uploadToDriveFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    } as never);

    await runImagePollutionFix(deps);

    // CRITICAL: trashDriveFile MUST NOT be called when origFileId === newFileId
    expect(trashDriveFileFn).not.toHaveBeenCalled();

    // But DRIVE_UPLOAD is still emitted (the file was written, just in place).
    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).not.toContain('DRIVE_DELETE');
  });

  it('Test 8 (Front-first ordering): FrontImage processed before BackImage', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['BackImage', 'FrontImage'],  // BackImage first in input
        affected_drive_urls: [
          driveUrl('BACK_OLD_ID_AAAAAAAAAAAA'),
          driveUrl('FRONT_OLD_ID_BBBBBBBBBBBB'),
        ],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_OLD_ID_BBBBBBBBBBBB'),
        BackImage: driveUrl('BACK_OLD_ID_AAAAAAAAAAAA'),
      }),
    ]);
    // Per-column uploadToDrive returns a unique new fileId
    let uploadCallNum = 0;
    const uploadToDriveFn = vi.fn().mockImplementation(async () => {
      uploadCallNum++;
      return driveUrl(`NEW_FILE_ID_${uploadCallNum}_AAAAAAAAAAAA`);
    });
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: true, reason: 'ok' });
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      uploadToDriveFn: uploadToDriveFn as never,
      verifySameProductFn: verifySameProductFn as never,
    } as never);

    await runImagePollutionFix(deps);

    // Inspect the order of BR_WRITE trail rows for column_or_path
    const brWrites = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((r) => r.operation === 'BR_WRITE');
    expect(brWrites.length).toBeGreaterThanOrEqual(2);
    expect(brWrites[0].column_or_path).toBe('FrontImage');
    expect(brWrites[1].column_or_path).toBe('BackImage');
  });

  it('Test 9 (no_canonical_available → cascade): null supplier-canonical skips Tier 1 writes', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: '1234',  // numeric pid → no S* / L* prefix → null canonical
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl('SOMEFILEIDXXXXXXXXXXXX')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: '1234',
        FrontImage: driveUrl('SOMEFILEIDXXXXXXXXXXXX'),
      }),
    ]);
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      // Tier 2 also fails on FrontImage (no back/side) → cascades to Tier 3
      generateGarmentViewFn: vi.fn().mockResolvedValue(null) as never,
    } as never);

    const result = await runImagePollutionFix(deps);

    // No writes — Tier 1 didn't fire
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
    expect(deps.uploadToDriveFn).not.toHaveBeenCalled();

    // Trail SUPPLIER_FETCH with no canonical note
    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const noCanonRow = trail.find(
      (r) => r.operation === 'SUPPLIER_FETCH' && /no canonical/i.test(r.notes),
    );
    expect(noCanonRow).toBeTruthy();
    expect(result.tier1Fixed).toBe(0);
    expect(result.cascadedToTier3).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2 tests — Tier 2 + R6 gate + manual queue + summary JSON
// ---------------------------------------------------------------------------

describe('runImagePollutionFix — Task 2 (Tier 2 + R6 gate + queue + summary)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getFsWrites()).clear();
  });

  it('Test 10 (R4 Tier 2 happy — generateGarmentView, NO double verifier)', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'L00450',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_OLD_ID_EEEEEEEEEEEE')],
        recommended_fix_tier: 2,
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'L00450',
        FrontImage: driveUrl('FRONT_REAL_ID_LLLLLLLLLLLL'),
        BackImage: driveUrl('BACK_OLD_ID_EEEEEEEEEEEE'),
      }),
    ]);
    // Tier 1 returns null canonical → cascades to Tier 2
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const verifySameProductFn = vi.fn();
    const generateGarmentViewFn = vi.fn().mockResolvedValue({
      buffer: Buffer.from('regen-back'),
      score: 88,
      verdict: 'pass',
      totalCost: 0.084,
      callCount: 2,
      usedRetry: false,
      hueDrift: 5,
    } as never) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      verifySameProductFn: verifySameProductFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    expect(generateGarmentViewFn).toHaveBeenCalled();
    // No second verifier call — Phase 15 verifier is internal to generateGarmentView
    expect(verifySameProductFn).not.toHaveBeenCalled();

    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('AI_REGEN');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('BR_WRITE');
    expect(result.tier2Fixed).toBe(1);
  });

  it('Test 11 (R4 Tier 2 retry-fail null → cascade to Tier 3)', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'L00450',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_OLD_ID_EEEEEEEEEEEE')],
        recommended_fix_tier: 2,
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'L00450',
        FrontImage: driveUrl('FRONT_REAL_ID_LLLLLLLLLLLL'),
        BackImage: driveUrl('BACK_OLD_ID_EEEEEEEEEEEE'),
      }),
    ]);
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const generateGarmentViewFn = vi.fn().mockResolvedValue(null) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    expect(deps.uploadToDriveFn).not.toHaveBeenCalled();
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();

    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const aiRegen = trail.find((r) => r.operation === 'AI_REGEN');
    expect(aiRegen).toBeTruthy();
    expect(aiRegen?.notes).toMatch(/Tier 2 returned null/i);
    expect(result.cascadedToTier3).toBeGreaterThanOrEqual(1);
    expect(result.manualQueueSize).toBeGreaterThanOrEqual(1);
  });

  it('Test 12 (T-16-01 in Tier 2 — compare-before-trash mirrored)', async () => {
    const SAME = 'TIER2_SAME_ID_NEVERTRASH00';
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'L00450',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl(SAME)],
        recommended_fix_tier: 2,
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'L00450',
        FrontImage: driveUrl('FRONT_REAL_LLLLLLLLLLLLLL'),
        BackImage: driveUrl(SAME),
      }),
    ]);
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const uploadToDriveFn = vi.fn().mockResolvedValue(driveUrl(SAME));  // same id
    const trashDriveFileFn = vi.fn();
    const generateGarmentViewFn = vi.fn().mockResolvedValue({
      buffer: Buffer.from('x'),
      score: 80,
      verdict: 'pass',
      totalCost: 0.04,
      callCount: 1,
      usedRetry: false,
      hueDrift: 0,
    } as never) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      uploadToDriveFn: uploadToDriveFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
      generateGarmentViewFn,
    } as never);

    await runImagePollutionFix(deps);

    expect(trashDriveFileFn).not.toHaveBeenCalled();
  });

  it('Test 13 (D-21 — Tier 1 completes fully before Tier 2 starts)', async () => {
    const callOrder: string[] = [];
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_S_AAAAAAAAAAAAAAAAAA')],
        recommended_fix_tier: 1,
      }),
      makePollutionRow({
        pid: 'L00450',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('BACK_L_BBBBBBBBBBBBBBBBBB')],
        recommended_fix_tier: 2,
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_S00000000000000000000'),
        BackImage: driveUrl('BACK_S_AAAAAAAAAAAAAAAAAA'),
      }),
      makeBrRow({
        productId: 'L00450',
        FrontImage: driveUrl('FRONT_L00000000000000000000'),
        BackImage: driveUrl('BACK_L_BBBBBBBBBBBBBBBBBB'),
      }),
    ]);
    const supplierCanonicalFn = vi.fn().mockImplementation(async (pid: string) => {
      callOrder.push(`supplierCanonical:${pid}`);
      if (pid === 'S05610') return { url: 'https://ss/x.jpg', source: 'ss', styleId: 1 };
      return null;  // L00450 cascades to Tier 2
    });
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      callOrder.push('generateGarmentView');
      return {
        buffer: Buffer.from('x'),
        score: 80,
        verdict: 'pass',
        totalCost: 0.04,
        callCount: 1,
        usedRetry: false,
        hueDrift: 0,
      };
    }) as never;
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: true, reason: 'ok' });

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
      verifySameProductFn: verifySameProductFn as never,
    } as never);

    await runImagePollutionFix(deps);

    // ALL supplierCanonical calls happen BEFORE any generateGarmentView call
    const lastSupplierIdx = callOrder.lastIndexOf('supplierCanonical:L00450');
    const firstGenIdx = callOrder.indexOf('generateGarmentView');
    expect(firstGenIdx).toBeGreaterThan(-1);
    expect(lastSupplierIdx).toBeGreaterThan(-1);
    expect(firstGenIdx).toBeGreaterThan(lastSupplierIdx);
  });

  it('Test 14 (R6 hard cap — 19 manual queue: status OK, exit 0)', async () => {
    // Build 19 pids all cascading to Tier 3
    const pids = Array.from({ length: 19 }, (_, i) => `P${String(i).padStart(4, '0')}`);
    const pollutedRows: PollutionRow[] = pids.map((p) =>
      makePollutionRow({
        pid: p,
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl(`${p}OLD000000000000000`.slice(0, 25))],
      }),
    );
    const brRows = [
      BR_HEADER,
      ...pids.map((p) =>
        makeBrRow({
          productId: p,
          FrontImage: driveUrl(`${p}OLD000000000000000`.slice(0, 25)),
        }),
      ),
    ];
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);  // no canonical → cascade
    const generateGarmentViewFn = vi.fn().mockResolvedValue(null) as never;

    // process.exit spy must NOT fire for queue size 19
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.manualQueueSize).toBe(19);

    const writes = await getFsWrites();
    const summaryEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-fix-summary-'),
    );
    expect(summaryEntry).toBeTruthy();
    const summaryJson = JSON.parse(summaryEntry![1]);
    expect(summaryJson.status).toBe('OK');
    expect(summaryJson.manual_queue_size).toBe(19);

    exitSpy.mockRestore();
  });

  it('Test 15 (R6 hard cap — 21 manual queue: BLOCKED-QUEUE-OVERFLOW, exit 2)', async () => {
    const pids = Array.from({ length: 21 }, (_, i) => `Q${String(i).padStart(4, '0')}`);
    const pollutedRows: PollutionRow[] = pids.map((p) =>
      makePollutionRow({
        pid: p,
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl(`${p}OLDZ00000000000000`.slice(0, 25))],
      }),
    );
    const brRows = [
      BR_HEADER,
      ...pids.map((p) =>
        makeBrRow({
          productId: p,
          FrontImage: driveUrl(`${p}OLDZ00000000000000`.slice(0, 25)),
        }),
      ),
    ];
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const generateGarmentViewFn = vi.fn().mockResolvedValue(null) as never;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    await expect(runImagePollutionFix(deps)).rejects.toThrow('process.exit(2)');

    expect(exitSpy).toHaveBeenCalledWith(2);
    // The error message contains the BLOCKED token
    const errCalls = errSpy.mock.calls.flat().join(' ');
    expect(errCalls).toMatch(/BLOCKED-QUEUE-OVERFLOW/);

    // Both the manual queue TSV AND the summary JSON were written before exit
    const writes = await getFsWrites();
    const queueEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-manual-queue-'),
    );
    expect(queueEntry).toBeTruthy();

    const summaryEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-fix-summary-'),
    );
    expect(summaryEntry).toBeTruthy();
    const summaryJson = JSON.parse(summaryEntry![1]);
    expect(summaryJson.status).toBe('BLOCKED-QUEUE-OVERFLOW');
    expect(summaryJson.manual_queue_size).toBe(21);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('Test 16 (manual queue TSV format): 6-column schema with suggested_action', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'X1',
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl('X1OLD0000000000000000000')],
      }),
      makePollutionRow({
        pid: 'X2',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('X2OLD0000000000000000000')],
        recommended_fix_tier: 2,
      }),
    ];
    const brRows = [
      BR_HEADER,
      makeBrRow({ productId: 'X1', FrontImage: driveUrl('X1OLD0000000000000000000') }),
      makeBrRow({
        productId: 'X2',
        FrontImage: driveUrl('X2FRONT0000000000000000'),
        BackImage: driveUrl('X2OLD0000000000000000000'),
      }),
    ];
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const generateGarmentViewFn = vi.fn().mockResolvedValue(null) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    await runImagePollutionFix(deps);

    const writes = await getFsWrites();
    const queueEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-manual-queue-'),
    );
    expect(queueEntry).toBeTruthy();
    const queueContent = queueEntry![1];
    const lines = queueContent.trim().split('\n');
    // Header
    expect(lines[0]).toBe(
      'pid\tpollution_class\taffected_columns\tcurrent_drive_urls\tfront_image_screenshot_link\tsuggested_action',
    );
    // Two body rows
    expect(lines.length).toBe(3);
    // X1 row → content_mismatch → "replace with operator-picked URL"
    const x1 = lines[1].split('\t');
    expect(x1[0]).toBe('X1');
    expect(x1[1]).toBe('content_mismatch');
    expect(x1[5]).toMatch(/replace with operator-picked URL/i);
    // X2 row → shape_drift → "delete + leave blank for next push regen"
    const x2 = lines[2].split('\t');
    expect(x2[0]).toBe('X2');
    expect(x2[1]).toBe('shape_drift');
    expect(x2[5]).toMatch(/delete .* leave blank/i);
    // front_image_screenshot_link points at FRONT, not BACK
    expect(x2[4]).toContain('X2FRONT');
  });

  it('Test 17 (summary JSON shape): all required keys present', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl('S05_OLD0000000000000000')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('S05_OLD0000000000000000'),
      }),
    ]);
    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
    } as never);

    await runImagePollutionFix(deps);

    const writes = await getFsWrites();
    const summaryEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-fix-summary-'),
    );
    expect(summaryEntry).toBeTruthy();
    const json = JSON.parse(summaryEntry![1]);

    for (const key of [
      'audit_run_id',
      'tier1_fixed',
      'tier2_fixed',
      'cascaded_to_tier3',
      'manual_queue_size',
      'manual_queue_path',
      'total_cost_usd_estimate',
      'status',
      'processed_pid_count',
    ]) {
      expect(json).toHaveProperty(key);
    }
    expect(['OK', 'BLOCKED-QUEUE-OVERFLOW']).toContain(json.status);
  });
});


// ---------------------------------------------------------------------------
// 17-08 (B-4) tests — OpenAI billing-hard-limit short-circuit in Tier 2 loop.
//
// Coverage:
//   1. First-pid billing hit → set __billingExhausted, log ONE warn,
//      TIER2_BUDGET_EXHAUSTED rows for each pid in cascade, status
//      BILLING_LIMIT_HIT, generateGarmentViewFn called exactly once.
//   2. Message-substring fallback for older SDK versions (code missing).
//   3. Non-billing OpenAI errors do NOT short-circuit (content_policy_violation).
//   4. Generic Error does NOT short-circuit.
//   5. Resume safety — TIER2_BUDGET_EXHAUSTED rows do NOT skip pids on re-run.
//   6. Summary JSON includes status='BILLING_LIMIT_HIT' and
//      tier2_budget_exhausted_count.
// ---------------------------------------------------------------------------

describe('17-08 B-4 billing hard limit', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getFsWrites()).clear();
    // Reset the module-scope __billingExhausted flag between tests.
    const { __resetBillingExhaustedForTest } = await import(
      '../../scripts/fix-image-pollution.js'
    );
    __resetBillingExhaustedForTest();
  });

  function makeThreePidsCascadingToTier2(): PollutionRow[] {
    // All three pids have BackImage pollution → cascade to Tier 2 after Tier 1
    // returns null canonical.
    return ['L00001', 'L00002', 'L00003'].map((pid) =>
      makePollutionRow({
        pid,
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl(`${pid}OLD000000000000000000`.slice(0, 25))],
        recommended_fix_tier: 2,
      }),
    );
  }

  function makeThreeRowsBr(): string[][] {
    return [
      BR_HEADER,
      ...['L00001', 'L00002', 'L00003'].map((pid) =>
        makeBrRow({
          productId: pid,
          FrontImage: driveUrl(`FRONT_${pid}_AAAAAAAAAAAA`.slice(0, 30)),
          BackImage: driveUrl(`${pid}OLD000000000000000000`.slice(0, 25)),
        }),
      ),
    ];
  }

  it('Test 1 (first pid hits billing_hard_limit_reached → short-circuits rest)', async () => {
    const OpenAI = (await import('openai')).default as unknown as {
      BadRequestError: new (msg: string, code?: string) => Error & {
        code?: string;
      };
    };

    const pollutedRows = makeThreePidsCascadingToTier2();
    const brRows = makeThreeRowsBr();
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    // First call throws billing_hard_limit_reached. Subsequent pids would NOT
    // call generateGarmentViewFn — they short-circuit through the flag check.
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      throw new OpenAI.BadRequestError(
        'Billing hard limit has been reached for this account',
        'billing_hard_limit_reached',
      );
    }) as never;

    const { logger } = await import('../../src/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    // (a) generateGarmentViewFn called exactly ONCE — pid 1 only.
    expect((generateGarmentViewFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // (b) logger.warn fired with the special billing message at least once.
    const billingWarn = (warnSpy.mock.calls as unknown[][]).find(
      (c) =>
        typeof c[0] === 'string' && (c[0] as string).includes('OpenAI billing hard limit'),
    );
    expect(billingWarn).toBeTruthy();

    // (c) Three TIER2_BUDGET_EXHAUSTED rows — one per pid (1 detection + 2 short-circuits).
    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const budgetRows = trail.filter(
      (r) => r.operation === 'TIER2_BUDGET_EXHAUSTED',
    );
    expect(budgetRows.length).toBe(3);
    // Each row tagged tier=2.
    for (const r of budgetRows) {
      expect(r.tier).toBe(2);
    }
    // Each row references its own pid (no duplication).
    const pidSet = new Set(budgetRows.map((r) => r.pid));
    expect(pidSet.has('L00001')).toBe(true);
    expect(pidSet.has('L00002')).toBe(true);
    expect(pidSet.has('L00003')).toBe(true);

    // (d) Status in JSON summary is BILLING_LIMIT_HIT.
    const writes = await getFsWrites();
    const summaryEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-fix-summary-'),
    );
    expect(summaryEntry).toBeTruthy();
    const summaryJson = JSON.parse(summaryEntry![1]);
    expect(summaryJson.status).toBe('BILLING_LIMIT_HIT');

    // (e) Return value reflects BILLING_LIMIT_HIT (no exit-2 since R6 doesn't apply).
    expect(result.status).toBe('BILLING_LIMIT_HIT');

    warnSpy.mockRestore();
  });

  it('Test 2 (message-substring fallback when code is undefined)', async () => {
    const OpenAI = (await import('openai')).default as unknown as {
      BadRequestError: new (msg: string, code?: string) => Error & {
        code?: string;
      };
    };

    const pollutedRows = makeThreePidsCascadingToTier2();
    const brRows = makeThreeRowsBr();
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    // Throw with NO code (code === undefined) but message-substring match.
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      throw new OpenAI.BadRequestError(
        'Billing hard limit has been reached for this account',
        // undefined code → fallback path
      );
    }) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    expect((generateGarmentViewFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(result.status).toBe('BILLING_LIMIT_HIT');

    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const budgetRows = trail.filter(
      (r) => r.operation === 'TIER2_BUDGET_EXHAUSTED',
    );
    expect(budgetRows.length).toBe(3);
  });

  it('Test 3 (non-billing OpenAI error: content_policy_violation does NOT short-circuit)', async () => {
    const OpenAI = (await import('openai')).default as unknown as {
      BadRequestError: new (msg: string, code?: string) => Error & {
        code?: string;
      };
    };

    const pollutedRows = makeThreePidsCascadingToTier2();
    const brRows = makeThreeRowsBr();
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    // First call throws content_policy. Subsequent pids STILL get a call.
    let callCount = 0;
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new OpenAI.BadRequestError(
          'Content policy violation',
          'content_policy_violation',
        );
      }
      // Pids 2 and 3 succeed normally.
      return {
        buffer: Buffer.from('regen-back'),
        score: 80,
        verdict: 'pass',
        totalCost: 0.04,
        callCount: 1,
        usedRetry: false,
        hueDrift: 0,
      };
    }) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    // All 3 pids got a generateGarmentView call (no short-circuit).
    expect((generateGarmentViewFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    // No TIER2_BUDGET_EXHAUSTED rows.
    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const budgetRows = trail.filter(
      (r) => r.operation === 'TIER2_BUDGET_EXHAUSTED',
    );
    expect(budgetRows.length).toBe(0);

    // Status is OK (no billing limit, manual queue includes pid 1 only).
    expect(result.status).not.toBe('BILLING_LIMIT_HIT');
  });

  it('Test 4 (generic Error does NOT short-circuit)', async () => {
    const pollutedRows = makeThreePidsCascadingToTier2();
    const brRows = makeThreeRowsBr();
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    let callCount = 0;
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('some random failure');
      }
      return {
        buffer: Buffer.from('regen-back'),
        score: 80,
        verdict: 'pass',
        totalCost: 0.04,
        callCount: 1,
        usedRetry: false,
        hueDrift: 0,
      };
    }) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    const result = await runImagePollutionFix(deps);

    // All 3 pids got a call (generic errors don't short-circuit).
    expect((generateGarmentViewFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    const trail = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const budgetRows = trail.filter(
      (r) => r.operation === 'TIER2_BUDGET_EXHAUSTED',
    );
    expect(budgetRows.length).toBe(0);
    expect(result.status).not.toBe('BILLING_LIMIT_HIT');
  });

  it('Test 5 (resume safety: TIER2_BUDGET_EXHAUSTED is non-terminal, pids retried on re-run)', async () => {
    // Simulate run #2 after a previous run hit billing limit:
    // loadProcessedPidsFn returns an EMPTY set (the trail had only
    // TIER2_BUDGET_EXHAUSTED rows for these pids — non-terminal — so they were
    // excluded from the processed set per 17-08 Task 1).
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'pidA',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('pidAOLD0000000000000000')],
        recommended_fix_tier: 2,
      }),
      makePollutionRow({
        pid: 'pidB',
        pollution_class: 'shape_drift',
        affected_columns: ['BackImage'],
        affected_drive_urls: [driveUrl('pidBOLD0000000000000000')],
        recommended_fix_tier: 2,
      }),
    ];
    const brRows = [
      BR_HEADER,
      makeBrRow({
        productId: 'pidA',
        FrontImage: driveUrl('FRONT_pidA00000000000000'),
        BackImage: driveUrl('pidAOLD0000000000000000'),
      }),
      makeBrRow({
        productId: 'pidB',
        FrontImage: driveUrl('FRONT_pidB00000000000000'),
        BackImage: driveUrl('pidBOLD0000000000000000'),
      }),
    ];
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const generateGarmentViewFn = vi.fn().mockResolvedValue({
      buffer: Buffer.from('regen-back'),
      score: 80,
      verdict: 'pass',
      totalCost: 0.04,
      callCount: 1,
      usedRetry: false,
      hueDrift: 0,
    } as never) as never;
    // Critical: loadProcessedPidsFn returns empty Set — TIER2_BUDGET_EXHAUSTED
    // rows from the previous run were filtered out by 17-08 Task 1's
    // loadProcessedPids logic.
    const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set<string>());

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
      loadProcessedPidsFn: loadProcessedPidsFn as never,
    } as never);

    await runImagePollutionFix(deps);

    // BOTH pids called generateGarmentView (neither skipped).
    expect((generateGarmentViewFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('Test 6 (summary JSON has tier2_budget_exhausted_count + BILLING_LIMIT_HIT)', async () => {
    const OpenAI = (await import('openai')).default as unknown as {
      BadRequestError: new (msg: string, code?: string) => Error & {
        code?: string;
      };
    };

    const pollutedRows = makeThreePidsCascadingToTier2();
    const brRows = makeThreeRowsBr();
    const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
    const generateGarmentViewFn = vi.fn().mockImplementation(async () => {
      throw new OpenAI.BadRequestError(
        'Billing hard limit has been reached for this account',
        'billing_hard_limit_reached',
      );
    }) as never;

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
      generateGarmentViewFn,
    } as never);

    await runImagePollutionFix(deps);

    const writes = await getFsWrites();
    const summaryEntry = [...writes.entries()].find(([k]) =>
      k.includes('image-pollution-fix-summary-'),
    );
    expect(summaryEntry).toBeTruthy();
    const json = JSON.parse(summaryEntry![1]);
    expect(json.status).toBe('BILLING_LIMIT_HIT');
    expect(json.tier2_budget_exhausted_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 17 17-02 — colorName propagation
// (Tier 1 supplier fetch now passes the BR row's colorName cell as a 2nd arg
// so per-color URL matching can occur.)
// ---------------------------------------------------------------------------

describe('17-02 colorName propagation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Tier 1 forwards the BR row colorName cell to supplierCanonicalFn', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        pollution_class: 'content_mismatch',
        affected_columns: ['FrontImage'],
        affected_drive_urls: [driveUrl('FRONT_OLD_ID_AAAAAAAAAAAAA')],
      }),
    ];
    const readRawRowsFn = vi.fn().mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        colorName: 'ROYAL',
        FrontImage: driveUrl('FRONT_OLD_ID_AAAAAAAAAAAAA'),
      }),
    ]);
    const supplierCanonicalFn = vi.fn().mockResolvedValue({
      url: 'https://www.ssactivewear.com/Style/3001_ROYAL_fl.jpg',
      source: 'ss',
      styleId: 3001,
    });

    const deps = makeDeps({
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: readRawRowsFn as never,
      supplierCanonicalFn: supplierCanonicalFn as never,
    } as never);
    await runImagePollutionFix(deps);

    expect(supplierCanonicalFn).toHaveBeenCalled();
    for (const call of supplierCanonicalFn.mock.calls) {
      expect(call[0]).toBe('S05610');
      expect(call[1]).toBe('ROYAL');
    }
  });
});

// Unused for typechecking, but ensures __dirname is referenced (silences
// linter when test file has no relative path operations).
void __dirname;
void join;
