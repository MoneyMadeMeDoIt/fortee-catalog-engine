/**
 * Post-mortem analyzer for an unfinished audit run.
 *
 * The full audit script writes its summary TSV atomically at the end, so if
 * the run hangs we lose the aggregated view. The trail TSV, however, is
 * fsynced per row — so we can reconstruct Pass 2 / Pass 3 findings from it.
 *
 * NOTE: Pass 1 findings (shared_url, invalid_image_format) are NOT in the
 * trail — they live only in the (missing) summary TSV. Pass 1 must be re-run
 * separately (cheap — no AI calls).
 *
 * Run: npx tsx scripts/post-mortem-audit-trail.ts [--trail tmp/image-pollution-fix-trail-YYYY-MM-DD.tsv]
 */

import { readFileSync, existsSync } from 'fs';

const DEFAULT_TRAIL = `tmp/image-pollution-fix-trail-${new Date().toISOString().slice(0, 10)}.tsv`;

interface TrailRow {
  ts: string;
  pid: string;
  op: string;
  column: string;
  oldVal: string;
  newVal: string;
  tier: string;
  runId: string;
  notes: string;
}

function parseTrail(path: string): TrailRow[] {
  if (!existsSync(path)) {
    console.error(`Trail not found: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const rows: TrailRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split('\t');
    rows.push({
      ts: c[0] ?? '',
      pid: c[1] ?? '',
      op: c[2] ?? '',
      column: c[3] ?? '',
      oldVal: c[4] ?? '',
      newVal: c[5] ?? '',
      tier: c[6] ?? '',
      runId: c[7] ?? '',
      notes: c[8] ?? '',
    });
  }
  return rows;
}

function main(): void {
  const argTrail = process.argv.find((a) => a.startsWith('--trail='));
  const trailPath = argTrail ? argTrail.slice('--trail='.length) : DEFAULT_TRAIL;
  console.log(`Reading trail: ${trailPath}\n`);

  const rows = parseTrail(trailPath);
  const pids = new Set<string>();
  for (const r of rows) pids.add(r.pid);

  const auditRows = rows.filter((r) => r.op === 'VERIFIER_PASS' || r.op === 'VERIFIER_FAIL');
  const fixRows = rows.filter((r) => r.op !== 'VERIFIER_PASS' && r.op !== 'VERIFIER_FAIL');

  // ---- Aggregate failures by pid ----
  type PidFailure = { col: string; reason: string }[];
  const failsByPid = new Map<string, PidFailure>();
  for (const r of auditRows) {
    if (r.op !== 'VERIFIER_FAIL') continue;
    if (!failsByPid.has(r.pid)) failsByPid.set(r.pid, []);
    failsByPid.get(r.pid)!.push({ col: r.column, reason: r.notes });
  }

  // ---- Pids with at least one VERIFIER_PASS but no FAIL = clean for Pass 2/3 ----
  const pidsWithVerifierActivity = new Set<string>();
  for (const r of auditRows) pidsWithVerifierActivity.add(r.pid);
  const cleanPids = [...pidsWithVerifierActivity].filter((p) => !failsByPid.has(p));

  // ---- Fail counts by column ----
  const failsByColumn = new Map<string, number>();
  for (const fails of failsByPid.values()) {
    for (const f of fails) {
      failsByColumn.set(f.col, (failsByColumn.get(f.col) ?? 0) + 1);
    }
  }

  // ---- Top reason buckets (rough — verifier reasons are free text) ----
  const reasonCounts = new Map<string, number>();
  for (const fails of failsByPid.values()) {
    for (const f of fails) {
      const key = f.reason.length > 80 ? f.reason.slice(0, 80) + '...' : f.reason;
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  // ---- Output ----
  console.log('===== AUDIT TRAIL POST-MORTEM =====\n');
  console.log(`Total trail rows:           ${rows.length}`);
  console.log(`Unique pids in trail:       ${pids.size}`);
  console.log(`Audit-side rows:            ${auditRows.length} (VERIFIER_PASS + VERIFIER_FAIL)`);
  console.log(`Fix-side rows:              ${fixRows.length} (BR_WRITE/DRIVE_*/MANUAL_*)`);
  console.log('');
  console.log(`Pids with verifier checks:  ${pidsWithVerifierActivity.size}`);
  console.log(`  Clean (no fails):         ${cleanPids.length}`);
  console.log(`  Polluted (>=1 fail):      ${failsByPid.size}`);
  console.log('');
  console.log(`Pass ratio:                 ${auditRows.filter((r) => r.op === 'VERIFIER_PASS').length} pass / ${auditRows.filter((r) => r.op === 'VERIFIER_FAIL').length} fail`);
  console.log('');

  console.log('--- Fails by column ---');
  const colsSorted = [...failsByColumn.entries()].sort((a, b) => b[1] - a[1]);
  for (const [col, n] of colsSorted) {
    console.log(`  ${col.padEnd(20)} ${n}`);
  }
  console.log('');

  console.log('--- Top 12 verifier reasons ---');
  for (const [reason, n] of topReasons) {
    console.log(`  [${String(n).padStart(3)}] ${reason}`);
  }
  console.log('');

  // ---- Top polluted pids (most fails) ----
  const pidsByFailCount = [...failsByPid.entries()]
    .map(([pid, fails]) => ({ pid, count: fails.length, columns: fails.map((f) => f.col) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  console.log('--- Top 20 most-polluted pids ---');
  for (const p of pidsByFailCount) {
    const cols = [...new Set(p.columns)].join(',');
    console.log(`  ${p.pid.padEnd(12)} fails=${p.count}  cols=${cols}`);
  }
  console.log('');

  console.log('--- Polluted pids (all, alphabetical) ---');
  const allPolluted = [...failsByPid.keys()].sort();
  console.log(`  ${allPolluted.length} pids: ${allPolluted.slice(0, 30).join(', ')}${allPolluted.length > 30 ? ', …' : ''}`);
  console.log('');

  console.log('Note: Pass 1 findings (shared_url, invalid_image_format) are NOT');
  console.log('represented in the trail. Re-run audit Pass 1 separately to recover');
  console.log('those — Pass 1 is structural, no AI calls, fast.');
}

main();
