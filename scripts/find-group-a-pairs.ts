/**
 * For each Group A pid (single-image-many-colors), look for plausible adult
 * counterparts in BR. Patterns tried:
 *   YOUTH "L0550Y"  → ADULT "L00550" (insert "0" after first letter)
 *   YOUTH "L0980Y"  → ADULT "L00980"
 *   YOUTH "S5610Y"  → ADULT "S05610"
 *   YOUTH "18500B"  → ADULT "18500"  (drop "B")
 *   YOUTH "<pid>Y"  → ADULT "<pid>"
 * Reports candidates that exist AND have verified-correct color verification
 * (yes verdicts) on most variants.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';

const cacheRaw = readFileSync('tmp/color-verify-cache.json', 'utf-8');
const cache: Record<string, { detected: string; verdict: string; confidence: number }> = JSON.parse(cacheRaw);

const groupAPids = [...new Set(
  readFileSync('tmp/color-mismatches-groupA.tsv', 'utf-8')
    .trim().split('\n').slice(1).map(l => l.split('\t')[0])
)];

const sheets = createSheetsClient();
const r = await sheets.spreadsheets.values.get({ spreadsheetId: '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs', range: `'Bestsellers-Ready'` });
const rows = (r.data.values ?? []) as string[][];
const h: Record<string, number> = {};
rows[0].forEach((x, i) => { h[x] = i; });

const allPids = new Set<string>();
for (let i = 1; i < rows.length; i++) {
  const p = String(rows[i][h['productId']] ?? '').trim();
  if (p) allPids.add(p);
}

function candidates(pid: string): string[] {
  const out: string[] = [];
  if (pid.endsWith('Y')) {
    const base = pid.slice(0, -1);
    out.push(base);
    // Insert 0 after first letter: L0550 → L00550, S5610 → S05610
    if (/^[A-Z]\d/.test(base)) out.push(base[0] + '0' + base.slice(1));
  }
  if (pid.endsWith('B')) out.push(pid.slice(0, -1));
  return out;
}

interface Stats { yes: number; no: number; maybe: number; unknown: number; total: number }
function statsFor(pid: string): Stats {
  const s: Stats = { yes: 0, no: 0, maybe: 0, unknown: 0, total: 0 };
  // Get colors of this pid
  const colors = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][h['productId']] ?? '').trim() !== pid) continue;
    const c = String(rows[i][h['colorName']] ?? '').trim();
    if (c) colors.add(c);
  }
  for (const c of colors) {
    s.total++;
    const m = Object.entries(cache).filter(([k]) => k.startsWith(`${pid}::${c.toLowerCase()}::`));
    const v = m[0]?.[1];
    if (!v) s.unknown++;
    else if (v.verdict === 'yes') s.yes++;
    else if (v.verdict === 'no') s.no++;
    else s.maybe++;
  }
  return s;
}

console.log(`Group A pids: ${groupAPids.length}`);
console.log(`\nLooking for adult counterparts...`);
const matches: { youth: string; adult: string; youthStats: Stats; adultStats: Stats }[] = [];
const noMatch: string[] = [];
for (const youth of groupAPids) {
  const cands = candidates(youth);
  let bestAdult: string | null = null;
  for (const c of cands) if (allPids.has(c)) { bestAdult = c; break; }
  if (!bestAdult) { noMatch.push(youth); continue; }
  matches.push({ youth, adult: bestAdult, youthStats: statsFor(youth), adultStats: statsFor(bestAdult) });
}

console.log(`Found candidates: ${matches.length}, no candidate: ${noMatch.length}\n`);
console.log(`${'youth'.padEnd(10)} | ${'adult'.padEnd(10)} | youth (yes/no/maybe/total) | adult (yes/no/maybe/total) | actionable?`);
console.log('-'.repeat(110));
for (const m of matches.sort((a,b) => b.adultStats.yes - a.adultStats.yes)) {
  const yt = m.youthStats, ad = m.adultStats;
  const youthBad = yt.no + yt.maybe;
  const adultClean = ad.yes >= ad.total * 0.8;
  const actionable = adultClean && youthBad > 0;
  const tag = actionable ? '✓ FIX-CANDIDATE' : (adultClean ? 'youth-already-clean' : 'adult-also-bad');
  console.log(`${m.youth.padEnd(10)} | ${m.adult.padEnd(10)} | ${`${yt.yes}/${yt.no}/${yt.maybe}/${yt.total}`.padEnd(28)} | ${`${ad.yes}/${ad.no}/${ad.maybe}/${ad.total}`.padEnd(27)} | ${tag}`);
}

if (noMatch.length > 0) {
  console.log(`\nNo adult candidate (need other fix path): ${noMatch.join(', ')}`);
}
