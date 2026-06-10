/**
 * URL-render validator for Drive→BR image URLs (Phase 18-03).
 *
 * Samples a random set of Drive `uc?id=<fileId>` URLs from either:
 *   (a) a dry-run diff TSV produced by `scripts/link-br-images.ts` (--from-tsv <path>), or
 *   (b) the live Bestsellers-Ready sheet FrontImage column (default).
 *
 * For each URL it issues an HTTP HEAD request (falling back to a 1-byte ranged GET
 * if the host does not support HEAD), inspects the Content-Type response header,
 * and classifies the result as:
 *   - "ok"        — Content-Type starts with `image/` (real image, publicly accessible)
 *   - "not-image" — 200 but Content-Type is text/html or not an image type
 *                   (Drive shows an HTML interstitial for private files)
 *   - "forbidden" — 4xx / 5xx status (permission denied, file gone, server error)
 *
 * Usage:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/check-br-image-urls.ts
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/check-br-image-urls.ts --from-tsv tmp/link-br-images-plan-<ts>.tsv
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/check-br-image-urls.ts --sample 20
 *
 * Any non-"ok" result is a P7 Drive-permission gap that must be resolved before sign-off.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import https from 'node:https';
import { google } from 'googleapis';
import { createSheetsClient } from '../src/sheets/client.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Input to classifyHeadResponse — the resolved HTTP response metadata. */
export interface HeadResponseInput {
  /** HTTP status code of the final response (after following redirects). */
  status: number;
  /** Value of the Content-Type header, or undefined if absent. */
  contentType: string | undefined;
  /** True if the request was redirected before reaching this response. */
  wasRedirected?: boolean;
}

/** Classification outcome for a single URL. */
export type UrlClassification = 'ok' | 'not-image' | 'forbidden';

// ─── Pure classifier ───────────────────────────────────────────────────────────

/**
 * Classify an HTTP response as ok / not-image / forbidden.
 *
 * Pure function — no I/O. Injected into tests via mocked response objects.
 *
 * Rules:
 *   - 4xx or 5xx status → "forbidden" (regardless of content-type)
 *   - status 200 + content-type starting with "image/" → "ok"
 *   - status 200 + any other content-type (or absent) → "not-image"
 *     (Drive returns text/html for private-file interstitials even with status 200)
 *   - Redirect is transparent: caller follows and passes the final status+contentType.
 */
export function classifyHeadResponse(input: HeadResponseInput): UrlClassification {
  const { status, contentType } = input;

  // 4xx / 5xx → forbidden
  if (status >= 400) {
    return 'forbidden';
  }

  // 200-series: check content-type
  const ct = (contentType ?? '').trim().toLowerCase();
  if (ct.startsWith('image/')) {
    return 'ok';
  }

  // 200 but non-image content-type (html interstitial, json, etc.)
  return 'not-image';
}

// ─── HTTP probe helpers ────────────────────────────────────────────────────────

/** Timeout for each HTTP probe (ms). */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Issue an HTTP HEAD request to `url` using the built-in `https` module.
 * Follows up to 3 redirects manually (node:https does not auto-follow).
 * Falls back to a 1-byte ranged GET if the server returns 405 (Method Not Allowed).
 *
 * Returns a HeadResponseInput suitable for classifyHeadResponse.
 */
function probeUrl(url: string): Promise<HeadResponseInput> {
  return probeWithMethod(url, 'HEAD', 0);
}

function probeWithMethod(
  url: string,
  method: 'HEAD' | 'GET',
  redirectCount: number,
): Promise<HeadResponseInput> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      resolve({ status: 0, contentType: undefined, wasRedirected: redirectCount > 0 });
      return;
    }

    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      method,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; br-image-url-checker/1.0)',
        ...(method === 'GET' ? { 'Range': 'bytes=0-0' } : {}),
      },
      timeout: PROBE_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      // Consume the body to release the socket (important for HEAD + ranged GET).
      res.resume();

      const status = res.statusCode ?? 0;
      const contentType = res.headers['content-type'];
      const location = res.headers['location'];

      // Follow 3xx redirects.
      if (status >= 300 && status < 400 && location) {
        probeWithMethod(location, method, redirectCount + 1)
          .then(r => resolve({ ...r, wasRedirected: true }))
          .catch(reject);
        return;
      }

      // 405 Method Not Allowed → retry with a 1-byte ranged GET.
      if (status === 405 && method === 'HEAD') {
        probeWithMethod(url, 'GET', redirectCount)
          .then(resolve)
          .catch(reject);
        return;
      }

      resolve({
        status,
        contentType: contentType ?? undefined,
        wasRedirected: redirectCount > 0,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, contentType: undefined });
    });

    req.on('error', (err) => {
      // Treat network errors as forbidden (cannot reach the file).
      resolve({ status: 0, contentType: undefined });
    });

    req.end();
  });
}

// ─── TSV URL extractor ────────────────────────────────────────────────────────

/**
 * Extract `newUrl` values from a link-br-images diff TSV.
 * Expected header: pid\tcolor\trole\trange\toldUrl\tnewUrl
 */
