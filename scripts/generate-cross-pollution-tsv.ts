/**
 * Classify CROSS-POLLUTION rows into MOVE / KEEP-WHITELIST / TRASH-ORPHAN.
 *
 * Reads tmp/imagery-audit.tsv (CROSS-POLLUTION rows only) and BR pid index,
 * then writes tmp/cross-pollution-resolution.tsv with a suggested action
 * per row. Does NOT mutate Drive — output is a review artifact for plan
 * 14-03 to apply.
 *
 * Heuristic per row (parent-pid + filename):
 *   1. MOVE-TO-{otherPid}
 *      Filename's pid signature (via fileBelongsToPid logic) matches exactly
 *      one OTHER BR pid → file is in the wrong folder, move it.
 *      Multiple matches → MOVE-AMBIGUOUS:{p1,p2,...}.
 *   2. KEEP-WHITELIST-{brand}
 *      Filename starts with a branded prefix (BELLA_, Richardson_, etc.)
 *      and the parent pid's numeric token appears embedded after the brand
 *      → file is correctly placed; audit needs an allowlist entry.
 *   3. TRASH-ORPHAN
 *      Otherwise — filename has no pid signature and no brand pattern.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const AUDIT_TSV = 'tmp/imagery-audit.tsv';
const OUTPUT_TSV = 'tmp/cross-pollution-resolution.tsv';

interface BrIndex {
  pids: string[];
  pidToSupplier: Map<string, string>;
}

async function loadBrIndex(): Promise<BrIndex> {
  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  if (rows.length === 0) throw new Error('Bestsellers-Ready is empty');
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  const pidIdx = h['productId'];
  const supplierIdx = h['supplierCode'];
  if (pidIdx === undefined) throw new Error('productId column not found');

  const pidSet = new Set<string>();
  const pidToSupplier = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][pidIdx] ?? '').trim();
    if (!pid) continue;
    pidSet.add(pid);
    if (supplierIdx !== undefined) {
      const supp = String(rows[i][supplierIdx] ?? '').trim();
      if (supp && !pidToSupplier.has(pid)) pidToSupplier.set(pid, supp);
    }
  }
  return { pids: [...pidSet].sort(), pidToSupplier };
}

/** Replicates audit-product-imagery.ts fileBelongsToPid (without the supplier-allowlist
 *  branch — we test brand-prefix separately). Returns true if `name` looks like it
 *  belongs to `pid` by raw or numeric prefix. */
function looksLikePid(pid: string, name: string): boolean {
  const lower = name.toLowerCase();
  const pidLower = pid.toLowerCase();
  if (lower.startsWith(`${pidLower}_`) || lower.startsWith(`${pidLower}-`) || lower.startsWith(`${pidLower}.`)) return true;
  const numericMatch = pidLower.match(/[a-z]*(\d+)[a-z]*/);
  if (numericMatch) {
    const num = numericMatch[1];
    const numStripped = num.replace(/^0+/, '');
    if (lower.startsWith(`${num}-`) || lower.startsWith(`${num}_`) ||
        lower.startsWith(`${numStripped}-`) || lower.startsWith(`${numStripped}_`) ||
        lower.startsWith(`${numStripped} `)) return true;
  }
  return false;
}

/** Detects a branded prefix like `Richardson_`, `BELLA_+_CANVAS_`, `Next_Level_`,
 *  `Gildan_`, `Independent_Trading_` etc. — alphabetic word(s) joined by `_` (or
 *  `_+_`) followed by an underscore separator. Returns the brand token (everything
 *  before the first numeric segment), or null if no branded pattern. */
function extractBrandPrefix(name: string): string | null {
  // Match: capitalized-or-mixed word, optional more `_word`/`_+_word` segments,
  // then a `_` or `-` separator before the numeric pid token.
  const m = name.match(/^([A-Za-z]+(?:_(?:\+_)?[A-Za-z]+)*)[_-](\d+)[_-]/);
  if (!m) return null;
  const brand = m[1];
  // Filter: don't treat plain numeric prefixes as brands (they aren't matched
  // by the regex anyway, but defensive). Also reject single-letter prefixes.
  if (brand.length < 2) return null;
  return brand;
}

/** Extracts the embedded numeric token after the brand prefix, if any. */
function extractEmbeddedPidNumber(name: string): string | null {
  const m = name.match(/^[A-Za-z]+(?:_(?:\+_)?[A-Za-z]+)*[_-](\d+)[_-]/);
  return m ? m[1] : null;
}

/** Numeric portion of a pid (e.g. L01290 → "1290"; 5000 → "5000"). */
function pidNumber(pid: string): string {
  const m = pid.match(/[a-z]*(\d+)[a-z]*/i);
  return m ? m[1].replace(/^0+/, '') : '';
}

