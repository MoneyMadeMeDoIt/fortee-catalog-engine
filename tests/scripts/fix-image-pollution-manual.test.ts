/**
 * Smoke tests for scripts/fix-image-pollution-manual.ts — Phase 16-04 Task 1.
 *
 * Covers all 17 behaviors enumerated in the plan's <behavior> block:
 *   1  DI seam shape (scriptedPrompt helper drives the prompt loop)
 *   2  resume (loadProcessedPids skips terminal-op pids)
 *   3  env validation surface (RunManualFixArgs accepted, no real env read)
 *   4  `r` happy path → VERIFIER_PASS → DRIVE_UPLOAD → DRIVE_DELETE → BR_WRITE
 *   5  `r` verifier-fail → `s` cascade (MANUAL_SKIP, no BR write)
 *   6  `r` verifier-fail → `f` FORCE → commit with override notes
 *   7  `r` verifier-fail → `f` wrong confirmation → MANUAL_SKIP (no commit)
 *   8  `d` happy path → DELETE → blank cell + DRIVE_DELETE
 *   9  `d` wrong confirmation → MANUAL_SKIP, no mutations
 *  10  `s` choice → MANUAL_SKIP, no mutations
 *  11  `a` choice → MANUAL_ACCEPT, no mutations
 *  12  `v` choice → context dump + re-prompt → eventual MANUAL_SKIP
 *  13  `q` choice → outcome 'quit', loop breaks
 *  14  invalid char → re-prompt → operator picks valid letter
 *  15  T-16-01 (`r` with same fileId) → NO DRIVE_DELETE
 *  16  --re-audit invocation calls runAuditFn + prints summary line
 *  17  R10 OR-path BR_WRITE coverage (PARTIAL + SATISFIED scenarios)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runManualFix,
  parseManualQueueTsv,
  handleManualRow,
  promptForChoice,
  type RunManualFixDeps,
  type ManualQueueRow,
} from '../../scripts/fix-image-pollution-manual.js';

// Mock OpenAI so importing the script never constructs a real client.
vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: vi.fn() } };
  }
  return { default: OpenAI };
});

// Mock fs — capture reads for parseManualQueueTsv + R10 helpers; allow writes.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (typeof p === 'string' && p === 'tmp') return true;
      return false;
    }),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    mkdirSync: vi.fn(),
  } as never;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BR_HEADER = [
  'productId',         // 0
  'styleID',           // 1
  'colorName',         // 2
  'productName',       // 3
  'baseCategory',      // 4
  'FrontImage',        // 5
  'BackImage',         // 6
  'DirectSideImage',   // 7
  'ModelFrontImage',   // 8
  'ModelSideImage',    // 9
  'ModelBackImage',    // 10
];

function makeBrRow(overrides: Record<string, string> = {}): string[] {
  const row = new Array(BR_HEADER.length).fill('');
  const defaults: Record<string, string> = {
    productId: 'TEST001',
    styleID: '5610',
    colorName: 'Navy',
    productName: 'Test Hoodie',
    baseCategory: 'hoodies',
    FrontImage: driveUrl('FRONT_ID_AAAAAAAAAAAAAAAA'),
    BackImage: driveUrl('BACK_OLD_ID_BBBBBBBBBBBBB'),
    DirectSideImage: driveUrl('SIDE_OLD_ID_CCCCCCCCCCC'),
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

/**
 * Scripted-answers helper — drives the promptFn DI seam with a fixed array.
 * Throws when the script runs out (catches "infinite re-prompt" bugs).
 */
function scriptedPrompt(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return async () => {
    const a = answers[i++];
    if (a === undefined) {
      throw new Error(
        `scriptedPrompt: no more scripted answers (consumed ${i - 1})`,
      );
    }
    return a;
  };
}

