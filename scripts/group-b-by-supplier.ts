import 'dotenv/config';
import { readFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';

const sheets = createSheetsClient();
const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'Bestsellers-Ready'` });
const rows = (r.data.values ?? []) as string[][];
const h: Record<string, number> = {};
rows[0].forEach((x, i) => { h[x] = i; });

const supplierByPid = new Map<string, string>();
for (let i = 1; i < rows.length; i++) {
  const pid = String(rows[i][h['productId']] ?? '').trim();
  const sup = String(rows[i][h['supplierCode']] ?? '').trim();
  if (pid && sup && !supplierByPid.has(pid)) supplierByPid.set(pid, sup);
}

const lines = readFileSync('tmp/color-mismatches-groupB.tsv', 'utf-8').trim().split('\n').slice(1);
const counts = { no: new Map<string, number>(), maybe: new Map<string, number>() };
const pidsByVerdictSupplier: Record<string, Map<string, Set<string>>> = { no: new Map(), maybe: new Map() };
for (const l of lines) {
  const [pid, , verdict] = l.split('\t');
  const sup = supplierByPid.get(pid) ?? 'UNKNOWN';
  const map = counts[verdict as 'no' | 'maybe'];
  if (!map) continue;
  map.set(sup, (map.get(sup) ?? 0) + 1);
  const pmap = pidsByVerdictSupplier[verdict];
  if (!pmap.has(sup)) pmap.set(sup, new Set());
  pmap.get(sup)!.add(pid);
}

console.log('=== Group B mismatches by supplier ===\n');
console.log(`${'supplier'.padEnd(20)} | no rows | no pids | maybe rows | maybe pids`);
console.log('-'.repeat(70));
const allSuppliers = new Set([...counts.no.keys(), ...counts.maybe.keys()]);
for (const sup of [...allSuppliers].sort()) {
  console.log(
    `${sup.padEnd(20)} | ${String(counts.no.get(sup) ?? 0).padEnd(7)} | ${String(pidsByVerdictSupplier.no.get(sup)?.size ?? 0).padEnd(7)} | ${String(counts.maybe.get(sup) ?? 0).padEnd(10)} | ${pidsByVerdictSupplier.maybe.get(sup)?.size ?? 0}`,
  );
}

// Top NO pids per supplier
for (const sup of allSuppliers) {
  const pids = [...(pidsByVerdictSupplier.no.get(sup) ?? new Set())];
  if (pids.length === 0) continue;
  console.log(`\nNo-mismatch pids in ${sup} (${pids.length}):`);
  // Count per pid
  const perPid = new Map<string, number>();
  for (const l of lines) {
    const [p, , v] = l.split('\t');
    if (v === 'no' && pids.includes(p)) perPid.set(p, (perPid.get(p) ?? 0) + 1);
  }
  const sorted = [...perPid.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pid, n] of sorted.slice(0, 15)) console.log(`  ${pid}: ${n}`);
  if (sorted.length > 15) console.log(`  ... and ${sorted.length - 15} more`);
}
