/**
 * Tests for src/lib/image-pollution-trail.ts — Phase 16 Plan 01 Task 1.
 *
 * All filesystem calls are mocked via `vi.mock('fs')`. No real disk writes occur.
 * Covers D-14 row format (9 columns), T-16-06 sanitization (4 fields), D-15
 * fsync-on-write durability, run_id memoization, and the non-throwing-on-fs-fault
 * contract. Includes the new loadProcessedPids resume helper per D-15.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: fs — only the functions image-pollution-trail uses
// ---------------------------------------------------------------------------

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    openSync: vi.fn(),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

const mockLoggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helper: build a baseline TrailRow
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<import('../../src/lib/image-pollution-trail.js').TrailRow> = {},
) {
  return {
    timestamp_iso: '2026-05-12T10:00:00.000Z',
    pid: '6110',
    operation: 'BR_WRITE' as const,
    column_or_path: 'FrontImage',
    old_value: 'https://drive.google.com/uc?id=OLD123abcdef0123456789ab',
    new_value: 'https://drive.google.com/uc?id=NEW456abcdef0123456789ab',
    tier: 1 as const,
    run_id: '2026-05-12T10:00:00.000Z',
    notes: 'replaced via supplier canonical',
    ...overrides,
  };
}

// Today's expected trail path (built from the same logic as the lib).
function todayPath(): string {
  const d = new Date().toISOString().slice(0, 10);
  return `tmp/image-pollution-fix-trail-${d}.tsv`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Behavior A: First write — HEADER + line via writeFileSync
// ---------------------------------------------------------------------------

describe('appendTrailRow — first write', () => {
  it('writes HEADER + line via writeFileSync when file does not exist', async () => {
    const { existsSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } =
      await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(42);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(makeRow());

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();

    const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe(todayPath());
    expect(content).toBe(
      'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\trun_id\tnotes\n' +
        '2026-05-12T10:00:00.000Z\t6110\tBR_WRITE\tFrontImage\thttps://drive.google.com/uc?id=OLD123abcdef0123456789ab\thttps://drive.google.com/uc?id=NEW456abcdef0123456789ab\t1\t2026-05-12T10:00:00.000Z\treplaced via supplier canonical\n',
    );

    // fsync block still runs even on first write
    expect(vi.mocked(openSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior B: Subsequent write — only the line, no second header
// ---------------------------------------------------------------------------

describe('appendTrailRow — subsequent write', () => {
  it('appends only the row line when file already exists (no second header)', async () => {
    const { existsSync, writeFileSync, appendFileSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(43);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(makeRow());

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

    const [path, content] = vi.mocked(appendFileSync).mock.calls[0];
    expect(path).toBe(todayPath());
    const text = content as string;
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('timestamp_iso\tpid\toperation'); // no header
  });
});

// ---------------------------------------------------------------------------
// Behavior C: Sanitization — tabs / newlines / CR in the 4 unsafe fields
// ---------------------------------------------------------------------------

describe('appendTrailRow — T-16-06 sanitization', () => {
  it('collapses [\\t\\n\\r]+ in column_or_path, old_value, new_value, notes to single spaces', async () => {
    const { existsSync, appendFileSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(44);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(
      makeRow({
        column_or_path: 'col\twith\ttabs',
        old_value: 'old\nwith\rnewlines',
        new_value: 'new\r\n\twith\nall',
        notes: 'multi\n\nspace\rissue',
      }),
    );

    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    const text = content as string;
    // Drop trailing newline, split on tabs — exactly 9 fields.
    const fields = text.replace(/\n$/, '').split('\t');
    expect(fields).toHaveLength(9);
    // Position 3 (column_or_path): tabs collapsed to single spaces
    expect(fields[3]).toBe('col with tabs');
    // Position 4 (old_value): \n\r collapsed to single space
    expect(fields[4]).toBe('old with newlines');
    // Position 5 (new_value): \r\n\t and \n collapsed to single spaces
    expect(fields[5]).toBe('new with all');
    // Position 8 (notes): \n\n and \r collapsed to single spaces
    expect(fields[8]).toBe('multi space issue');
  });
});

// ---------------------------------------------------------------------------
// Behavior D: tier=0 writes the literal "0", not "Tier 0"
// ---------------------------------------------------------------------------

describe('appendTrailRow — tier=0 (audit-side event)', () => {
  it('writes "0" as the tier field, not "Tier 0"', async () => {
    const { existsSync, appendFileSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(45);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(makeRow({ tier: 0, operation: 'VERIFIER_FAIL' }));

    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    const fields = (content as string).replace(/\n$/, '').split('\t');
    expect(fields[6]).toBe('0');
    expect(fields[6]).not.toContain('Tier');
  });
});

// ---------------------------------------------------------------------------
// Behavior E: Non-throwing on fs failure
// ---------------------------------------------------------------------------

describe('appendTrailRow — non-throwing on fs failure', () => {
  it('swallows write errors, logs warn, and does not re-throw', async () => {
    const { existsSync, writeFileSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (vi.mocked(writeFileSync) as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOSPC: disk full');
    });
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(46);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');

    await expect(appendTrailRow(makeRow())).resolves.toBeUndefined();

    const { logger } = await import('../../src/lib/logger.js');
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0][0])).toContain('[image-pollution-trail]');
    expect(String(warnCalls[0][0])).toContain('ENOSPC: disk full');
  });
});

// ---------------------------------------------------------------------------
// Behavior F: fsync block — openSync + fsyncSync + closeSync each fire once
// ---------------------------------------------------------------------------

describe('appendTrailRow — D-15 fsync durability', () => {
  it('invokes openSync, fsyncSync, and closeSync exactly once per call', async () => {
    const { existsSync, appendFileSync, openSync, fsyncSync, closeSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(99);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(makeRow());

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(1);

    // closeSync must run even if fsync throws — verify the fd argument matches
    // the openSync return value.
    expect(vi.mocked(fsyncSync).mock.calls[0][0]).toBe(99);
    expect(vi.mocked(closeSync).mock.calls[0][0]).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Behavior G: getOrCreateTrailRunId — memoization
// ---------------------------------------------------------------------------

describe('getOrCreateTrailRunId — memoization', () => {
  it('returns the same ISO-8601 string across multiple calls within one process', async () => {
    const { getOrCreateTrailRunId } = await import('../../src/lib/image-pollution-trail.js');

    const a = getOrCreateTrailRunId();
    const b = getOrCreateTrailRunId();
    const c = getOrCreateTrailRunId();

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(typeof a).toBe('string');
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Behavior H: loadProcessedPids on missing trail → empty Set
// ---------------------------------------------------------------------------

describe('loadProcessedPids — no trail file', () => {
  it('returns an empty Set when the trail file does not exist', async () => {
    const { existsSync, readFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { loadProcessedPids } = await import('../../src/lib/image-pollution-trail.js');
    const result = await loadProcessedPids();

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Behavior I: loadProcessedPids honors only terminal operations
// ---------------------------------------------------------------------------

describe('loadProcessedPids — only terminal operations count', () => {
  it('includes BR_WRITE / MANUAL_SKIP / MANUAL_ACCEPT pids and excludes VERIFIER_PASS / SUPPLIER_FETCH', async () => {
    const { existsSync, readFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const header =
      'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\trun_id\tnotes';
    const body = [
      'T1\tA\tBR_WRITE\tFrontImage\told\tnew\t1\tR\tnote',
      'T2\tB\tVERIFIER_PASS\tFrontImage\told\tnew\t1\tR\tnote',
      'T3\tC\tMANUAL_SKIP\tFrontImage\told\tnew\t3\tR\tnote',
      'T4\tD\tMANUAL_ACCEPT\tFrontImage\told\tnew\t3\tR\tnote',
      'T5\tE\tSUPPLIER_FETCH\tFrontImage\told\tnew\t1\tR\tnote',
    ].join('\n');
    (vi.mocked(readFileSync) as ReturnType<typeof vi.fn>).mockReturnValue(
      header + '\n' + body + '\n',
    );

    const { loadProcessedPids } = await import('../../src/lib/image-pollution-trail.js');
    const result = await loadProcessedPids();

    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(false);
    expect(result.has('C')).toBe(true);
    expect(result.has('D')).toBe(true);
    expect(result.has('E')).toBe(false);
    expect(result.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Behavior J: TrailOperation discriminated union — all 9 operations accepted
// ---------------------------------------------------------------------------

describe('TrailOperation — discriminated union coverage', () => {
  it('accepts all 9 known operations at compile time (smoke test)', async () => {
    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    type Op = import('../../src/lib/image-pollution-trail.js').TrailOperation;

    const ops: Op[] = [
      'BR_WRITE',
      'DRIVE_UPLOAD',
      'DRIVE_DELETE',
      'SUPPLIER_FETCH',
      'AI_REGEN',
      'VERIFIER_PASS',
      'VERIFIER_FAIL',
      'MANUAL_SKIP',
      'MANUAL_ACCEPT',
    ];
    expect(ops).toHaveLength(9);

    const { existsSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(50);

    // Smoke-call once per op to ensure the function accepts each variant.
    for (const op of ops) {
      await expect(appendTrailRow(makeRow({ operation: op }))).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 17-08 (B-4): TIER2_BUDGET_EXHAUSTED — OpenAI billing hard-limit sentinel
//
// New TrailOperation variant emitted by scripts/fix-image-pollution.ts Tier 2
// when the OpenAI billing hard limit is hit. NOT a terminal op — the pid must
// stay retry-eligible on the next run after the operator tops up billing.
// See RESEARCH Open Question 6.
// ---------------------------------------------------------------------------

describe('17-08 TIER2_BUDGET_EXHAUSTED', () => {
  it('accepts TIER2_BUDGET_EXHAUSTED as a TrailOperation (compile-time)', async () => {
    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    type Op = import('../../src/lib/image-pollution-trail.js').TrailOperation;
    const op: Op = 'TIER2_BUDGET_EXHAUSTED';
    expect(op).toBe('TIER2_BUDGET_EXHAUSTED');

    const { existsSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(60);

    await expect(
      appendTrailRow(makeRow({ operation: 'TIER2_BUDGET_EXHAUSTED' })),
    ).resolves.toBeUndefined();
  });

  it('loadProcessedPids does NOT treat TIER2_BUDGET_EXHAUSTED as terminal', async () => {
    const { existsSync, readFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const header =
      'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\trun_id\tnotes';
    const body = [
      'T1\tpidA\tBR_WRITE\tFrontImage\told\tnew\t1\tR\tnote',
      'T2\tpidB\tTIER2_BUDGET_EXHAUSTED\t\t\t\t2\tR\tbilling hit',
    ].join('\n');
    (vi.mocked(readFileSync) as ReturnType<typeof vi.fn>).mockReturnValue(
      header + '\n' + body + '\n',
    );

    const { loadProcessedPids } = await import('../../src/lib/image-pollution-trail.js');
    const result = await loadProcessedPids();

    expect(result.has('pidA')).toBe(true);
    expect(result.has('pidB')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('appendTrailRow writes TIER2_BUDGET_EXHAUSTED row in 9-column TSV format', async () => {
    const { existsSync, appendFileSync, openSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(openSync) as ReturnType<typeof vi.fn>).mockReturnValue(61);

    const { appendTrailRow } = await import('../../src/lib/image-pollution-trail.js');
    await appendTrailRow(
      makeRow({
        operation: 'TIER2_BUDGET_EXHAUSTED',
        column_or_path: '',
        old_value: '',
        new_value: '',
        tier: 2,
        notes: 'OpenAI billing hard limit reached — Tier 2 aborted',
      }),
    );

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    const text = content as string;
    const fields = text.replace(/\n$/, '').split('\t');
    expect(fields).toHaveLength(9);
    expect(fields[2]).toBe('TIER2_BUDGET_EXHAUSTED');
    expect(fields[6]).toBe('2');
    expect(fields[8]).toBe('OpenAI billing hard limit reached — Tier 2 aborted');
  });
});
