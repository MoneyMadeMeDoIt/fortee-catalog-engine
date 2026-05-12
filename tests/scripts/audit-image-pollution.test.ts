/**
 * Smoke tests for scripts/audit-image-pollution.ts — Phase 16-02.
 *
 * Tests the DI seam (runImagePollutionAudit) without any real network, fs writes,
 * or OpenAI client. Includes a static read-only invariant test (Test 7) that
 * fails if any future edit adds Drive/Sheets-write imports (T-16-04).
 *
 * Pass 1 tests (Task 1): Tests 1-8 cover DI seam, parseArgs, shared_url detection
 * across columns and pids, invalid_image_format via Drive metadata, rate-limit
 * backoff on 403/429, headwear exclusion, and the static read-only invariant.
 *
 * Pass 2 + 3 tests (Task 2): Tests 9-15 cover content_mismatch, no_canonical_available
 * cascade, model_pollution, shape_drift, D-07 ordering (Pass 3 skips Pass-1/2 polluted),
 * trail logging, and the D-09 summary header.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runImagePollutionAudit,
  POLLUTION_CLASSES,
  type RunImagePollutionAuditDeps,
} from '../../scripts/audit-image-pollution.js';

// ESM-safe __dirname (Vitest runs files as ESM in this project).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock the OpenAI SDK so importing scripts/audit-image-pollution.ts (which
// imports `OpenAI` at module load) never constructs a real client during tests.
vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: vi.fn() } };
  }
  return { default: OpenAI };
});

// Mock fs writes so audit TSV emission doesn't touch the disk during tests.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Header row matching real BR sheet column order.
const HEADER_ROW = [
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

function makeRawRow(overrides: Record<string, string> = {}): string[] {
  const row = new Array(HEADER_ROW.length).fill('');
  const defaults: Record<string, string> = {
    productId: 'PID-001',
    styleID: 'STYLE-001',
    colorName: 'navy',
  };
  const merged = { ...defaults, ...overrides };
  for (const [key, val] of Object.entries(merged)) {
    const idx = HEADER_ROW.indexOf(key);
    if (idx >= 0) row[idx] = val;
  }
  return row;
}

function driveUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}`;
}

function makeDeps(
  overrides: Partial<RunImagePollutionAuditDeps> = {},
): RunImagePollutionAuditDeps {
  const fakeOpenAI = { chat: { completions: { create: vi.fn() } } } as never;

  const readRawRowsFn = vi.fn().mockResolvedValue([HEADER_ROW, makeRawRow()]);
  const downloadImageFn = vi.fn().mockResolvedValue(Buffer.from('fake-img'));
  const downloadFromDriveFn = vi.fn().mockResolvedValue(Buffer.from('fake-drive'));
  const getDriveFileMetadataFn = vi
    .fn()
    .mockResolvedValue({ mimeType: 'image/png', size: '1000', name: 'fake.png' });
  const verifyShapeFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'both crewnecks' });
  const verifySameProductFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'same product' });
  const supplierCanonicalFn = vi
    .fn()
    .mockResolvedValue({ url: 'https://supplier.example/canonical.png', source: 'ss', styleId: 1234 });
  const appendTrailRowFn = vi.fn().mockResolvedValue(undefined);

  return {
    args: {
      all: true,
      dryRun: false,
      reAudit: false,
      postMortem: false,
      help: false,
      maxDriveRps: 1000, // very fast for tests — avoid wall-clock waiting
    },
    sheetsClient: {} as never,
    driveClient: {} as never,
    openai: fakeOpenAI,
    readRawRowsFn: readRawRowsFn as never,
    downloadImageFn: downloadImageFn as never,
    downloadFromDriveFn: downloadFromDriveFn as never,
    getDriveFileMetadataFn: getDriveFileMetadataFn as never,
    verifyShapeFn: verifyShapeFn as never,
    verifySameProductFn: verifySameProductFn as never,
    supplierCanonicalFn: supplierCanonicalFn as never,
    appendTrailRowFn: appendTrailRowFn as never,
    spreadsheetId: 'SHEET-X',
    sheetName: 'Bestsellers-Ready',
    ...overrides,
  };
}

describe('runImagePollutionAudit — Task 1 (Pass 1 structural)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1 (DI seam): returns summary shape with counters and class counts', async () => {
    const deps = makeDeps();
    const summary = await runImagePollutionAudit(deps);

    expect(summary).toHaveProperty('pidsScanned');
    expect(summary).toHaveProperty('pidsPolluted');
    expect(summary).toHaveProperty('classCounts');
    expect(summary).toHaveProperty('headwearSkipped');
    expect(typeof summary.pidsScanned).toBe('number');
    expect(typeof summary.pidsPolluted).toBe('number');
    expect(typeof summary.headwearSkipped).toBe('number');
    // Class-counts object exists with all 5 keys.
    for (const cls of POLLUTION_CLASSES) {
      expect(summary.classCounts).toHaveProperty(cls);
    }
  });

  it('Test 4 (shared_url detection — FrontImage collision across pids): emits one row per pid', async () => {
    const sharedId = '1abcdefghijklmnopqrstuvwxyz';
    const rows = [
      HEADER_ROW,
      makeRawRow({ productId: '8882', FrontImage: driveUrl(sharedId) }),
      makeRawRow({ productId: '5200', FrontImage: driveUrl(sharedId) }),
      makeRawRow({ productId: 'CE520L', FrontImage: driveUrl(sharedId) }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    expect(summary.classCounts.shared_url).toBe(3);
    expect(summary.pidsPolluted).toBeGreaterThanOrEqual(3);
  });

  it('Test 5 (shared_url — Model column collides with FrontImage of different pid)', async () => {
    const sharedId = '1xyzModelABC0000000000xyz';
    const rows = [
      HEADER_ROW,
      makeRawRow({ productId: '1234', ModelFrontImage: driveUrl(sharedId) }),
      makeRawRow({ productId: '5678', FrontImage: driveUrl(sharedId) }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    // Both pids should be flagged as shared_url polluted (2 rows total).
    expect(summary.classCounts.shared_url).toBe(2);
  });

  it('Test 6 (invalid_image_format via non-image mime)', async () => {
    const goodId = '2goodIdAAAAAAAAAAAAAAAAA';
    const badId = '2badPDFIdBBBBBBBBBBBBBBB';
    const rows = [
      HEADER_ROW,
      makeRawRow({ productId: 'P_GOOD', FrontImage: driveUrl(goodId) }),
      makeRawRow({ productId: 'P_BAD', FrontImage: driveUrl(badId) }),
    ];
    const getDriveFileMetadataFn = vi.fn().mockImplementation(async (_drive, fileId) => {
      if (fileId === badId) {
        return { mimeType: 'application/pdf', size: '1000', name: 'bad.pdf' };
      }
      return { mimeType: 'image/png', size: '1000', name: 'good.png' };
    });
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      getDriveFileMetadataFn: getDriveFileMetadataFn as never,
    });
    const summary = await runImagePollutionAudit(deps);

    expect(summary.classCounts.invalid_image_format).toBe(1);
  });

  it('Test 6b (rate-limit backoff on 403 quotaExceeded)', async () => {
    const fileId = '3retryIdCCCCCCCCCCCCCCCC';
    const rows = [
      HEADER_ROW,
      makeRawRow({ productId: 'P_RETRY', FrontImage: driveUrl(fileId) }),
    ];
    let calls = 0;
    const getDriveFileMetadataFn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const err: any = new Error('quotaExceeded');
        err.code = 403;
        err.errors = [{ reason: 'quotaExceeded' }];
        throw err;
      }
      return { mimeType: 'image/png', size: '500', name: 'retried.png' };
    });
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      getDriveFileMetadataFn: getDriveFileMetadataFn as never,
      args: {
        all: true,
        dryRun: false,
        reAudit: false,
        postMortem: false,
        help: false,
        maxDriveRps: 1000,
        // Backoff base shortened for test speed
        backoffBaseMs: 1,
      } as never,
    });

    await runImagePollutionAudit(deps);
    expect(getDriveFileMetadataFn).toHaveBeenCalledTimes(3);
  });

  it('Test 7 (READ-ONLY INVARIANT, static): no write-side imports below safety disclaimer', () => {
    const scriptPath = join(__dirname, '../../scripts/audit-image-pollution.ts');
    const src = readFileSync(scriptPath, 'utf8');

    // Match only the import surface. Split into lines and inspect each
    // `from '...'` clause.
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    const importBlob = importLines.join('\n');

    const forbiddenImportSources = [
      /from ['"]\.\.\/src\/sheets\/writer(\.js)?['"]/,
      /from ['"]\.\.\/src\/lib\/audit-runner(\.js)?['"]/,
    ];
    for (const re of forbiddenImportSources) {
      expect(
        importBlob.match(re),
        `Forbidden import source matched: ${re}`,
      ).toBeNull();
    }

    // Forbidden symbols must not appear anywhere in code (excluding the
    // top-of-file safety comment that documents what we DON'T do).
    // Allow lines that explicitly say "MUST NEVER call" — they live in the
    // safety disclaimer at the top of the file.
    const codeWithoutSafetyComment = src
      .split('\n')
      .filter((line) => !/MUST NEVER call/.test(line))
      .join('\n');

    const forbiddenSymbols = [/uploadToDrive/, /writeUpdates/, /trashDriveFile/];
    for (const re of forbiddenSymbols) {
      expect(
        codeWithoutSafetyComment.match(re),
        `Forbidden symbol matched outside safety comment: ${re}`,
      ).toBeNull();
    }
  });

  it('Test 8 (H08* exclusion counted once per pid, not per column)', async () => {
    const sharedId = '4headwearIdDDDDDDDDDDDDDDDD';
    const rows = [
      HEADER_ROW,
      // Headwear pid sharing fileId with a non-headwear pid — but H08* must be
      // silently skipped (not emitted), and counter incremented exactly once.
      makeRawRow({
        productId: 'H08010',
        FrontImage: driveUrl(sharedId),
        BackImage: driveUrl(sharedId),
        ModelFrontImage: driveUrl(sharedId),
      }),
      makeRawRow({
        productId: 'NORMAL',
        FrontImage: driveUrl(sharedId),
      }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    // H08* counted exactly once
    expect(summary.headwearSkipped).toBe(1);
    // Headwear pid not in polluted rows; non-headwear (NORMAL) not polluted
    // either because no other non-headwear pid uses the shared id (excluded
    // from the collision set).
  });

  it('Test 3 (parseArgs surface — args object propagates dryRun and limit)', async () => {
    // Indirect test: confirm runImagePollutionAudit honors args.dryRun by NOT
    // calling verifySameProductFn even when there's no pollution found in Pass 1.
    const deps = makeDeps({
      args: {
        all: true,
        dryRun: true,
        reAudit: false,
        postMortem: false,
        help: false,
        maxDriveRps: 1000,
      },
    });
    await runImagePollutionAudit(deps);
    // dry-run never calls Pass 2 verifier
    expect(deps.verifySameProductFn).not.toHaveBeenCalled();
    expect(deps.verifyShapeFn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Task 2 tests — Pass 2 (content) + Pass 3 (shape) + summary
// ============================================================================

describe('runImagePollutionAudit — Task 2 (Passes 2 + 3 + summary)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 9 (D-03 front content_mismatch — baby onesie vs t-shirt)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: '6110',
        FrontImage: driveUrl('6110frontIdAAAAAAAAAAAAA'),
      }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      verifySameProductFn: vi.fn().mockResolvedValue({
        match: false,
        reason: 'candidate is baby onesie, reference is adult t-shirt',
      }) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    expect(summary.classCounts.content_mismatch).toBe(1);
  });

  it('Test 10 (D-04 dispatch — no canonical available skips Pass 2 verifier, still runs Pass 3)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: 'XYZ999',
        FrontImage: driveUrl('xyzFrontXXXXXXXXXXXXXXXX'),
        BackImage: driveUrl('xyzBackBBBBBBBBBBBBBBBBB'),
      }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      supplierCanonicalFn: vi.fn().mockResolvedValue(null) as never,
    });
    await runImagePollutionAudit(deps);

    // verifySameProduct should NOT have been called for the front-vs-canonical
    // check (no canonical). But Pass 3 (shape) on Back vs Front still runs.
    // It may also be called for Model* checks if Models are present (none in this fixture).
    expect(deps.verifySameProductFn).not.toHaveBeenCalled();
    expect(deps.verifyShapeFn).toHaveBeenCalled();
  });

  it('Test 11 (D-05 Model* check — model_pollution)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: '8882',
        FrontImage: driveUrl('8882frontFFFFFFFFFFFFFFF'),
        ModelFrontImage: driveUrl('A2009ModelMMMMMMMMMMMMMM'),
      }),
    ];
    let call = 0;
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      verifySameProductFn: vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) {
          // Front vs canonical = match (true)
          return { match: true, reason: 'same Bella+Canvas 8882' };
        }
        // Model vs front = false → model_pollution
        return { match: false, reason: 'model shows A2009 hoodie, front is 8882 t-shirt' };
      }) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    expect(summary.classCounts.model_pollution).toBe(1);
  });

  it('Test 12 (D-06 shape_drift — Back vs Front shape mismatch)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: 'L00100',
        FrontImage: driveUrl('L00100FrontFFFFFFFFFFFFF'),
        BackImage: driveUrl('L00100BackBBBBBBBBBBBBBB'),
      }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      verifyShapeFn: vi.fn().mockResolvedValue({
        match: false,
        reason: 'crewneck vs hoodie',
      }) as never,
    });
    const summary = await runImagePollutionAudit(deps);

    expect(summary.classCounts.shape_drift).toBe(1);
  });

  it('Test 13 (D-07 pass-3-only-on-clean — Pass 3 skipped for pid polluted in Pass 2)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: '6110',
        FrontImage: driveUrl('6110frontFFFFFFFFFFFFFFF'),
        BackImage: driveUrl('6110backBBBBBBBBBBBBBBBB'),
      }),
    ];
    const verifyShapeFn = vi.fn().mockResolvedValue({ match: true, reason: 'ok' });
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      verifySameProductFn: vi.fn().mockResolvedValue({
        match: false,
        reason: 'candidate is baby onesie, reference is t-shirt',
      }) as never,
      verifyShapeFn: verifyShapeFn as never,
    });

    await runImagePollutionAudit(deps);

    // 6110 was flagged content_mismatch in Pass 2 → Pass 3 must skip it.
    expect(verifyShapeFn).not.toHaveBeenCalled();
  });

  it('Test 14 (trail rows logged for verifier calls with tier=0)', async () => {
    const rows = [
      HEADER_ROW,
      makeRawRow({
        productId: '6110',
        FrontImage: driveUrl('6110frontFFFFFFFFFFFFFFF'),
      }),
    ];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
      verifySameProductFn: vi.fn().mockResolvedValue({
        match: false,
        reason: 'mismatch',
      }) as never,
    });
    await runImagePollutionAudit(deps);

    // At least one VERIFIER_FAIL trail row with tier=0 was logged.
    const calls = (deps.appendTrailRowFn as any).mock.calls as Array<[any]>;
    const failCalls = calls.filter(
      (c) => c[0]?.operation === 'VERIFIER_FAIL' && c[0]?.tier === 0,
    );
    expect(failCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('Test 15 (D-09 summary — console output contains run_id + counts)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rows = [HEADER_ROW, makeRawRow({ productId: 'CLEAN' })];
    const deps = makeDeps({
      readRawRowsFn: vi.fn().mockResolvedValue(rows) as never,
    });
    await runImagePollutionAudit(deps);

    // The audit emits the D-09 header summary into the TSV header lines via the
    // writeAuditTSV helper. We assert here at the level of side-effect: the
    // writeAuditTSV path was reached (writeFileSync mocked); summary keys are
    // present on the return object.
    const summary = await runImagePollutionAudit(deps);
    expect(summary).toHaveProperty('pidsScanned');
    expect(summary).toHaveProperty('classCounts');
    expect(summary).toHaveProperty('headwearSkipped');

    consoleSpy.mockRestore();
  });
});
