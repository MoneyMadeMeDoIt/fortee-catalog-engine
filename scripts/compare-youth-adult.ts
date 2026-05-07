/**
 * For a given youth pid (e.g., S5610Y), find the corresponding adult pid (e.g.,
 * S5610) and compare color overlap + adult-side image correctness.
 *
 * Used to plan fixing wrong-color youth images by sourcing from the adult version.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';

const youthPid = process.argv[2];
const adultPidArg = process.argv[3];
if (!youthPid) { console.error('Usage: <youth-pid> [<adult-pid>]  e.g. S5610Y S05610'); process.exit(1); }
const adultPid = adultPidArg ?? youthPid.replace(/Y$/, '');
console.log(`Youth: ${youthPid}    Adult: ${adultPid}`);

const cacheRaw = readFileSync('tmp/color-verify-cache.json', 'utf-8');
const cache: Record<string, { detected: string; verdict: string; confidence: number }> = JSON.parse(cacheRaw);

const sheets = createSheetsClient();
const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'Bestsellers-Ready'` });
const rows = (r.data.values ?? []) as string[][];
const h: Record<string, number> = {};
rows[0].forEach((x, i) => { h[x] = i; });

interface Variant { color: string; front: string; back: string; side: string; model: string }
const youthV = new Map<string, Variant>();
const adultV = new Map<string, Variant>();
function rowVar(row: string[]): Variant {
  return {
    color: String(row[h['colorName']] ?? '').trim(),
    front: String(row[h['FrontImage']] ?? '').trim(),
    back: String(row[h['BackImage']] ?? '').trim(),
    side: String(row[h['DirectSideImage']] ?? '').trim(),
    model: String(row[h['ModelFrontImage']] ?? '').trim(),
  };
}
for (let i = 1; i < rows.length; i++) {
  const pid = String(rows[i][h['productId']] ?? '').trim();
  if (pid === youthPid) {
    const v = rowVar(rows[i]);
    if (v.color && v.front && !youthV.has(v.color)) youthV.set(v.color, v);
  } else if (pid === adultPid) {
    const v = rowVar(rows[i]);
    if (v.color && v.front && !adultV.has(v.color)) adultV.set(v.color, v);
  }
}

console.log(`Youth ${youthPid}: ${youthV.size} unique (color, FrontImage) pairs`);
console.log(`Adult ${adultPid}: ${adultV.size} unique (color, FrontImage) pairs`);

const both: string[] = [];
const youthOnly: string[] = [];
const adultOnly: string[] = [];
for (const c of youthV.keys()) (adultV.has(c) ? both : youthOnly).push(c);
for (const c of adultV.keys()) if (!youthV.has(c)) adultOnly.push(c);

console.log(`Color overlap (exact match):`);
console.log(`  in both: ${both.length} — ${both.join(', ')}`);
if (youthOnly.length) console.log(`  youth-only: ${youthOnly.length} — ${youthOnly.join(', ')}`);
if (adultOnly.length) console.log(`  adult-only: ${adultOnly.length} — ${adultOnly.join(', ')}`);

console.log(`\nAdult image correctness (per color verify cache):`);
let adultYes = 0, adultNo = 0, adultMaybe = 0, adultUnknown = 0;
for (const c of adultV.keys()) {
  const matches = Object.entries(cache).filter(([k]) => k.startsWith(`${adultPid}::${c.toLowerCase()}::`));
  const v = matches[0]?.[1];
  if (!v) adultUnknown++;
  else if (v.verdict === 'yes') adultYes++;
  else if (v.verdict === 'no') adultNo++;
  else adultMaybe++;
}
console.log(`  yes: ${adultYes}, no: ${adultNo}, maybe: ${adultMaybe}, unknown: ${adultUnknown}`);

console.log(`\nProposed remap (youth color → use adult's image of same color):`);
const remappable = both.filter(c => {
  const matches = Object.entries(cache).filter(([k]) => k.startsWith(`${adultPid}::${c.toLowerCase()}::`));
  const v = matches[0]?.[1];
  return v && v.verdict === 'yes';
});
console.log(`  ${remappable.length} colors are exact-match AND adult-image is verified correct.`);
if (remappable.length > 0) console.log(`  → ${remappable.join(', ')}`);
const blocked = both.filter(c => !remappable.includes(c));
if (blocked.length > 0) console.log(`  Blocked (adult color exists but its image not verified-yes): ${blocked.join(', ')}`);
