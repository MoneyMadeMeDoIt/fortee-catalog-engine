/**
 * Tests for src/lib/rejects-tsv.ts — Phase 15 R4/R6 shared TSV writer.
 *
 * All filesystem calls are mocked via `vi.mock('fs')`. No real disk writes occur.
 * Covers D-06/D-07 row format, T-15-02 sanitization, run_id memoization,
 * and the non-throwing-on-fs-fault contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: fs (only the three functions rejects-tsv uses)
// ---------------------------------------------------------------------------

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
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
// Helper: build a baseline RejectRow
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<import('../../src/lib/rejects-tsv.js').RejectRow> = {}) {
  return {
    pid: 'A343',
    view: 'back' as const,
    reason: 'front is crewneck, candidate is hoodie',
    timestamp: '2026-05-11T00:00:00.000Z',
    run_id: '2026-05-11T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup: clear mocks AND reset modules so each test gets a fresh _runId memo
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Behavior 1: First write (file absent) writes HEADER + line via writeFileSync
// ---------------------------------------------------------------------------

describe('appendRejectRow — first write', () => {
  it('calls writeFileSync with HEADER + line when file does not exist', async () => {
    const { existsSync, writeFileSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');
    await appendRejectRow(makeRow());

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();

    const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe('tmp/garment-type-rejects.tsv');
    expect(content).toBe(
      'pid\tview\treason\ttimestamp\trun_id\n' +
        'A343\tback\tfront is crewneck, candidate is hoodie\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\n',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavior 2: Subsequent write (file exists) appends only the line
// ---------------------------------------------------------------------------

describe('appendRejectRow — subsequent write', () => {
  it('calls appendFileSync with only the line when file already exists', async () => {
    const { existsSync, writeFileSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');
    await appendRejectRow(makeRow());

    expect(vi.mocked(appendFileSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

    const [path, content] = vi.mocked(appendFileSync).mock.calls[0];
    expect(path).toBe('tmp/garment-type-rejects.tsv');
    expect(content).toBe(
      'A343\tback\tfront is crewneck, candidate is hoodie\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\n',
    );
    // Must NOT contain header
    expect(content as string).not.toContain('pid\tview\treason');
  });
});

// ---------------------------------------------------------------------------
// Behavior 3: Sanitization — tab in reason becomes a single space (T-15-02)
// ---------------------------------------------------------------------------

describe('appendRejectRow — T-15-02 sanitization (tabs)', () => {
  it('replaces literal tab in reason with a single space', async () => {
    const { existsSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');
    await appendRejectRow(makeRow({ reason: 'front is crewneck\tcandidate is hoodie' }));

    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    expect(content).toBe(
      'A343\tback\tfront is crewneck candidate is hoodie\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\n',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavior 4: Sanitization — newlines/CR collapse to single space
// ---------------------------------------------------------------------------

describe('appendRejectRow — T-15-02 sanitization (newlines + CR)', () => {
  it('collapses any run of \\t/\\n/\\r in reason to a single space', async () => {
    const { existsSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');
    await appendRejectRow(makeRow({ reason: 'a\n\nb\rc' }));

    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    expect(content).toBe(
      'A343\tback\ta b c\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\n',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavior 5: getOrCreateRunId memoizes within a process
// ---------------------------------------------------------------------------

describe('getOrCreateRunId — memoization', () => {
  it('returns the same string across multiple calls within one process', async () => {
    const { getOrCreateRunId } = await import('../../src/lib/rejects-tsv.js');

    const a = getOrCreateRunId();
    const b = getOrCreateRunId();
    const c = getOrCreateRunId();

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Behavior 6: getOrCreateRunId returns ISO-8601-shaped string
// ---------------------------------------------------------------------------

describe('getOrCreateRunId — ISO-8601 format', () => {
  it('returns a string matching the ISO-8601 date-time prefix /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/', async () => {
    const { getOrCreateRunId } = await import('../../src/lib/rejects-tsv.js');

    const runId = getOrCreateRunId();
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Behavior 7: Row order — exactly 5 tab-separated fields ending with \n
// ---------------------------------------------------------------------------

describe('appendRejectRow — row format', () => {
  it('writes pid\\tview\\tsanitized_reason\\ttimestamp\\trun_id\\n in that order', async () => {
    const { existsSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');
    await appendRejectRow({
      pid: 'PID42',
      view: 'side',
      reason: 'mismatch',
      timestamp: '2026-05-11T12:34:56.789Z',
      run_id: '2026-05-11T00:00:00.000Z',
    });

    const [, content] = vi.mocked(appendFileSync).mock.calls[0];
    const text = content as string;
    expect(text.endsWith('\n')).toBe(true);
    const fields = text.replace(/\n$/, '').split('\t');
    expect(fields).toEqual([
      'PID42',
      'side',
      'mismatch',
      '2026-05-11T12:34:56.789Z',
      '2026-05-11T00:00:00.000Z',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Behavior 8: Non-throwing on fs failure — caller sees no exception, logger warns
// ---------------------------------------------------------------------------

describe('appendRejectRow — non-throwing on fs failure', () => {
  it('swallows appendFileSync errors, logs warn, and does not re-throw', async () => {
    const { existsSync, appendFileSync } = await import('fs');
    (vi.mocked(existsSync) as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (vi.mocked(appendFileSync) as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOSPC: disk full');
    });

    const { appendRejectRow } = await import('../../src/lib/rejects-tsv.js');

    // Must not throw
    await expect(appendRejectRow(makeRow())).resolves.toBeUndefined();

    // Must have logged a warning prefixed with the module tag
    const { logger } = await import('../../src/lib/logger.js');
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(warnCalls[0][0])).toContain('[rejects-tsv]');
    expect(String(warnCalls[0][0])).toContain('ENOSPC: disk full');
  });
});