interface AuditRow { pid: string; filename: string }

function parseAuditTsv(): AuditRow[] {
  const text = readFileSync(AUDIT_TSV, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const pidIdx = header.indexOf('pid');
  const checkIdx = header.indexOf('check');
  const detailIdx = header.indexOf('detail');
  if (pidIdx < 0 || checkIdx < 0 || detailIdx < 0) {
    throw new Error(`Expected pid/check/detail columns; got header: ${header.join(' | ')}`);
  }

  const out: AuditRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cols = ln.split('\t');
    if (cols[checkIdx] !== 'CROSS-POLLUTION') continue;
    const pid = cols[pidIdx];
    const detail = cols[detailIdx];
    const m = detail.match(/Drive file "([^"]+)"/);
    if (!m) {
      logger.warn(`Skipping unparsable CROSS-POLLUTION row: ${ln}`);
      continue;
    }
    out.push({ pid, filename: m[1] });
  }
  return out;
}

interface Classification { suggested: string; reason: string }

function classify(row: AuditRow, br: BrIndex): Classification {
  const { pid: parentPid, filename } = row;

  // 1. MOVE-TO-X: filename matches another pid by raw/numeric prefix
  const matches = br.pids.filter(p => p !== parentPid && looksLikePid(p, filename));
  if (matches.length === 1) {
    return {
      suggested: `MOVE-TO-${matches[0]}`,
      reason: `Filename pid signature matches BR pid ${matches[0]}`,
    };
  }
  if (matches.length > 1) {
    return {
      suggested: `MOVE-AMBIGUOUS:${matches.slice(0, 3).join(',')}${matches.length > 3 ? ',…' : ''}`,
      reason: `Filename signature matches ${matches.length} BR pids; manual review`,
    };
  }

  // 2. KEEP-WHITELIST-{brand}: branded prefix + embedded pid number matches parent
  const brand = extractBrandPrefix(filename);
  const embedNum = extractEmbeddedPidNumber(filename);
  if (brand && embedNum) {
    const parentNum = pidNumber(parentPid);
    if (parentNum && embedNum === parentNum) {
      return {
        suggested: `KEEP-WHITELIST-${brand}`,
        reason: `Branded prefix "${brand}_" with embedded pid ${embedNum} matches parent — propose adding to KNOWN_SUPPLIER_PREFIXES['${parentPid}']`,
      };
    }
    // Brand prefix but embed number doesn't match parent → it's actually
    // someone else's branded file. Surface as MOVE-AMBIGUOUS-by-brand.
    return {
      suggested: `INVESTIGATE-BRAND`,
      reason: `Branded "${brand}_${embedNum}_" prefix but parent pid is ${parentPid} (numeric ${pidNumber(parentPid)}) — likely belongs elsewhere`,
    };
  }

  // 3. TRASH-ORPHAN
  return {
    suggested: `TRASH-ORPHAN`,
    reason: `No pid signature, no recognized brand prefix`,
  };
}

async function main(): Promise<void> {
  logger.info(`generate-cross-pollution-tsv: reading ${AUDIT_TSV}`);
  const rows = parseAuditTsv();
  logger.info(`CROSS-POLLUTION rows parsed: ${rows.length}`);

  logger.info(`Loading BR pid index…`);
  const br = await loadBrIndex();
  logger.info(`BR pids: ${br.pids.length}; with supplierCode: ${br.pidToSupplier.size}`);

  const lines: string[] = [`pid\tfilename\tsuggested_action\treason`];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const c = classify(row, br);
    lines.push(`${row.pid}\t${row.filename}\t${c.suggested}\t${c.reason}`);
    // Group buckets: "MOVE-TO-S05772" → "MOVE-TO", "KEEP-WHITELIST-BELLA_+_CANVAS"
    // → "KEEP-WHITELIST", "MOVE-AMBIGUOUS:p1,p2" → "MOVE-AMBIGUOUS",
    // "TRASH-ORPHAN" / "INVESTIGATE-BRAND" stay as-is.
    let bucket = c.suggested;
    if (bucket.startsWith('MOVE-TO-')) bucket = 'MOVE-TO';
    else if (bucket.startsWith('MOVE-AMBIGUOUS')) bucket = 'MOVE-AMBIGUOUS';
    else if (bucket.startsWith('KEEP-WHITELIST-')) bucket = 'KEEP-WHITELIST';
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  writeFileSync(OUTPUT_TSV, lines.join('\n') + '\n');
  logger.info(`\nWrote ${OUTPUT_TSV} (${rows.length} data rows)`);
  logger.info(`\n=== Action distribution ===`);
  for (const [bucket, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    logger.info(`  ${n.toString().padStart(4)} ${bucket}`);
  }
}

await main();
