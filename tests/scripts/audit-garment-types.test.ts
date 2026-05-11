/**
 * Smoke tests for scripts/audit-garment-types.ts — Phase 15-03.
 *
 * Tests the DI seam (runGarmentTypeAudit) without any real network, fs writes,
 * or OpenAI client. Includes a static read-only invariant test (Test 7) that
 * fails if any future edit adds Drive/Sheets-write imports (T-15-Extra).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runGarmentTypeAudit,
  type RunGarmentTypeAuditDeps,
} from '../../scripts/audit-garment-types.js';

// ESM-safe __dirname (Vitest runs files as ESM in this project).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock the OpenAI SDK so importing scripts/audit-garment-types.ts (which
// imports `OpenAI` at module load) never constructs a real client during tests.
vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: vi.fn() } };
  }
  return { default: OpenAI };
});

type AnySheetRow = Record<string, string>;

function makeSheetRow(overrides: Partial<AnySheetRow> = {}): AnySheetRow {
  return {
    productId: 'PID-001',
    styleID: 'STYLE-001',
    colorName: 'navy',
    FrontImage: 'https://cdn.example.com/front.png',
    BackImage: 'https://cdn.example.com/back.png',
    DirectSideImage: 'https://cdn.example.com/side.png',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<RunGarmentTypeAuditDeps> = {},
): RunGarmentTypeAuditDeps {
  const fakeOpenAI = { chat: { completions: { create: vi.fn() } } } as never;
  const readAllRowsFn = vi
    .fn()
    .mockResolvedValue({ headers: [], rows: [makeSheetRow()] });
  const readRowRangeFn = vi
    .fn()
    .mockResolvedValue({ headers: [], rows: [], startIndex: 0 });
  const downloadImageFn = vi.fn().mockResolvedValue(Buffer.from('fake-image'));
  const verifierFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'both crewnecks' });
  const appendRejectRowFn = vi.fn().mockResolvedValue(undefined);

  return {
    args: { all: false, dryRun: false, help: false, styleId: 'STYLE-001' },
    sheetsClient: {},
    openai: fakeOpenAI,
    readAllRowsFn: readAllRowsFn as never,
    readRowRangeFn: readRowRangeFn as never,
    downloadImageFn: downloadImageFn as never,
    verifierFn: verifierFn as never,
    appendRejectRowFn: appendRejectRowFn as never,
    spreadsheetId: 'SHEET-X',
    sheetName: 'Sheet1',
    ...overrides,
  };
}

describe('runGarmentTypeAudit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1: mismatches on both back and side write 2 TSV rows', async () => {
    const deps = makeDeps({
      verifierFn: vi
        .fn()
        .mockResolvedValue({ match: false, reason: 'hoodie' }) as never,
    });
    const summary = await runGarmentTypeAudit(deps);

    expect(deps.appendRejectRowFn).toHaveBeenCalledTimes(2);
    expect(summary.mismatchCount).toBe(2);

    const call0 = (deps.appendRejectRowFn as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as {
      pid: string;
      view: string;
      reason: string;
      timestamp: string;
      run_id: string;
    };
    expect(call0.pid).toBe('PID-001');
    expect(call0.view).toMatch(/^(back|side)$/);
    expect(call0.reason).toBe('hoodie');
    expect(typeof call0.timestamp).toBe('string');
    expect(typeof call0.run_id).toBe('string');
  });

  it('Test 2: dry-run never calls verifier or TSV writer', async () => {
    const deps = makeDeps({
      args: { all: false, dryRun: true, help: false, styleId: 'STYLE-001' },
      verifierFn: vi
        .fn()
        .mockResolvedValue({ match: false, reason: 'hoodie' }) as never,
    });
    await runGarmentTypeAudit(deps);

    expect(deps.verifierFn).not.toHaveBeenCalled();
    expect(deps.appendRejectRowFn).not.toHaveBeenCalled();
  });

  it('Test 3: invalid front URL skips row without download/verify', async () => {
    const deps = makeDeps({
      readAllRowsFn: vi.fn().mockResolvedValue({
        headers: [],
        rows: [makeSheetRow({ FrontImage: '' })],
      }) as never,
    });
    const summary = await runGarmentTypeAudit(deps);

    expect(deps.downloadImageFn).not.toHaveBeenCalled();
    expect(deps.verifierFn).not.toHaveBeenCalled();
    expect(summary.skippedCount).toBe(1);
  });

  it('Test 4: download failure on front skips row, no crash', async () => {
    const deps = makeDeps({
      downloadImageFn: vi
        .fn()
        .mockRejectedValueOnce(new Error('404 not found')) as never,
    });
    const summary = await runGarmentTypeAudit(deps);

    expect(summary.skippedCount).toBeGreaterThanOrEqual(1);
    expect(summary.mismatchCount).toBe(0);
    expect(deps.appendRejectRowFn).not.toHaveBeenCalled();
  });

  it('Test 5: match=true means no TSV write', async () => {
    const deps = makeDeps({
      verifierFn: vi
        .fn()
        .mockResolvedValue({ match: true, reason: 'both crewnecks' }) as never,
    });
    const summary = await runGarmentTypeAudit(deps);

    expect(deps.appendRejectRowFn).not.toHaveBeenCalled();
    expect(summary.mismatchCount).toBe(0);
  });

  it('Test 6: --all --limit N caps product count', async () => {
    const rows = [
      makeSheetRow({ productId: 'P1', styleID: 'S1', colorName: 'navy' }),
      makeSheetRow({ productId: 'P2', styleID: 'S2', colorName: 'red' }),
      makeSheetRow({ productId: 'P3', styleID: 'S3', colorName: 'blue' }),
      makeSheetRow({ productId: 'P4', styleID: 'S4', colorName: 'green' }),
      makeSheetRow({ productId: 'P5', styleID: 'S5', colorName: 'pink' }),
    ];
    const deps = makeDeps({
      args: { all: true, dryRun: false, help: false, limit: 2 },
      readRowRangeFn: vi
        .fn()
        .mockResolvedValueOnce({ headers: [], rows, startIndex: 0 })
        .mockResolvedValue({ headers: [], rows: [], startIndex: 0 }) as never,
    });
    const summary = await runGarmentTypeAudit(deps);

    expect(summary.processedRows).toBe(2);
  });

  it('Test 7 (invariant): script file has no forbidden write-side imports', () => {
    const scriptPath = join(__dirname, '../../scripts/audit-garment-types.ts');
    const src = readFileSync(scriptPath, 'utf8');

    // Match only the import surface (not the safety-comment line that names
    // these tokens). Split into lines and inspect each `from '...'` clause.
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    const importBlob = importLines.join('\n');

    const forbiddenImportSources = [
      /from ['"]\.\.\/src\/sheets\/drive(\.js)?['"]/,
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
    const codeWithoutSafetyComment = src
      .split('\n')
      .filter((line) => !/MUST NEVER call/.test(line))
      .join('\n');

    const forbiddenSymbols = [/uploadToDrive/, /writeUpdates/, /buildStandardizationUpdates/];
    for (const re of forbiddenSymbols) {
      expect(
        codeWithoutSafetyComment.match(re),
        `Forbidden symbol matched outside safety comment: ${re}`,
      ).toBeNull();
    }
  });
});