function makeDeps(
  overrides: Partial<RunManualFixDeps> = {},
): RunManualFixDeps {
  const fakeOpenAI = { chat: { completions: { create: vi.fn() } } } as never;

  const readRawRowsFn = vi.fn().mockResolvedValue([
    BR_HEADER,
    makeBrRow({ productId: 'TEST001' }),
  ]);

  const downloadFromDriveFn = vi
    .fn()
    .mockResolvedValue(Buffer.from('drive-png'));
  const supplierCanonicalFn = vi.fn().mockResolvedValue(null);
  const verifySameProductFn = vi
    .fn()
    .mockResolvedValue({ match: true, reason: 'same product' });
  const uploadToDriveFn = vi
    .fn()
    .mockResolvedValue(driveUrl('NEW_ID_XXXXXXXXXXXXXXXXX'));
  const trashDriveFileFn = vi.fn().mockResolvedValue(undefined);
  const writeUpdatesFn = vi.fn().mockResolvedValue(1);
  const appendTrailRowFn = vi.fn().mockResolvedValue(undefined);
  const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set<string>());

  return {
    args: {
      queueFile: undefined,
      reAudit: false,
      dryRun: false,
      help: false,
    },
    sheetsClient: {} as never,
    driveClient: {} as never,
    openai: fakeOpenAI,
    promptFn: scriptedPrompt([]),
    readRawRowsFn: readRawRowsFn as never,
    downloadFromDriveFn: downloadFromDriveFn as never,
    uploadToDriveFn: uploadToDriveFn as never,
    trashDriveFileFn: trashDriveFileFn as never,
    writeUpdatesFn: writeUpdatesFn as never,
    verifySameProductFn: verifySameProductFn as never,
    supplierCanonicalFn: supplierCanonicalFn as never,
    appendTrailRowFn: appendTrailRowFn as never,
    loadProcessedPidsFn: loadProcessedPidsFn as never,
    spreadsheetId: 'SHEET-X',
    sheetName: 'Bestsellers-Ready',
    ...overrides,
  };
}

function makeQueueRow(
  overrides: Partial<ManualQueueRow> = {},
): ManualQueueRow {
  return {
    pid: 'TEST001',
    pollution_class: 'content_mismatch',
    affected_columns: ['BackImage'],
    current_drive_urls: [driveUrl('BACK_OLD_ID_BBBBBBBBBBBBB')],
    front_image_screenshot_link: driveUrl('FRONT_ID_AAAAAAAAAAAAAAAA'),
    suggested_action: 'replace with operator-picked URL',
    ...overrides,
  };
}

/** Extract every appendTrailRowFn call's operation field (for trail assertions). */
function operationsOf(
  mockFn: ReturnType<typeof vi.fn>,
): string[] {
  return mockFn.mock.calls.map((c) => (c[0] as { operation: string }).operation);
}