function extractUrlsFromDiffTsv(tsvPath: string): string[] {
  const content = fs.readFileSync(tsvPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length < 2) return [];

  // Find the newUrl column index from the header line.
  const header = lines[0].split('\t');
  const newUrlIdx = header.indexOf('newUrl');
  if (newUrlIdx === -1) {
    throw new Error(`[check-br-image-urls] TSV header has no 'newUrl' column: ${lines[0]}`);
  }

  const urls: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split('\t');
    const url = cols[newUrlIdx]?.trim();
    if (url && url.startsWith('https://')) urls.push(url);
  }
  return urls;
}

// ─── Live-sheet URL sampler ────────────────────────────────────────────────────

const MAIN_ID   = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const TAB       = 'Bestsellers-Ready';
const FRONT_COL = 'FrontImage';

/**
 * Read the FrontImage column from the live BR sheet and return all non-empty URLs.
 */
async function fetchFrontImageUrls(): Promise<string[]> {
  const sheets = createSheetsClient();
  const sheetsApi = google.sheets({
    version: 'v4',
    auth: (sheets as any).context._options.auth,
  });

  // Read the header to locate FrontImage column.
  const headerResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'!1:1`,
  });
  const headers: string[] = (headerResp.data.values?.[0] ?? []).map((h: unknown) =>
    String(h ?? '').trim()
  );
  const colIdx = headers.indexOf(FRONT_COL);
  if (colIdx === -1) throw new Error(`[check-br-image-urls] Column '${FRONT_COL}' not found in BR header`);

  // Read the full data range (just the FrontImage column).
  const { columnToLetter } = await import('../src/sheets/column-map.js');
  const colLetter = columnToLetter(colIdx);
  const dataResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: MAIN_ID,
    range: `'${TAB}'!${colLetter}2:${colLetter}`,
  });
  const cells = (dataResp.data.values ?? []) as string[][];
  const urls: string[] = [];
  for (const row of cells) {
    const v = (row[0] ?? '').trim();
    if (v.startsWith('https://')) urls.push(v);
  }
  return urls;
}

// ─── Random sample ────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromTsvIdx = args.indexOf('--from-tsv');
  const fromTsv = fromTsvIdx >= 0 ? args[fromTsvIdx + 1] : undefined;
  const sampleArgIdx = args.indexOf('--sample');
  const sampleN = sampleArgIdx >= 0 ? parseInt(args[sampleArgIdx + 1] ?? '10', 10) : 10;

  console.log('=== check-br-image-urls ===');
  console.log(`Sample size: ${sampleN}`);

  let allUrls: string[];
  if (fromTsv) {
    console.log(`Source: diff TSV (${fromTsv})`);
    allUrls = extractUrlsFromDiffTsv(path.resolve(fromTsv));
    console.log(`  Found ${allUrls.length} newUrl entries in TSV`);
  } else {
    console.log(`Source: live BR sheet (${FRONT_COL} column)`);
    console.log('  NOTE: prefix this command with NODE_OPTIONS=--use-system-ca on AV-intercepting machines');
    allUrls = await fetchFrontImageUrls();
    console.log(`  Found ${allUrls.length} non-empty FrontImage URLs in BR`);
  }

  if (allUrls.length === 0) {
    console.log('[WARN] No URLs found to sample. Check source.');
    return;
  }

  const sampled = pickRandom(allUrls, sampleN);
  console.log(`\nProbing ${sampled.length} URL(s)...\n`);

  const results: { url: string; classification: UrlClassification; status: number; contentType: string }[] = [];

  for (const url of sampled) {
    const resp = await probeUrl(url);
    const classification = classifyHeadResponse(resp);
    const shortUrl = url.length > 70 ? url.slice(0, 67) + '...' : url;
    const flag = classification === 'ok' ? '[OK]' : classification === 'not-image' ? '[NOT-IMAGE]' : '[FORBIDDEN]';
    console.log(`  ${flag.padEnd(12)} ${resp.status}  ${resp.contentType ?? '(no content-type)'}  ${shortUrl}`);
    results.push({
      url,
      classification,
      status: resp.status,
      contentType: resp.contentType ?? '',
    });
  }

  const okCount        = results.filter(r => r.classification === 'ok').length;
  const notImageCount  = results.filter(r => r.classification === 'not-image').length;
  const forbiddenCount = results.filter(r => r.classification === 'forbidden').length;

  console.log('\n=== Summary ===');
  console.log(`  ok:        ${okCount} / ${sampled.length}`);
  console.log(`  not-image: ${notImageCount} / ${sampled.length}  (Drive permission interstitial)`);
  console.log(`  forbidden: ${forbiddenCount} / ${sampled.length}  (403 / 404 / unreachable)`);

  if (notImageCount > 0 || forbiddenCount > 0) {
    console.log('\n[WARN] Non-ok URLs detected — Drive permission gaps (P7). Repair before sign-off:');
    for (const r of results.filter(r => r.classification !== 'ok')) {
      console.log(`  ${r.classification.toUpperCase().padEnd(10)} status=${r.status}  ${r.url}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n[PASS] All sampled URLs return image/* — no Drive permission gaps detected.');
  }
}

main().catch(err => {
  console.error('[check-br-image-urls] Fatal:', err.message ?? err);
  process.exit(1);
});
