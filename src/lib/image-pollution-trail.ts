/**
 * Phase 16: Image-pollution audit + fix trail TSV writer.
 *
 * Mirrors `src/lib/rejects-tsv.ts` (Phase 15's pattern) but parameterized for the
 * 9-column D-14 schema and the date-stamped trail filename. Intentionally a
 * SIBLING module — rejects-tsv is not imported here, per 16-RESEARCH.md line 295
 * (copying the pattern is cheaper than abstracting it).
 *
 * Schema (D-14): tab-separated, one row per operation
 *   timestamp_iso \t pid \t operation \t column_or_path \t old_value
 *   \t new_value \t tier \t run_id \t notes
 *
 * Sync `fs` is used to match the in-repo precedent (see `src/lib/rejects-tsv.ts`
 * and `scripts/audit-product-imagery.ts:30`). The function is declared `async`
 * for caller-side ergonomics (callers can `await` it).
 *
 * Durability (D-15): every successful write is followed by an explicit
 * `openSync` + `fsyncSync` + `closeSync` block so a crash loses at most one
 * in-flight op. The fsync invariant is the contract that lets `loadProcessedPids`
 * trust today's trail file on restart.
 *
 * Security (T-16-06): the `column_or_path`, `old_value`, `new_value`, and `notes`
 * fields can originate from operator or LLM input. All four are sanitized by
 * collapsing `[\t\n\r]+` runs to a single space before any tab-join. The
 * `operation` enum is bounded — no sanitization needed there. ASVS V5.
 *
 * Filesystem failures are non-fatal — the TSV is a durable record but a
 * disk-full or readonly-mount must not crash the audit/fix pipeline. Errors
 * are logged warn and swallowed.
 *
 * Concurrency (T-16-07 — accepted for now): the default fix loop is sequential
 * per-pid within tier (D-20), so `appendFileSync` is safe. If concurrent writers
 * are introduced (e.g., parallel Tier 1 supplier fetches), the call site MUST
 * wrap `appendTrailRow` in a process-local mutex (Promise chain) — this helper
 * does NOT serialize internally.
 */

import {
  existsSync,
  appendFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from 'fs';
import { logger } from './logger.js';

const TRAIL_HEADER =
  'timestamp_iso\tpid\toperation\tcolumn_or_path\told_value\tnew_value\ttier\trun_id\tnotes\n';

/** Date-stamped trail file under tmp/. New file per UTC day. */
function getTrailPath(): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `tmp/image-pollution-fix-trail-${d}.tsv`;
}

/**
 * The 9 operation kinds logged across audit (Pass 1/2/3) and fix (Tier 1/2/3).
 * Discriminated union — exhaustive at compile time.
 */
export type TrailOperation =
  | 'BR_WRITE'
  | 'DRIVE_UPLOAD'
  | 'DRIVE_DELETE'
  | 'SUPPLIER_FETCH'
  | 'AI_REGEN'
  | 'VERIFIER_PASS'
  | 'VERIFIER_FAIL'
  | 'MANUAL_SKIP'
  | 'MANUAL_ACCEPT';

/** One row of the image-pollution trail TSV. */
export interface TrailRow {
  /** ISO-8601 — caller passes `new Date().toISOString()`. */
  timestamp_iso: string;
  pid: string;
  operation: TrailOperation;
  /** e.g., 'FrontImage' for BR_WRITE, 'drive-fileId-abc' for DRIVE_DELETE. */
  column_or_path: string;
  old_value: string;
  new_value: string;
  /** 0 for audit-side events; 1/2/3 for fix-side events. */
  tier: 0 | 1 | 2 | 3;
  run_id: string;
  notes: string;
}

// Module-level memoization. Set on first `getOrCreateTrailRunId()` call and
// reused for every subsequent call in the same process. Renamed from rejects-
// tsv's `_runId` to `_trailRunId` so importing both modules in the same script
// (theoretically possible) won't collide.
let _trailRunId: string | null = null;

/**
 * Returns the run ID for the current process. Generated once on first call
 * (ISO-8601 timestamp), then memoized — every caller in the same process
 * receives the same string so all rows written by a single run share a run_id.
 */
export function getOrCreateTrailRunId(): string {
  if (_trailRunId === null) {
    _trailRunId = new Date().toISOString();
  }
  return _trailRunId;
}

/**
 * Sanitize an operator-or-LLM-controlled string before TSV join. Collapses any
 * run of tabs / newlines / carriage returns to a single space. Mitigates
 * T-16-06 (TSV injection via the four unsafe fields). ASVS V5.
 */
function sanitize(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ');
}

/**
 * Append one row to today's trail TSV. Writes the header on the first call
 * when the file does not yet exist; appends only the row line on subsequent
 * calls. Every successful write is followed by an explicit fsync so a crash
 * loses at most one in-flight op.
 *
 * Non-throwing: filesystem failures (disk full, readonly mount) are logged
 * warn and swallowed. The trail is durable record, not a hard requirement —
 * the audit/fix pipeline must not crash on a TSV write failure.
 *
 * Concurrency (T-16-07): this helper is NOT serialized internally. Callers
 * that may invoke it concurrently within a single process must wrap it in a
 * Promise-chain mutex. The default sequential-per-pid loop (D-20) makes this
 * a non-issue for Plan 01.
 *
 * @param row Row to append. The 4 unsafe fields are sanitized before join.
 */
export async function appendTrailRow(row: TrailRow): Promise<void> {
  const path = getTrailPath();
  const line =
    [
      row.timestamp_iso,
      row.pid,
      row.operation,
      sanitize(row.column_or_path),
      sanitize(row.old_value),
      sanitize(row.new_value),
      String(row.tier),
      row.run_id,
      sanitize(row.notes),
    ].join('\t') + '\n';

  try {
    if (!existsSync(path)) {
      writeFileSync(path, TRAIL_HEADER + line);
    } else {
      appendFileSync(path, line);
    }
    // D-15 fsync: durability gate so a crash loses at most one in-flight op.
    const fd = openSync(path, 'a');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    logger.warn(`[image-pollution-trail] Failed to write trail row: ${err}`);
    // Do NOT re-throw — trail is a side-channel.
  }
}

/**
 * Resume helper (D-15): read today's trail and return the set of pids whose
 * processing has reached a TERMINAL operation for the current run.
 *
 * Terminal operations (per RESEARCH Pitfall 8): `BR_WRITE`, `MANUAL_SKIP`,
 * `MANUAL_ACCEPT`. Pids appearing only with non-terminal ops (VERIFIER_PASS,
 * SUPPLIER_FETCH, DRIVE_UPLOAD without a follow-up BR_WRITE, etc.) are NOT
 * considered processed — they crashed mid-flight and must be retried.
 *
 * On a missing trail file, returns an empty Set.
 */
export async function loadProcessedPids(): Promise<Set<string>> {
  const path = getTrailPath();
  if (!existsSync(path)) return new Set<string>();

  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').slice(1); // drop header
  const processed = new Set<string>();
  const terminal = new Set<TrailOperation>(['BR_WRITE', 'MANUAL_SKIP', 'MANUAL_ACCEPT']);

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const pid = cols[1];
    const operation = cols[2] as TrailOperation;
    if (terminal.has(operation)) {
      processed.add(pid);
    }
  }

  return processed;
}