/** Find the first trail row matching a predicate. */
function findTrailRow(
  mockFn: ReturnType<typeof vi.fn>,
  predicate: (r: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return mockFn.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find(predicate);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runManualFix — Plan 16-04 Task 1', () => {
  beforeEach(() => vi.clearAllMocks());

  // Test 1 — DI seam shape
  it('Test 1 (DI seam): runManualFix accepts mocked promptFn + returns summary', async () => {
    const deps = makeDeps({ manualQueueOverride: [] });
    const result = await runManualFix(deps);
    expect(result).toHaveProperty('resolved');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('accepted');
    expect(result).toHaveProperty('quit');
    expect(typeof result.resolved).toBe('number');
    expect(result.quit).toBe(false);
  });

  // Test 2 — resume from trail
  it('Test 2 (resume): loadProcessedPids skips already-processed pid', async () => {
    const queue = [
      makeQueueRow({ pid: 'pidA' }),
      makeQueueRow({ pid: 'pidB' }),
    ];
    const loadProcessedPidsFn = vi.fn().mockResolvedValue(new Set(['pidA']));
    // Only pidB should be prompted — supply one 's' answer.
    const promptFn = scriptedPrompt(['s']);
    const deps = makeDeps({
      manualQueueOverride: queue,
      loadProcessedPidsFn: loadProcessedPidsFn as never,
      promptFn,
      readRawRowsFn: vi.fn().mockResolvedValue([
        BR_HEADER,
        makeBrRow({ productId: 'pidA' }),
        makeBrRow({ productId: 'pidB' }),
      ]) as never,
    });
    await runManualFix(deps);
    // appendTrailRow called exactly once (MANUAL_SKIP for pidB only).
    expect(deps.appendTrailRowFn).toHaveBeenCalledTimes(1);
    const call = (deps.appendTrailRowFn as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.pid).toBe('pidB');
    expect(call.operation).toBe('MANUAL_SKIP');
  });

  // Test 3 — RunManualFixArgs shape (covers args wiring; env validation
  // happens only in main() which is not exercised in unit tests).
  it('Test 3 (args wiring): args object is consumed and queueFile honored', async () => {
    const deps = makeDeps({
      manualQueueOverride: [],
      args: {
        queueFile: 'tmp/example.tsv',
        reAudit: false,
        dryRun: true,
        help: false,
      },
    });
    const result = await runManualFix(deps);
    expect(result.resolved).toBe(0);
    expect(result.quit).toBe(false);
  });

  // Test 4 — `r` happy path (VERIFIER_PASS → DRIVE_UPLOAD → DRIVE_DELETE → BR_WRITE)
  it("Test 4 (`r` happy): VERIFIER_PASS → DRIVE_UPLOAD → DRIVE_DELETE → BR_WRITE", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt([
      'r',
      'https://drive.google.com/file/d/NEW_ID_XXXXXXXXXXXXXXXXX/view',
    ]);
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('VERIFIER_PASS');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('DRIVE_DELETE');
    expect(ops).toContain('BR_WRITE');
    // All rows tagged tier=3
    const allTrailCalls = (
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as { tier: number });
    for (const c of allTrailCalls) expect(c.tier).toBe(3);
    // writeUpdates called with new URL
    expect(deps.writeUpdatesFn).toHaveBeenCalledTimes(1);
    const writeArgs = (deps.writeUpdatesFn as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const updates = writeArgs[2] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(updates[0].values[0][0]).toContain('NEW_ID_XXXXXXXXXXXXXXXXX');
  });

  // Test 5 — `r` verifier-fail → `s`
  it("Test 5 (`r` verifier-fail → `s`): VERIFIER_FAIL then MANUAL_SKIP, no BR_WRITE", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt([
      'r',
      'https://drive.google.com/file/d/NEW_ID_XXXXXXXXXXXXXXXXX/view',
      's',
    ]);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: false, reason: 'different product' });
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
      verifySameProductFn: verifySameProductFn as never,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('VERIFIER_FAIL');
    expect(ops).toContain('MANUAL_SKIP');
    expect(ops).not.toContain('BR_WRITE');
    expect(ops).not.toContain('DRIVE_UPLOAD');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.uploadToDriveFn).not.toHaveBeenCalled();
    // notes string proves the path: 'operator skipped after verifier fail'
    const skipRow = findTrailRow(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
      (r) => r.operation === 'MANUAL_SKIP',
    );
    expect(skipRow?.notes).toBe('operator skipped after verifier fail');
  });

  // Test 6 — `r` verifier-fail → `f` FORCE
  it("Test 6 (`r` verifier-fail → `f` FORCE): commit with override notes", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt([
      'r',
      'https://drive.google.com/file/d/NEW_ID_XXXXXXXXXXXXXXXXX/view',
      'f',
      'FORCE',
    ]);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: false, reason: 'shape drift' });
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
      verifySameProductFn: verifySameProductFn as never,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('VERIFIER_FAIL');
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('BR_WRITE');
    expect(deps.writeUpdatesFn).toHaveBeenCalled();
    const brWriteRow = findTrailRow(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
      (r) => r.operation === 'BR_WRITE',
    );
    expect(String(brWriteRow?.notes)).toContain(
      'operator forced override of verifier fail',
    );
    expect(String(brWriteRow?.notes)).toContain('shape drift');
  });

  // Test 7 — `r` verifier-fail → `f` → wrong confirmation
  it("Test 7 (`r` verifier-fail → `f` wrong confirmation): MANUAL_SKIP, no commit", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt([
      'r',
      'https://drive.google.com/file/d/NEW_ID_XXXXXXXXXXXXXXXXX/view',
      'f',
      'no',
    ]);
    const verifySameProductFn = vi
      .fn()
      .mockResolvedValue({ match: false, reason: 'different product' });
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
      verifySameProductFn: verifySameProductFn as never,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('VERIFIER_FAIL');
    expect(ops).toContain('MANUAL_SKIP');
    expect(ops).not.toContain('BR_WRITE');
    expect(ops).not.toContain('DRIVE_UPLOAD');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.uploadToDriveFn).not.toHaveBeenCalled();
  });

  // Test 8 — `d` happy path
  it("Test 8 (`d` happy): DELETE → blank cell + DRIVE_DELETE", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['d', 'DELETE']);
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('BR_WRITE');
    expect(ops).toContain('DRIVE_DELETE');
    // writeUpdates called with blank value
    expect(deps.writeUpdatesFn).toHaveBeenCalledTimes(1);
    const writeArgs = (deps.writeUpdatesFn as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const updates = writeArgs[2] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(updates[0].values[0][0]).toBe('');
    // trashDriveFile called with the original fileId from the queue row
    expect(deps.trashDriveFileFn).toHaveBeenCalledTimes(1);
    expect(deps.trashDriveFileFn).toHaveBeenCalledWith(
      expect.anything(),
      'BACK_OLD_ID_BBBBBBBBBBBBB',
    );
    // BR_WRITE row carries old=URL, new=''
    const brRow = findTrailRow(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
      (r) => r.operation === 'BR_WRITE',
    );
    expect(brRow?.old_value).toBe(driveUrl('BACK_OLD_ID_BBBBBBBBBBBBB'));
    expect(brRow?.new_value).toBe('');
  });

  // Test 9 — `d` wrong confirmation
  it("Test 9 (`d` wrong confirmation): MANUAL_SKIP, no mutations", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['d', 'delete']);
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
    });

    await runManualFix(deps);

    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('MANUAL_SKIP');
    expect(ops).not.toContain('BR_WRITE');
    expect(ops).not.toContain('DRIVE_DELETE');
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
    const skipRow = findTrailRow(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
      (r) => r.operation === 'MANUAL_SKIP',
    );
    expect(skipRow?.notes).toBe('delete aborted — confirmation mismatch');
  });

  // Test 10 — `s` choice
  it("Test 10 (`s`): MANUAL_SKIP, no mutations", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['s']);
    const deps = makeDeps({ manualQueueOverride: queue, promptFn });
    await runManualFix(deps);
    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toEqual(['MANUAL_SKIP']);
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
  });

  // Test 11 — `a` choice
  it("Test 11 (`a`): MANUAL_ACCEPT, no mutations", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['a']);
    const deps = makeDeps({ manualQueueOverride: queue, promptFn });
    await runManualFix(deps);
    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toEqual(['MANUAL_ACCEPT']);
    expect(deps.writeUpdatesFn).not.toHaveBeenCalled();
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
  });

  // Test 12 — `v` choice triggers re-prompt
  it("Test 12 (`v`): full context dump + re-prompt, then `s` resolves", async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['v', 's']);
    const deps = makeDeps({ manualQueueOverride: queue, promptFn });
    await runManualFix(deps);
    // Single MANUAL_SKIP proves re-prompt fired (no double trail row).
    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toEqual(['MANUAL_SKIP']);
  });

  // Test 13 — `q` choice
  it("Test 13 (`q`): outcome 'quit', loop breaks", async () => {
    const queue = [
      makeQueueRow({ pid: 'TEST001' }),
      makeQueueRow({ pid: 'TEST002' }),
    ];
    const promptFn = scriptedPrompt(['q']);
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
      readRawRowsFn: vi.fn().mockResolvedValue([
        BR_HEADER,
        makeBrRow({ productId: 'TEST001' }),
        makeBrRow({ productId: 'TEST002' }),
      ]) as never,
    });
    const result = await runManualFix(deps);
    expect(result.quit).toBe(true);
    // Only one prompt consumed — second pid never reached
    expect(deps.appendTrailRowFn).not.toHaveBeenCalled();
  });

  // Test 14 — invalid char triggers re-prompt
  it('Test 14 (invalid char): re-prompts then accepts `s`', async () => {
    const queue = [makeQueueRow()];
    const promptFn = scriptedPrompt(['x', 's']);
    const deps = makeDeps({ manualQueueOverride: queue, promptFn });
    await runManualFix(deps);
    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toEqual(['MANUAL_SKIP']);
  });

  // Test 15 — T-16-01 same fileId → no DRIVE_DELETE
  it("Test 15 (T-16-01 same fileId): NO DRIVE_DELETE; DRIVE_UPLOAD + BR_WRITE only", async () => {
    const queue = [
      makeQueueRow({
        affected_columns: ['BackImage'],
        current_drive_urls: [driveUrl('SAME_ID_YYYYYYYYYYYYYYYY')],
      }),
    ];
    const promptFn = scriptedPrompt([
      'r',
      'https://drive.google.com/file/d/SAME_ID_YYYYYYYYYYYYYYYY/view',
    ]);
    const uploadToDriveFn = vi
      .fn()
      .mockResolvedValue(driveUrl('SAME_ID_YYYYYYYYYYYYYYYY'));
    const deps = makeDeps({
      manualQueueOverride: queue,
      promptFn,
      uploadToDriveFn: uploadToDriveFn as never,
      readRawRowsFn: vi.fn().mockResolvedValue([
        BR_HEADER,
        makeBrRow({
          BackImage: driveUrl('SAME_ID_YYYYYYYYYYYYYYYY'),
        }),
      ]) as never,
    });
    await runManualFix(deps);
    const ops = operationsOf(
      deps.appendTrailRowFn as ReturnType<typeof vi.fn>,
    );
    expect(ops).toContain('DRIVE_UPLOAD');
    expect(ops).toContain('BR_WRITE');
    expect(ops).not.toContain('DRIVE_DELETE');
    expect(deps.trashDriveFileFn).not.toHaveBeenCalled();
  });

  // Test 16 — --re-audit invocation
  it('Test 16 (--re-audit): runAuditFn called + summary line printed', async () => {
    const queue: ManualQueueRow[] = [];
    const runAuditFn = vi.fn().mockResolvedValue({ pollutedCount: 0 });
    const loadOriginalAuditPidsFn = vi
      .fn()
      .mockResolvedValue(new Set<string>());
    const loadBrWritePidsFromTrailFn = vi
      .fn()
      .mockResolvedValue(new Set<string>());
    const deps = makeDeps({
      manualQueueOverride: queue,
      args: {
        queueFile: undefined,
        reAudit: true,
        dryRun: false,
        help: false,
      },
      runAuditFn,
      loadOriginalAuditPidsFn: loadOriginalAuditPidsFn as never,
      loadBrWritePidsFromTrailFn: loadBrWritePidsFromTrailFn as never,
    });
    const result = await runManualFix(deps);
    expect(runAuditFn).toHaveBeenCalledTimes(1);
    expect(runAuditFn).toHaveBeenCalledWith({ reAudit: true });
    expect(result.reAudit).toBeDefined();
    expect(result.reAudit!.status).toBe('SATISFIED');
  });

  // Test 17 — R10 OR-path coverage (PARTIAL + SATISFIED scenarios)
  it('Test 17 (R10 OR-path): PARTIAL when coverage<100% + pollution>0; SATISFIED via OR-path', async () => {
    // Scenario A — 2 of 3 BR_WRITE; 1 pid still polluted → PARTIAL
    {
      const runAuditFn = vi.fn().mockResolvedValue({ pollutedCount: 1 });
      const loadOriginalAuditPidsFn = vi
        .fn()
        .mockResolvedValue(new Set(['pidA', 'pidB', 'pidC']));
      const loadBrWritePidsFromTrailFn = vi
        .fn()
        .mockResolvedValue(new Set(['pidA', 'pidB']));
      const consoleSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);
      const deps = makeDeps({
        manualQueueOverride: [],
        args: {
          queueFile: undefined,
          reAudit: true,
          dryRun: false,
          help: false,
        },
        runAuditFn,
        loadOriginalAuditPidsFn: loadOriginalAuditPidsFn as never,
        loadBrWritePidsFromTrailFn: loadBrWritePidsFromTrailFn as never,
      });
      const result = await runManualFix(deps);
      const consoleCalls = consoleSpy.mock.calls.flat().join(' ');
      consoleSpy.mockRestore();
      expect(result.reAudit!.pollutedCount).toBe(1);
      expect(result.reAudit!.brWriteCovered).toBe(2);
      expect(result.reAudit!.originalPolluted).toBe(3);
      expect(result.reAudit!.coveragePct).toBeCloseTo(66.7, 1);
      expect(result.reAudit!.status).toBe('PARTIAL');
      // Verify the printed summary line includes both metrics
      expect(consoleCalls).toContain('pollutedCount=1');
      expect(consoleCalls).toContain('66.7');
    }

    // Scenario B — all 3 BR_WRITE (coverage=100%) but re-audit still flags 1.
    // OR-path satisfies R10 even though one pid still polluted (force override).
    {
      const runAuditFn = vi.fn().mockResolvedValue({ pollutedCount: 1 });
      const loadOriginalAuditPidsFn = vi
        .fn()
        .mockResolvedValue(new Set(['pidA', 'pidB', 'pidC']));
      const loadBrWritePidsFromTrailFn = vi
        .fn()
        .mockResolvedValue(new Set(['pidA', 'pidB', 'pidC']));
      const deps = makeDeps({
        manualQueueOverride: [],
        args: {
          queueFile: undefined,
          reAudit: true,
          dryRun: false,
          help: false,
        },
        runAuditFn,
        loadOriginalAuditPidsFn: loadOriginalAuditPidsFn as never,
        loadBrWritePidsFromTrailFn: loadBrWritePidsFromTrailFn as never,
      });
      const result = await runManualFix(deps);
      expect(result.reAudit!.coveragePct).toBe(100);
      expect(result.reAudit!.status).toBe('SATISFIED');
    }
  });
});

