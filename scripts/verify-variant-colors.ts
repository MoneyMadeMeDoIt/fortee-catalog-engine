/**
 * Verify each (pid, color) in BR against its FrontImage using vision.
 *
 * Why: AI generation and supplier mislabeling can produce variants whose
 * stated color name doesn't match the actual garment color in the image. This
 * script flags mismatches so a human can decide per-case whether to rename the
 * variant or swap the image.
 *
 * Approach:
 *   1. Read Bestsellers-Ready, dedupe by (pid, color), keep first row's FrontImage.
 *   2. For each (pid, color), download FrontImage from Drive and send to gpt-4o
 *      asking it to identify the garment color and judge whether it matches
 *      the stated color name.
 *   3. Cache verdicts by (pid + color + sha of FrontImage URL) in
 *      tmp/color-verify-cache.json so reruns are free.
 *   4. Emit tmp/color-mismatches.tsv with all rows where verdict !== 'yes'.
 *
 * The script does NOT modify BR or the store. It only produces a report.
 *
 * Flags:
 *   --limit N           process at most N (pid, color) pairs
 *   --pids a,b,c        restrict to these productIds
 *   --no-cache          ignore cache, regenerate everything
 *   --print             echo each verdict to stdout (default: only mismatches)
 *
 * Recommended first run:
 *   npx tsx -r dotenv/config scripts/verify-variant-colors.ts --limit 5 --print
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createSheetsClient } from '../src/sheets/client.js';
import { logger } from '../src/lib/logger.js';

const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const CACHE_PATH = path.join('tmp', 'color-verify-cache.json');
const REPORT_PATH = path.join('tmp', 'color-mismatches.tsv');

interface Args { limit: number; pids: string[] | null; noCache: boolean; print: boolean; concurrency: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { limit: Infinity, pids: null, noCache: false, print: false, concurrency: 8 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--pids') a.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--no-cache') a.noCache = true;
    else if (x === '--print') a.print = true;
    else if (x === '--concurrency') a.concurrency = Math.max(1, parseInt(argv[++i], 10));
  }
  return a;
}

interface CacheEntry {
  detected: string;
  verdict: 'yes' | 'no' | 'maybe';
  confidence: number;
  reasoning: string;
  ts: number;
}
type Cache = Record<string, CacheEntry>;
let cache: Cache = {};
function loadCache(): void {
  if (existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); } catch { cache = {}; }
  }
}
function saveCache(): void { writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }
function cacheKey(pid: string, color: string, frontUrl: string): string {
  return `${pid}::${color.toLowerCase()}::${createHash('sha256').update(frontUrl).digest('hex').slice(0, 16)}`;
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

let cachedDrive: drive_v3.Drive | null = null;
function getDrive(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

function extractDriveId(url: string): string | null {
  const m = url.match(/[?&]id=([\w-]+)/) || url.match(/\/d\/([\w-]+)/);
  return m ? m[1] : null;
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  const fileId = extractDriveId(url);
  if (!fileId) return null;
  try {
    const drive = getDrive();
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    return buf.toString('base64');
  } catch (e) {
    logger.warn(`Drive fetch failed for ${fileId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const SYSTEM_PROMPT = `You judge whether the garment in an apparel product photo matches a stated color name.

Look at the image and identify the dominant color of the GARMENT (ignore background, props, model skin, prints/logos).

Return STRICT JSON only, no prose:
{
  "detected": "<plain English color, e.g. forest green, charcoal heather, navy blue>",
  "verdict": "yes" | "no" | "maybe",
  "confidence": 0.0-1.0,
  "reasoning": "<1 short sentence>"
}

Rules:
- "yes" = stated and detected refer to the same color, even if the names differ ("Sport Grey" ↔ "heather gray", "Sapphire" ↔ "royal blue", "Charcoal Heather" ↔ "heather charcoal").
- "no" = clearly different color families (e.g. stated "Red" but image shows blue).
- "maybe" = ambiguous edge — heather variants, two-tones, or when the image is unclear.
- For triblends/heathers, the marled/heather appearance counts: stated "Athletic Heather" matches a flecked light grey.
- For multi-color garments (color blocks, contrast trim), judge by the DOMINANT color.
- For black-and-white-ish: stated "Charcoal" and image shows pure black → "maybe" not "no".`;

interface VerdictResult {
  detected: string;
  verdict: 'yes' | 'no' | 'maybe';
  confidence: number;
  reasoning: string;
}

async function classifyColor(stated: string, imageBase64: string): Promise<VerdictResult | null> {
  const client = getClient();
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 200,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Stated color name: "${stated}". Judge.` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
        ],
      },
    ],
  });
  const raw = (res.choices[0]?.message?.content ?? '').trim();
  try {
    const j = JSON.parse(raw);
    if (typeof j.detected !== 'string') return null;
    if (j.verdict !== 'yes' && j.verdict !== 'no' && j.verdict !== 'maybe') return null;
    return {
      detected: String(j.detected),
      verdict: j.verdict,
      confidence: typeof j.confidence === 'number' ? j.confidence : 0.5,
      reasoning: String(j.reasoning ?? ''),
    };
  } catch {
    logger.warn(`Bad JSON from vision: ${raw.slice(0, 200)}`);
    return null;
  }
}

interface PairRow { pid: string; color: string; frontUrl: string }

function buildPairs(rows: string[][]): PairRow[] {
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  const seen = new Set<string>();
  const out: PairRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const pid = String(r[h['productId']] ?? '').trim();
    const color = String(r[h['colorName']] ?? '').trim();
    const frontUrl = String(r[h['FrontImage']] ?? '').trim();
    if (!pid || !color || !frontUrl) continue;
    const k = `${pid}|${color.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ pid, color, frontUrl });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`verify-variant-colors starting: ${JSON.stringify({ ...args, pids: args.pids?.length })}`);
  loadCache();
  logger.info(`Cache loaded: ${Object.keys(cache).length} entries`);

  const sheets = createSheetsClient();
  const brResp = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const brRows = (brResp.data.values ?? []) as string[][];
  let pairs = buildPairs(brRows);
  logger.info(`Built ${pairs.length} unique (pid, color) pairs from BR`);
  if (args.pids) pairs = pairs.filter(p => args.pids!.includes(p.pid));
  if (Number.isFinite(args.limit)) pairs = pairs.slice(0, args.limit);
  logger.info(`Processing ${pairs.length} pairs`);

  const mismatches: { pid: string; color: string; frontUrl: string; v: CacheEntry }[] = [];
  let yesCount = 0, noCount = 0, maybeCount = 0, fetchFail = 0, classifyFail = 0, cacheHits = 0, generated = 0;
  let processed = 0;

  async function processOne(p: PairRow): Promise<void> {
    const k = cacheKey(p.pid, p.color, p.frontUrl);
    let entry = args.noCache ? null : cache[k];
    if (entry) cacheHits++;

    if (!entry) {
      const b64 = await fetchImageAsBase64(p.frontUrl);
      if (!b64) { fetchFail++; processed++; return; }
      const r = await classifyColor(p.color, b64);
      if (!r) { classifyFail++; processed++; return; }
      entry = { ...r, ts: Date.now() };
      cache[k] = entry;
      generated++;
    }

    if (entry.verdict === 'yes') yesCount++;
    else if (entry.verdict === 'no') { noCount++; mismatches.push({ ...p, v: entry }); }
    else { maybeCount++; mismatches.push({ ...p, v: entry }); }

    if (args.print || entry.verdict !== 'yes') {
      logger.info(`[${p.pid}/${p.color}] ${entry.verdict} (conf=${entry.confidence.toFixed(2)}) detected="${entry.detected}" — ${entry.reasoning}`);
    }
    processed++;
  }

  // Concurrent worker pool with periodic cache + progress flush
  const N = args.concurrency;
  let cursor = 0;
  let lastFlush = 0;
  async function worker(): Promise<void> {
    while (cursor < pairs.length) {
      const idx = cursor++;
      try { await processOne(pairs[idx]); }
      catch (e) { classifyFail++; processed++; logger.warn(`[${pairs[idx].pid}/${pairs[idx].color}] worker error: ${e instanceof Error ? e.message : e}`); }
      if (processed - lastFlush >= 50) {
        lastFlush = processed;
        logger.info(`Progress: ${processed}/${pairs.length} (yes=${yesCount} no=${noCount} maybe=${maybeCount} fail=${fetchFail + classifyFail})`);
        saveCache();
      }
    }
  }
  await Promise.all(Array.from({ length: N }, () => worker()));
  saveCache();

  // Write report
  const lines = ['productId\tcolorName\tverdict\tconfidence\tdetected\treasoning\tfrontImageUrl'];
  for (const m of mismatches) {
    lines.push([m.pid, m.color, m.v.verdict, m.v.confidence.toFixed(2), m.v.detected, m.v.reasoning, m.frontUrl].join('\t'));
  }
  writeFileSync(REPORT_PATH, lines.join('\n') + '\n');

  logger.info(`\n=== Summary ===`);
  logger.info(`Total processed:  ${pairs.length}`);
  logger.info(`yes (match):      ${yesCount}`);
  logger.info(`no (mismatch):    ${noCount}`);
  logger.info(`maybe (review):   ${maybeCount}`);
  logger.info(`Fetch failed:     ${fetchFail}`);
  logger.info(`Classify failed:  ${classifyFail}`);
  logger.info(`Cache hits:       ${cacheHits}`);
  logger.info(`Generated new:    ${generated}`);
  logger.info(`Mismatches written to ${REPORT_PATH} (${mismatches.length} rows)`);
}

await main();
