/**
 * Splits tmp/color-mismatches.tsv into two buckets:
 *   - Group A "fake color variants": same FrontImage URL across multiple colors
 *     of the same pid (the supplier only has one product photo; BR's color
 *     variants don't have per-color imagery). Cannot rename — needs imagery.
 *   - Group B "true per-variant mismatch": each color has its own URL but the
 *     image content doesn't match the stated color name. Candidates for
 *     rename or regenerate.
 *
 * Writes:
 *   tmp/color-mismatches-groupA.tsv (fake variants — imagery missing)
 *   tmp/color-mismatches-groupB.tsv (true mismatches — actionable)
 */
import { readFileSync, writeFileSync } from 'fs';

const SRC = 'tmp/color-mismatches.tsv';
const A = 'tmp/color-mismatches-groupA.tsv';
const B = 'tmp/color-mismatches-groupB.tsv';

interface Row {
  pid: string; color: string; verdict: string; conf: string;
  detected: string; reasoning: string; url: string;
}

const lines = readFileSync(SRC, 'utf-8').trim().split('\n');
const header = lines[0];
const rows: Row[] = lines.slice(1).map(l => {
  const c = l.split('\t');
  return { pid: c[0], color: c[1], verdict: c[2], conf: c[3], detected: c[4], reasoning: c[5], url: c[6] };
});

// Count unique URLs per pid — across BOTH yes/no/maybe... but we only have
// mismatch rows here. To detect Group A we need to know if the same URL is
// shared across colors of the same pid.
const urlsByPid = new Map<string, Set<string>>();
const colorsByPidUrl = new Map<string, Set<string>>();
for (const r of rows) {
  if (!urlsByPid.has(r.pid)) urlsByPid.set(r.pid, new Set());
  urlsByPid.get(r.pid)!.add(r.url);
  const k = `${r.pid}|${r.url}`;
  if (!colorsByPidUrl.has(k)) colorsByPidUrl.set(k, new Set());
  colorsByPidUrl.get(k)!.add(r.color);
}

const groupA: Row[] = [];
const groupB: Row[] = [];
for (const r of rows) {
  const colorsForThisUrl = colorsByPidUrl.get(`${r.pid}|${r.url}`)!.size;
  if (colorsForThisUrl >= 2) groupA.push(r);
  else groupB.push(r);
}

writeFileSync(A, [header, ...groupA.map(r => [r.pid, r.color, r.verdict, r.conf, r.detected, r.reasoning, r.url].join('\t'))].join('\n') + '\n');
writeFileSync(B, [header, ...groupB.map(r => [r.pid, r.color, r.verdict, r.conf, r.detected, r.reasoning, r.url].join('\t'))].join('\n') + '\n');

const groupAPids = new Set(groupA.map(r => r.pid));
const groupBPids = new Set(groupB.map(r => r.pid));
const groupAByVerdict = { no: 0, maybe: 0 };
const groupBByVerdict = { no: 0, maybe: 0 };
for (const r of groupA) (groupAByVerdict as any)[r.verdict]++;
for (const r of groupB) (groupBByVerdict as any)[r.verdict]++;

console.log('=== Color mismatch breakdown ===');
console.log(`Total rows in source: ${rows.length}`);
console.log(`\nGroup A — fake color variants (same FrontImage across colors):`);
console.log(`  rows: ${groupA.length}  (no=${groupAByVerdict.no}, maybe=${groupAByVerdict.maybe})`);
console.log(`  affected pids: ${groupAPids.size}`);
console.log(`  → ${A}`);
console.log(`\nGroup B — true per-variant mismatch (unique URL, wrong color):`);
console.log(`  rows: ${groupB.length}  (no=${groupBByVerdict.no}, maybe=${groupBByVerdict.maybe})`);
console.log(`  affected pids: ${groupBPids.size}`);
console.log(`  → ${B}`);

// Top offenders
console.log(`\nTop 10 Group A pids:`);
const aCounts = new Map<string, number>();
for (const r of groupA) aCounts.set(r.pid, (aCounts.get(r.pid) ?? 0) + 1);
[...aCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([pid, n]) => console.log(`  ${pid}: ${n} variants`));

console.log(`\nTop 10 Group B pids:`);
const bCounts = new Map<string, number>();
for (const r of groupB) bCounts.set(r.pid, (bCounts.get(r.pid) ?? 0) + 1);
[...bCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([pid, n]) => console.log(`  ${pid}: ${n} variants`));