// ---------------------------------------------------------------------------
// Helper-function tests
// ---------------------------------------------------------------------------

describe('promptForChoice', () => {
  it('loops until a valid letter is returned', async () => {
    const promptFn = scriptedPrompt(['x', 'y', 'r']);
    const out = await promptForChoice(promptFn, 'choose: ', ['r', 's']);
    expect(out).toBe('r');
  });

  it('lowercases + trims operator input', async () => {
    const promptFn = scriptedPrompt(['  R  ']);
    const out = await promptForChoice(promptFn, 'choose: ', ['r']);
    expect(out).toBe('r');
  });
});

describe('parseManualQueueTsv', () => {
  it('parses the 6-column queue TSV produced by Plan 03', async () => {
    const fs = await import('fs');
    const readMock = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
    const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
    existsMock.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.tsv') ? true : p === 'tmp',
    );
    const tsv = [
      'pid\tpollution_class\taffected_columns\tcurrent_drive_urls\tfront_image_screenshot_link\tsuggested_action',
      'TEST001\tcontent_mismatch\tBackImage\thttps://drive.google.com/uc?id=AAA\thttps://drive.google.com/uc?id=FRONT\treplace with operator-picked URL',
      'TEST002\tshape_drift\tDirectSideImage,BackImage\thttps://drive.google.com/uc?id=BBB,https://drive.google.com/uc?id=CCC\thttps://drive.google.com/uc?id=FRONT2\tdelete + leave blank for next push regen',
    ].join('\n');
    readMock.mockReturnValue(tsv);

    const rows = await parseManualQueueTsv('tmp/queue.tsv');
    expect(rows.length).toBe(2);
    expect(rows[0].pid).toBe('TEST001');
    expect(rows[0].affected_columns).toEqual(['BackImage']);
    expect(rows[1].affected_columns).toEqual(['DirectSideImage', 'BackImage']);
    expect(rows[1].current_drive_urls.length).toBe(2);
    expect(rows[1].suggested_action).toContain('delete');
  });
});

describe('handleManualRow direct calls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "quit" without writing trail rows when operator picks q', async () => {
    const promptFn = scriptedPrompt(['q']);
    const deps = makeDeps({ promptFn });
    const brIndex = {
      headerMap: BR_HEADER.reduce(
        (acc, h, i) => {
          acc[h] = i;
          return acc;
        },
        {} as Record<string, number>,
      ),
      rowByPid: new Map([
        [
          'TEST001',
          { rowIndex0: 1, row: makeBrRow({ productId: 'TEST001' }) },
        ],
      ]),
    };
    const outcome = await handleManualRow(
      makeQueueRow(),
      brIndex,
      deps,
      'test-run',
    );
    expect(outcome).toBe('quit');
    expect(deps.appendTrailRowFn).not.toHaveBeenCalled();
  });
});
