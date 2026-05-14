/**
 * Smoke tests for scripts/fix-model-images.ts — Phase 17 17-03.
 *
 * Test coverage:
 *   T1     TrailRow.tier accepts 4 (compile-time type widening)
 *   S1–S6  fetchSSModelImage helper: per-color / per-view / null cases
 *   F1–F8  fixModelImage per-column flow: Tier 1, Tier 2, T-17-09, T-17-10, T-17-14
 *   ST1–3  sample-test runner: pass gate, fail gate, --sample-pids override
 *   R1     loadProcessedPids skip
 *   FULL1  full-run path with 213 synthetic pids (Task 3)
 *   FULL2  --re-audit hook (Task 3)
 *
 * Mocks every fn in RunFixModelImagesDeps via vi.fn() (DI-seam pattern from
 * tests/scripts/fix-image-pollution.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrailRow } from '../../src/lib/image-pollution-trail.js';
import {
  runFixModelImages,
  fetchSSModelImage,
  fixModelImage,
  __resetBillingExhaustedForTest,
  type RunFixModelImagesDeps,
  type PollutionRow,
  type ModelColumn,
} from '../../scripts/fix-model-images.js';

// Mock OpenAI so importing the script never constructs a real client. Also
// exposes a typed BadRequestError so tests can throw the billing-hard-limit
// shape that the production code checks via `instanceof`.
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

// Mock fs — capture writeFileSync calls so tests can inspect summary JSON.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const writes = new Map<string, string>();
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: string) => {
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

async function getFsWrites(): Promise<Map<string, string>> {
  const fs = await import('fs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (fs as any).__writes as Map<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/scripts/fix-image-pollution.test.ts)
// ---------------------------------------------------------------------------

const BR_HEADER = [
  'supplierCode',
  'PartID',
  'styleID',
  'partNumber',
  'brandName',
  'productId',
  'colorName',
  'colorFamily',
  'productName',
  'description',
  'FrontImage',
  'BackImage',
  'DirectSideImage',
  'col14Empty',
  'color1',
  'color2',
  'sizeName',
  'sizePriceCodeName',
  'costPrice',
  'CaseQty',
  'unitWeight',
  'Qty',
  'CaseWeight',
  'BoxHeight',
  'BoxLength',
  'BoxWidth',
  'baseCategory',
  'weightGSM',
  'gender',
  'fit',
  'keywords',
  'categories',
  'careInstructions',
  'sizeChart',
  'embroideryAvailable',
  'dtfAvailable',
  'sellPrice1Area',
  'sellPrice2Area',
  'decorationPlacements',
  'ModelFrontImage',
  'ModelSideImage',
  'ModelBackImage',
];

function makeBrRow(overrides: Record<string, string> = {}): string[] {
  const row = new Array(BR_HEADER.length).fill('');
  const defaults: Record<string, string> = {
    supplierCode: 'SSCANADA',
    productId: 'S05610',
    styleID: '5610',
    colorName: 'ROYAL',
    gender: 'unisex',
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

function makePollutionRow(overrides: Partial<PollutionRow> = {}): PollutionRow {
  return {
    pid: 'S05610',
    pollution_class: 'model_pollution',
    affected_columns: ['ModelFrontImage'],
    affected_drive_urls: [driveUrl('MODEL_OLD_ID_AAAAAAAAAAA')],
    expected_supplier_url: '',
    recommended_fix_tier: 1,
    pass_detected_in: 2,
    notes: '',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<RunFixModelImagesDeps> = {},
): RunFixModelImagesDeps {
  const fakeOpenAI = { chat: { completions: { create: vi.fn() } } } as never;

  const readRawRowsFn = vi
    .fn()
    .mockResolvedValue([
      BR_HEADER,
      makeBrRow({
        FrontImage: driveUrl('FRONT_ID_AAAAAAAAAAAAAAAA'),
        ModelFrontImage: driveUrl('MODEL_OLD_ID_AAAAAAAAAAA'),
      }),
    ]);

  const downloadImageFn = vi.fn().mockResolvedValue(Buffer.from('supplier-png'));
  const downloadFromDriveFn = vi.fn().mockResolvedValue(Buffer.from('drive-png'));
  const fetchSSModelImageFn = vi
    .fn()
    .mockResolvedValue('https://www.ssactivewear.com/Style/5610_ROYAL_om_fl.jpg');
  const verifySameProductFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'same product' });
  const generateModelImageFn = vi.fn().mockResolvedValue({
    buffer: Buffer.from('ai-png'),
    cost: 0.126,
    callCount: 1,
    garmentDesc: 'unisex t-shirt',
    modelDescriptor: 'real person in their late twenties',
  });
  const uploadToDriveFn = vi
    .fn()
    .mockResolvedValue(driveUrl('MODEL_NEW_ID_BBBBBBBBBBBBB'));
  const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);
  const writeUpdatesFn = vi.fn().mockResolvedValue(1);
  const appendTrailRowFn = vi.fn().mockResolvedValue(undefined);
  const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set<string>());

  return {
    args: {
      auditFile: undefined,
      sampleOnly: false,
      samplePids: undefined,
      skipSampleGate: true,
      maxCost: 10,
      dryRun: false,
      limit: undefined,
      reAudit: false,
      help: false,
    },
    sheetsClient: {} as never,
    driveClient: {} as never,
    openai: fakeOpenAI,
    spreadsheetId: 'SHEET-X',
    sheetName: 'Bestsellers-Ready',
    readRawRowsFn: readRawRowsFn as never,
    downloadImageFn: downloadImageFn as never,
    downloadFromDriveFn: downloadFromDriveFn as never,
    fetchSSModelImageFn: fetchSSModelImageFn as never,
    verifySameProductFn: verifySameProductFn as never,
    generateModelImageFn: generateModelImageFn as never,
    uploadToDriveFn: uploadToDriveFn as never,
    trashDriveFileFn: trashDriveFileFn as never,
    writeUpdatesFn: writeUpdatesFn as never,
    appendTrailRowFn: appendTrailRowFn as never,
    loadProcessedPidsFn: loadProcessedPidsFn as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T1: Type widening
// ---------------------------------------------------------------------------

describe('Type widening', () => {
  it('T1: TrailRow.tier accepts 4 (compile-time check)', () => {
    const row: TrailRow = {
      timestamp_iso: '2026-05-14T00:00:00Z',
      pid: 'S05610',
      operation: 'BR_WRITE',
      column_or_path: 'ModelFrontImage',
      old_value: 'old',
      new_value: 'new',
      tier: 4,
      run_id: '2026-05-14T00:00:00.000Z',
      notes: 'phase17-model-rebuild',
    };
    expect(row.tier).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// S1–S6: fetchSSModelImage helper (uses global fetch mock)
// ---------------------------------------------------------------------------

describe('fetchSSModelImage', () => {
  beforeEach(() => {
    process.env.SS_ACCOUNT_NUMBER = 'test-account';
    process.env.SS_API_KEY = 'test-key';
    vi.restoreAllMocks();
  });

  function mockSSFetch(
    stylesResp: unknown,
    productsResp: unknown,
    stylesStatus = 200,
    productsStatus = 200,
  ): void {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(global, 'fetch' as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: stylesStatus === 200,
          status: stylesStatus,
          json: async () => stylesResp,
        } as unknown as Response;
      }
      return {
        ok: productsStatus === 200,
        status: productsStatus,
        json: async () => productsResp,
      } as unknown as Response;
    });
  }

  it('S1: returns colorOnModelFrontImage large URL for matching color', async () => {
    mockSSFetch(
      [{ styleID: 5610, styleName: 'S05610' }],
      [
        {
          colorName: 'BLACK',
          colorOnModelFrontImage: 'Images/Style/5610_BLACK_om_fm.jpg',
          colorOnModelSideImage: '',
          colorOnModelBackImage: '',
        },
        {
          colorName: 'ROYAL',
          colorOnModelFrontImage: 'Images/Style/5610_ROYAL_om_fm.jpg',
          colorOnModelSideImage: 'Images/Style/5610_ROYAL_oms_fm.jpg',
          colorOnModelBackImage: 'Images/Style/5610_ROYAL_omb_fm.jpg',
        },
      ],
    );
    const url = await fetchSSModelImage('S05610', 'ROYAL', 'front');
    expect(url).toContain('om_fl.jpg');
    expect(url).toContain('ROYAL');
  });

  it('S2: returns colorOnModelSideImage for side view', async () => {
    mockSSFetch(
      [{ styleID: 5610, styleName: 'S05610' }],
      [
        {
          colorName: 'ROYAL',
          colorOnModelFrontImage: 'Images/Style/5610_ROYAL_om_fm.jpg',
          colorOnModelSideImage: 'Images/Style/5610_ROYAL_oms_fm.jpg',
          colorOnModelBackImage: '',
        },
      ],
    );
    const url = await fetchSSModelImage('S05610', 'ROYAL', 'side');
    expect(url).toContain('oms_fl.jpg');
  });

  it('S3: returns colorOnModelBackImage for back view', async () => {
    mockSSFetch(
      [{ styleID: 5610, styleName: 'S05610' }],
      [
        {
          colorName: 'ROYAL',
          colorOnModelFrontImage: '',
          colorOnModelSideImage: '',
          colorOnModelBackImage: 'Images/Style/5610_ROYAL_omb_fm.jpg',
        },
      ],
    );
    const url = await fetchSSModelImage('S05610', 'ROYAL', 'back');
    expect(url).toContain('omb_fl.jpg');
  });

  it('S4: returns null when colorOnModelSideImage is empty for matching color', async () => {
    mockSSFetch(
      [{ styleID: 5610, styleName: 'S05610' }],
      [
        {
          colorName: 'ROYAL',
          colorOnModelFrontImage: 'Images/Style/5610_ROYAL_om_fm.jpg',
          colorOnModelSideImage: '',
          colorOnModelBackImage: '',
        },
      ],
    );
    const url = await fetchSSModelImage('S05610', 'ROYAL', 'side');
    expect(url).toBeNull();
  });

  it('S5: returns null when colorName not found in variants (no fallback)', async () => {
    mockSSFetch(
      [{ styleID: 5610, styleName: 'S05610' }],
      [
        {
          colorName: 'BLACK',
          colorOnModelFrontImage: 'Images/Style/5610_BLACK_om_fm.jpg',
          colorOnModelSideImage: '',
          colorOnModelBackImage: '',
        },
      ],
    );
    const url = await fetchSSModelImage('S05610', 'NONEXISTENT', 'front');
    expect(url).toBeNull();
  });

  it('S6: returns null when /products/ returns empty array', async () => {
    mockSSFetch([{ styleID: 5610, styleName: 'S05610' }], []);
    const url = await fetchSSModelImage('S05610', 'ROYAL', 'front');
    expect(url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F1–F8: fixModelImage per-column flow
// ---------------------------------------------------------------------------

describe('fixModelImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBillingExhaustedForTest();
  });

  function makeFixCtx(depsOverrides: Partial<RunFixModelImagesDeps> = {}): {
    deps: RunFixModelImagesDeps;
    brEntry: { rowIndex0: number; row: string[] };
    brIndex: {
      headerMap: Record<string, number>;
      rowByPid: Map<string, { rowIndex0: number; row: string[] }>;
    };
  } {
    const deps = makeDeps(depsOverrides);
    const headerMap: Record<string, number> = {};
    BR_HEADER.forEach((h, i) => {
      headerMap[h] = i;
    });
    const row = makeBrRow({
      productId: 'S05610',
      colorName: 'ROYAL',
      FrontImage: driveUrl('FRONT_ID_AAAAAAAAAAAAAAAA'),
      ModelFrontImage: driveUrl('MODEL_OLD_ID_AAAAAAAAAAA'),
    });
    const brEntry = { rowIndex0: 1, row };
    const brIndex = {
      headerMap,
      rowByPid: new Map([['S05610', brEntry]]),
    };
    return { deps, brEntry, brIndex };
  }

  it('F1: Tier 1 happy path — supplier verifier pass, writes BR + trashes old fileId', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const { deps, brEntry, brIndex } = makeFixCtx();

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('tier1_supplier');
    expect(deps.writeUpdatesFn).toHaveBeenCalledTimes(1);
    expect(deps.trashDriveFileFn).toHaveBeenCalledTimes(1);
    expect(deps.trashDriveFileFn).toHaveBeenCalledWith(
      expect.anything(),
      'MODEL_OLD_ID_AAAAAAAAAAA',
    );
    expect(deps.generateModelImageFn).not.toHaveBeenCalled();

    const trailCalls = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls;
    const ops = trailCalls.map((c) => c[0].operation);
    expect(ops).toContain('SUPPLIER_FETCH');
    expect(ops).toContain('VERIFIER_PASS');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('DRIVE_DELETE');
    expect(ops).toContain('BR_WRITE');
    // All trail rows tier=4.
    for (const c of trailCalls) {
      expect(c[0].tier).toBe(4);
    }
  });

  it('F2: Tier 1 verifier fail → cascades to Tier 2 (AI), writes on AI pass', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValueOnce({ match: false, reason: 'different model person' })
      .mockResolvedValueOnce({ match: true, reason: 'same product on AI model' });

    const { deps, brEntry, brIndex } = makeFixCtx({
      verifySameProductFn: verifySameProductFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('tier2_ai');
    expect(deps.generateModelImageFn).toHaveBeenCalledTimes(1);
    expect(deps.writeUpdatesFn).toHaveBeenCalledTimes(1);

    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('VERIFIER_FAIL');
    expect(ops).toContain('AI_REGEN');
    expect(ops).toContain('VERIFIER_PASS');
    expect(ops).toContain('BR_WRITE');
  });

  it('F3: fetchSSModelImage returns null → straight to Tier 2 (skips supplier verifier)', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const fetchSSModelImageFn = vi.fn().mockResolvedValue(null);

    const { deps, brEntry, brIndex } = makeFixCtx({
      fetchSSModelImageFn: fetchSSModelImageFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('tier2_ai');
    expect(deps.generateModelImageFn).toHaveBeenCalledTimes(1);

    const trailCalls = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls;
    const supplierRow = trailCalls.find((c) => c[0].operation === 'SUPPLIER_FETCH');
    expect(supplierRow).toBeTruthy();
    expect(supplierRow?.[0].notes).toMatch(/no canonical model/i);
    expect(supplierRow?.[0].tier).toBe(4);
  });

  it('F4: Tier 2 verifier fail → manual_cascade, NO BR write, NO trash', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const fetchSSModelImageFn = vi.fn().mockResolvedValue(null);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: false, reason: 'AI invented different garment' });

    const { deps, brEntry, brIndex } = makeFixCtx({
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      verifySameProductFn: verifySameProductFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('verifier_rejected');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();

    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('AI_REGEN');
    expect(ops).toContain('VERIFIER_FAIL');
  });

  it('F5: Tier 2 returns null (content policy or budget) → manual_cascade', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const fetchSSModelImageFn = vi.fn().mockResolvedValue(null);
    const generateModelImageFn = vi.fn().mockResolvedValue(null);

    const { deps, brEntry, brIndex } = makeFixCtx({
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('manual_cascade');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();

    const trailCalls = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls;
    const aiRegen = trailCalls.find((c) => c[0].operation === 'AI_REGEN');
    expect(aiRegen).toBeTruthy();
    expect(aiRegen?.[0].notes).toMatch(/generateModelImage returned null/i);
    expect(aiRegen?.[0].tier).toBe(4);
  });

  it('F6: T-17-09 compare-before-trash — uploadToDrive returns SAME fileId, NEVER trash', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const SAME = 'MODEL_SAME_ID_NEVERTRASH00';
    const uploadToDriveFn = vi.fn().mockResolvedValue(driveUrl(SAME));
    const trashDriveFileFn = vi.fn();

    const headerMap: Record<string, number> = {};
    BR_HEADER.forEach((h, i) => {
      headerMap[h] = i;
    });
    const row = makeBrRow({
      productId: 'S05610',
      colorName: 'ROYAL',
      FrontImage: driveUrl('FRONT_ID_XYZ12345678901234567890'),
      ModelFrontImage: driveUrl(SAME),
    });
    const brEntry = { rowIndex0: 1, row };
    const brIndex = {
      headerMap,
      rowByPid: new Map([['S05610', brEntry]]),
    };

    const deps = makeDeps({
      uploadToDriveFn: uploadToDriveFn as never,
      trashDriveFileFn: trashDriveFileFn as never,
    });

    await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(trashDriveFileFn).not.toHaveBeenCalled();
    const ops = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].operation,
    );
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).not.toContain('DRIVE_DELETE');
  });

  it('F7: T-17-10 budget cap — CostTracker.canAfford returns false → skip Tier 2', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(0.01); // less than one call
    const fetchSSModelImageFn = vi.fn().mockResolvedValue(null);
    const generateModelImageFn = vi.fn().mockResolvedValue(null);

    const { deps, brEntry, brIndex } = makeFixCtx({
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('budget_exhausted');
    expect(generateModelImageFn).not.toHaveBeenCalled();
  });

  it('F8: T-17-14 billing-hard-limit — throws BadRequestError, sets module flag, short-circuits', async () => {
    const { CostTracker } = await import('../../src/lib/cost-tracker.js');
    const tracker = new CostTracker(10);
    const OpenAI = (await import('openai')).default as unknown as {
      BadRequestError: new (msg: string, code?: string) => Error & { code?: string };
    };

    const fetchSSModelImageFn = vi.fn().mockResolvedValue(null);
    const generateModelImageFn = vi.fn().mockImplementation(async () => {
      throw new OpenAI.BadRequestError(
        'Billing hard limit has been reached for this account',
        'billing_hard_limit_reached',
      );
    });

    const { deps, brEntry, brIndex } = makeFixCtx({
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    const result = await fixModelImage(
      'S05610',
      'ModelFrontImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );

    expect(result.status).toBe('budget_exhausted');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();

    // A second call should short-circuit without invoking generateModelImage again.
    const before = (generateModelImageFn as ReturnType<typeof vi.fn>).mock.calls.length;
    const result2 = await fixModelImage(
      'S05610',
      'ModelSideImage' as ModelColumn,
      brEntry,
      brIndex,
      deps,
      'run-1',
      tracker,
    );
    const after = (generateModelImageFn as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBe(before);
    expect(result2.status).toBe('budget_exhausted');
  });
});

// ---------------------------------------------------------------------------
// ST1–ST3: sample-test runner
// ---------------------------------------------------------------------------

describe('runFixModelImages sample-test', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getFsWrites()).clear();
    __resetBillingExhaustedForTest();
  });

  it('ST1: sample-test pass-rate >= 0.7 → status OK, JSON written', async () => {
    // 10 pids — 5 cap (numeric pids), 5 garment pids
    const samplePids = [
      '168', 'A702', '6110', '112', 'NE220',
      'S05610', 'L00660', 'CE520L', '8882', '3001',
    ];
    const pollutedRows: PollutionRow[] = samplePids.map((pid) =>
      makePollutionRow({
        pid,
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(30, '0'))],
      }),
    );
    const brRows: string[][] = [
      BR_HEADER,
      ...samplePids.map((pid) =>
        makeBrRow({
          productId: pid,
          colorName: 'ROYAL',
          FrontImage: driveUrl(`FRONT_${pid}`.padEnd(30, '0')),
          ModelFrontImage: driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(30, '0')),
          baseCategory: pid === '168' || pid === '112' ? 'caps' : 'tops',
        }),
      ),
    ];

    // 8/10 fetchSSModelImage return a URL (caps 168 + 112 return null)
    const fetchSSModelImageFn = vi
      .fn()
      .mockImplementation(async (pid: string) => {
        if (pid === '168' || pid === '112') return null;
        return `https://www.ssactivewear.com/Style/${pid}_ROYAL_om_fl.jpg`;
      });

    // verifySameProduct: 7/10 pass at Tier 1, the remaining cascade to Tier 2.
    let verifyCallCount = 0;
    const passingTier1 = new Set(['A702', '6110', 'NE220', 'S05610', 'L00660', 'CE520L', '8882']);
    const verifySameProductFn = vi.fn().mockImplementation(async (_c, candidate: Buffer) => {
      verifyCallCount++;
      // First time: this is the Tier 1 supplier verification (candidate is supplier buf).
      // Determine pass/fail by the order — we'll cheat by matching by call count.
      // Simpler: we know that for the 8 supplier-fetched pids (all but 168 and 112),
      // 7 pass and 1 fails ('3001'). For Tier 2, we have 3 pids: 168, 112, 3001.
      // Of those, 2/3 succeed: 168 and 112 pass; 3001 fails on AI.
      void candidate;
      // Track candidate-by-marker: but we can't tell from buffer easily. Use call
      // ordering: caps return null at Tier 1 → no supplier-verifier call. So
      // among 10 pids in iteration order, supplier verifier fires for 8 of them
      // ('A702','6110','NE220','S05610','L00660','CE520L','8882','3001'), and 3001 fails.
      // Then 3 pids cascade to Tier 2 ('168','112','3001'); of those 168+112 pass, 3001 fails.
      // Total sequence (10 calls):
      //   1-8: supplier-verifier on A702,6110,NE220,S05610,L00660,CE520L,8882,3001
      //   9-11: AI-verifier on 168, 112, 3001
      const callIdx = verifyCallCount - 1;
      // Tier 1 supplier verifier calls
      if (callIdx < 7) return { match: true, reason: 'same product' };
      if (callIdx === 7) return { match: false, reason: 'different model' }; // 3001 fails Tier 1
      // Tier 2 AI verifier calls (3 of them: 168, 112, 3001)
      if (callIdx === 8 || callIdx === 9) return { match: true, reason: 'AI ok' };
      return { match: false, reason: 'AI different' }; // 3001 fails Tier 2
    });

    // generateModelImage returns a buffer for all 3 Tier-2 cascades
    const generateModelImageFn = vi.fn().mockResolvedValue({
      buffer: Buffer.from('ai-png'),
      cost: 0.126,
      callCount: 1,
      garmentDesc: 't-shirt',
      modelDescriptor: 'real person',
    });
    void passingTier1;

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: true,
        samplePids: undefined,
        skipSampleGate: false,
        maxCost: 1,
        dryRun: false,
        limit: undefined,
        reAudit: false,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      verifySameProductFn: verifySameProductFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    const result = await runFixModelImages(deps);

    expect(result.status).toBe('OK');
    expect(result.sample_pass_rate).toBeGreaterThanOrEqual(0.7);
    expect(result.sample_pass_rate).toBeLessThanOrEqual(1);

    const writes = await getFsWrites();
    const sampleEntry = [...writes.entries()].find(([k]) =>
      k.includes('fix-model-images-sample-'),
    );
    expect(sampleEntry).toBeTruthy();
    const json = JSON.parse(sampleEntry![1]);
    expect(json).toHaveProperty('sample_pass_rate');
    expect(json.sample_pass_rate).toBeGreaterThanOrEqual(0.7);
    expect(json.status).toBe('OK');
  });

  it('ST2: BLOCKED-SAMPLE-PASS-RATE when < 0.7 → exit 2', async () => {
    const samplePids = [
      '168', 'A702', '6110', '112', 'NE220',
      'S05610', 'L00660', 'CE520L', '8882', '3001',
    ];
    const pollutedRows: PollutionRow[] = samplePids.map((pid) =>
      makePollutionRow({
        pid,
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(30, '0'))],
      }),
    );
    const brRows: string[][] = [
      BR_HEADER,
      ...samplePids.map((pid) =>
        makeBrRow({
          productId: pid,
          colorName: 'ROYAL',
          FrontImage: driveUrl(`FRONT_${pid}`.padEnd(30, '0')),
          ModelFrontImage: driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(30, '0')),
        }),
      ),
    ];

    const fetchSSModelImageFn = vi
      .fn()
      .mockResolvedValue('https://ss.com/x_om_fl.jpg');
    // 4/10 Tier 1 pass; rest fail; Tier 2 also returns null for everyone.
    let calls = 0;
    const verifySameProductFn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= 4) return { match: true, reason: 'ok' };
      return { match: false, reason: 'different' };
    });
    const generateModelImageFn = vi.fn().mockResolvedValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: true,
        samplePids: undefined,
        skipSampleGate: false,
        maxCost: 1,
        dryRun: false,
        limit: undefined,
        reAudit: false,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      verifySameProductFn: verifySameProductFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    await expect(runFixModelImages(deps)).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);

    const errCalls = errSpy.mock.calls.flat().join(' ');
    expect(errCalls).toMatch(/BLOCKED-SAMPLE-PASS-RATE/);

    const writes = await getFsWrites();
    const sampleEntry = [...writes.entries()].find(([k]) =>
      k.includes('fix-model-images-sample-'),
    );
    expect(sampleEntry).toBeTruthy();
    const json = JSON.parse(sampleEntry![1]);
    expect(json.status).toBe('BLOCKED-SAMPLE-PASS-RATE');
    expect(json.sample_pass_rate).toBeLessThan(0.7);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('ST3: --sample-pids override processes only the listed pids', async () => {
    const pollutedRows: PollutionRow[] = ['A', 'B', 'C', 'D', 'E'].map((pid) =>
      makePollutionRow({
        pid,
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl(`${pid}_OLD`.padEnd(25, '0'))],
      }),
    );
    const brRows: string[][] = [
      BR_HEADER,
      ...['A', 'B', 'C', 'D', 'E'].map((pid) =>
        makeBrRow({
          productId: pid,
          colorName: 'ROYAL',
          FrontImage: driveUrl(`FRONT_${pid}`.padEnd(25, '0')),
          ModelFrontImage: driveUrl(`${pid}_OLD`.padEnd(25, '0')),
        }),
      ),
    ];

    const fetchSSModelImageFn = vi.fn().mockResolvedValue('https://ss.com/x_om_fl.jpg');

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: true,
        samplePids: ['A', 'B', 'C'],
        skipSampleGate: false,
        maxCost: 1,
        dryRun: false,
        limit: undefined,
        reAudit: false,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
    });

    await runFixModelImages(deps);

    // fetchSSModelImage called exactly 3 times — only A, B, C.
    expect((fetchSSModelImageFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    const calledPids = (fetchSSModelImageFn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledPids).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    expect(calledPids).not.toContain('D');
    expect(calledPids).not.toContain('E');
  });
});

// ---------------------------------------------------------------------------
// R1: Resume / loadProcessedPids
// ---------------------------------------------------------------------------

describe('Resume from trail', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getFsWrites()).clear();
    __resetBillingExhaustedForTest();
  });

  it('R1: loadProcessedPids skip — pid already in processed set is silently skipped', async () => {
    const pollutedRows: PollutionRow[] = [
      makePollutionRow({
        pid: 'S05610',
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl('S05_OLD_MODEL_AAAAAAAAA')],
      }),
      makePollutionRow({
        pid: 'L00660',
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl('L00_OLD_MODEL_BBBBBBBBB')],
      }),
    ];
    const brRows = [
      BR_HEADER,
      makeBrRow({
        productId: 'S05610',
        FrontImage: driveUrl('FRONT_S05_AAAAAAAAAAAAAAA'),
        ModelFrontImage: driveUrl('S05_OLD_MODEL_AAAAAAAAA'),
      }),
      makeBrRow({
        productId: 'L00660',
        FrontImage: driveUrl('FRONT_L00_BBBBBBBBBBBBBBB'),
        ModelFrontImage: driveUrl('L00_OLD_MODEL_BBBBBBBBB'),
      }),
    ];

    const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set(['S05610']));
    const fetchSSModelImageFn = vi.fn().mockResolvedValue('https://ss/x_om_fl.jpg');

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: false,
        samplePids: undefined,
        skipSampleGate: true,
        maxCost: 10,
        dryRun: false,
        limit: undefined,
        reAudit: false,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      loadProcessedPidsFn: loadProcessedPidsFn as never,
    });

    await runFixModelImages(deps);

    // Only L00660 was processed — S05610 silently skipped.
    expect((fetchSSModelImageFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((fetchSSModelImageFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('L00660');
  });
});

// ---------------------------------------------------------------------------
// FULL1–FULL2: Task 3 full-run + re-audit hook
// ---------------------------------------------------------------------------

describe('runFixModelImages full-run (Task 3)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await getFsWrites()).clear();
    __resetBillingExhaustedForTest();
  });

  it('FULL1: 213 synthetic pids — supplier 100 / AI 80 / 120 fixes total, JSON summary written', async () => {
    // 213 synthetic pids
    const pids = Array.from({ length: 213 }, (_, i) => `T${String(i).padStart(4, '0')}`);
    const pollutedRows: PollutionRow[] = pids.map((pid) =>
      makePollutionRow({
        pid,
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(28, '0'))],
      }),
    );
    const brRows: string[][] = [
      BR_HEADER,
      ...pids.map((pid) =>
        makeBrRow({
          productId: pid,
          colorName: 'ROYAL',
          FrontImage: driveUrl(`FRONT_${pid}`.padEnd(28, '0')),
          ModelFrontImage: driveUrl(`${pid}_OLD_MODEL_ID`.padEnd(28, '0')),
        }),
      ),
    ];

    // fetchSSModelImage returns URLs for pids[0..99]; null for the rest.
    const fetchSSModelImageFn = vi.fn().mockImplementation(async (pid: string) => {
      const idx = pids.indexOf(pid);
      if (idx < 0) return null;
      return idx < 100 ? `https://ss.com/${pid}_om_fl.jpg` : null;
    });

    // generateModelImage returns a buffer for pids[100..179] (80 pids); null for rest.
    const generateModelImageFn = vi.fn().mockImplementation(async () => {
      const callIdx = (generateModelImageFn as ReturnType<typeof vi.fn>).mock.calls.length - 1;
      return callIdx < 80
        ? {
            buffer: Buffer.from('ai'),
            cost: 0.04,
            callCount: 1,
            garmentDesc: 'tee',
            modelDescriptor: 'real',
          }
        : null;
    });

    // verifySameProduct: 70 of first 100 supplier (tier1) pass, 30 fail → cascade to tier2.
    // Then tier2 verifier: of the 30 cascaded + 113 direct cascades = 113 (only 80 get a buffer);
    // of those 80 buffers, 50 pass. The other (30 cascaded never had a buffer = null path).
    let supplierVerCalls = 0;
    let aiVerCalls = 0;
    const verifySameProductFn = vi.fn().mockImplementation(async (_c, candidate: Buffer) => {
      void _c;
      // Distinguish supplier vs AI calls by buffer content tag.
      if (candidate.toString() === 'supplier-png') {
        supplierVerCalls++;
        return supplierVerCalls <= 70
          ? { match: true, reason: 'ok' }
          : { match: false, reason: 'fail' };
      }
      // AI buffer
      aiVerCalls++;
      return aiVerCalls <= 50
        ? { match: true, reason: 'ok' }
        : { match: false, reason: 'fail' };
    });

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: false,
        samplePids: undefined,
        skipSampleGate: true,
        maxCost: 100,
        dryRun: false,
        limit: undefined,
        reAudit: false,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      verifySameProductFn: verifySameProductFn as never,
      generateModelImageFn: generateModelImageFn as never,
    });

    const result = await runFixModelImages(deps);

    expect(result.total_pids_processed).toBe(213);
    expect(result.tier1_fixed).toBe(70);
    // tier2_fixed depends on which pids cascade to AI. With our setup:
    //   - 100 pids have supplier URL → 70 pass tier1, 30 cascade to tier2 → first 30 calls to generateModelImage.
    //   - 113 pids have no supplier URL → straight to tier2 (calls 31..143). Only calls 1..80 return a buffer.
    //   - So 80 buffers total. Of those, 50 pass tier2 verifier.
    expect(result.tier2_fixed).toBe(50);
    expect(result.manual_cascade).toBe(213 - 70 - 50);

    const writes = await getFsWrites();
    const fullEntry = [...writes.entries()].find(([k]) =>
      k.includes('fix-model-images-full-'),
    );
    expect(fullEntry).toBeTruthy();
    const json = JSON.parse(fullEntry![1]);
    expect(json.total_pids_processed).toBe(213);
    expect(json.tier1_fixed).toBe(70);
    expect(json.tier2_fixed).toBe(50);
  });

  it('FULL2: --re-audit hook captures model_fail_after_count in the summary', async () => {
    const pids = ['A', 'B'];
    const pollutedRows: PollutionRow[] = pids.map((pid) =>
      makePollutionRow({
        pid,
        affected_columns: ['ModelFrontImage'],
        affected_drive_urls: [driveUrl(`${pid}_OLD`.padEnd(25, '0'))],
      }),
    );
    const brRows: string[][] = [
      BR_HEADER,
      ...pids.map((pid) =>
        makeBrRow({
          productId: pid,
          colorName: 'ROYAL',
          FrontImage: driveUrl(`FRONT_${pid}`.padEnd(25, '0')),
          ModelFrontImage: driveUrl(`${pid}_OLD`.padEnd(25, '0')),
        }),
      ),
    ];

    const fetchSSModelImageFn = vi.fn().mockResolvedValue('https://ss/x_om_fl.jpg');
    // Re-audit hook stub: a deps function that returns a synthetic count.
    const reAuditFn = vi.fn().mockResolvedValue(7);

    const deps = makeDeps({
      args: {
        auditFile: undefined,
        sampleOnly: false,
        samplePids: undefined,
        skipSampleGate: true,
        maxCost: 10,
        dryRun: false,
        limit: undefined,
        reAudit: true,
        help: false,
      },
      auditRowsOverride: pollutedRows as never,
      readRawRowsFn: vi.fn().mockResolvedValue(brRows) as never,
      fetchSSModelImageFn: fetchSSModelImageFn as never,
      reAuditFn: reAuditFn as never,
    });

    await runFixModelImages(deps);

    expect(reAuditFn).toHaveBeenCalledTimes(1);
    const writes = await getFsWrites();
    const fullEntry = [...writes.entries()].find(([k]) =>
      k.includes('fix-model-images-full-'),
    );
    expect(fullEntry).toBeTruthy();
    const json = JSON.parse(fullEntry![1]);
    expect(json.model_fail_before_count).toBe(312);
    expect(json.model_fail_after_count).toBe(7);
  });
});
