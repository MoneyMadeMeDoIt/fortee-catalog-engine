/**
 * Phase 15: Garment-type rejects TSV writer.
 *
 * Both R4 (in-pipeline skip+log) and R6 (retro audit script) write to the same
 * `tmp/garment-type-rejects.tsv` (D-06, D-07). Extracted to its own module so
 * the two callers cannot drift apart.
 *
 * Format (per D-07): tab-separated columns
 *   pid \t view \t reason \t timestamp \t run_id
 * Header on the first write per run; append across runs.
 *
 * Sync `fs` is used to match the in-repo precedent — see
 * `scripts/audit-product-imagery.ts:30` and
 * `scripts/fix-all-store-side-pairs.ts:31`. The function is declared `async`
 * purely for caller-side ergonomics (callers can `await` it).
 *
 * Security: `reason` originates from an LLM response (T-15-02). It is sanitized
 * by collapsing `[\t\n\r]+` runs to a single space before any tab-join. ASVS V5.
 *
 * Filesystem failures are non-fatal — the TSV is a side-channel for human
 * review. A disk-full or readonly-mount must not crash the AI generation
 * pipeline. Errors are logged warn and swallowed.
 */

import { existsSync, appendFileSync, writeFileSync } from 'fs';
import { logger } from './logger.js';

const TSV_PATH = 'tmp/garment-type-rejects.tsv';
const HEADER = 'pid\tview\treason\ttimestamp\trun_id\n';

/** One row of the rejects TSV. */
export interface RejectRow {
  pid: string;
  view: 'back' | 'side';
  reason: string;
  /** ISO-8601 — caller passes `new Date().toISOString()`. */
  timestamp: string;
  run_id: string;
}

// Module-level memoization. Set on first `getOrCreateRunId()` call and reused
// for every subsequent call in the same process. ISO-8601 per D-07 + Discretion
// (no UUID dependency required).
let _runId: string | null = null;

/**
 * Returns the run ID for the current process. Generated once on first call
 * (ISO-8601 timestamp), then memoized — every caller in the same process
 * receives the same string so all rows written by a single run share a run_id.
 */
export function getOrCreateRunId(): string {
  if (_runId === null) {
    _runId = new Date().toISOString();
  }
  return _runId;
}

/**
 * Sanitize an LLM-controlled string before TSV join. Collapses any run of
 * tabs / newlines / carriage returns to a single space. Mitigates T-15-02
 * (TSV injection via the `reason` field). ASVS V5.
 */
function sanitize(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ');
}

/**
 * Append one row to `tmp/garment-type-rejects.tsv`. Writes the header on the
 * first call when the file does not yet exist; appends only the row line on
 * subsequent calls.
 *
 * Non-throwing: filesystem failures (disk full, readonly mount) are logged
 * warn and swallowed so the AI generation pipeline cannot crash on a TSV
 * write — the TSV is a side-channel for operator review, not a hard
 * requirement.
 *
 * @param row Row to append. `reason` is sanitized for tab/newline before join.
 */
export async function appendRejectRow(row: RejectRow): Promise<void> {
  const line =
    [row.pid, row.view, sanitize(row.reason), row.timestamp, row.run_id].join('\t') + '\n';

  try {
    if (!existsSync(TSV_PATH)) {
      writeFileSync(TSV_PATH, HEADER + line);
    } else {
      appendFileSync(TSV_PATH, line);
    }
  } catch (err) {
    logger.warn(`[rejects-tsv] Failed to write reject row: ${err}`);
    // Do NOT re-throw — TSV is a side-channel.
  }
}
