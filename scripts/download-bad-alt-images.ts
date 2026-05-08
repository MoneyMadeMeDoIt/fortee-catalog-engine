/**
 * Download the 13 BAD-ALT images on L01210 + L01250 for visual inspection.
 *
 * Reads tmp/bad-alt-mapping-proposal.tsv (produced by propose-bad-alt-mapping.ts).
 * Saves each image to tmp/bad-alt-images/{pid}-{shortMediaId}.{ext}.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../src/lib/logger.js';

const TSV = 'tmp/bad-alt-mapping-proposal.tsv';
const OUT_DIR = 'tmp/bad-alt-images';

interface Row { pid: string; mediaId: string; alt: string; url: string; category: string }

function parseTsv(): Row[] {
  const text = readFileSync(TSV, 'utf8');
  const lines = text.split(/\r?\n/);
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const [pid, mediaId, alt, url, category] = ln.split('\t');
    out.push({ pid, mediaId, alt, url, category });
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = parseTsv();
  logger.info(`Downloading ${rows.length} images to ${OUT_DIR}/`);

  for (const r of rows) {
    if (!r.url) { logger.warn(`  skip (no url): ${r.pid} ${r.mediaId}`); continue; }
    // Strip query params, keep extension from URL.
    const cleanUrl = r.url.split('?')[0];
    const ext = cleanUrl.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png';
    const shortId = r.mediaId.split('/').pop()?.replace(/[^a-zA-Z0-9]/g, '') ?? 'unknown';
    const fname = `${r.pid}-${shortId}.${ext}`;
    const filepath = `${OUT_DIR}/${fname}`;
    try {
      const resp = await fetch(r.url);
      if (!resp.ok) { logger.error(`  ${r.pid} ${shortId}: HTTP ${resp.status}`); continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      writeFileSync(filepath, buf);
      logger.info(`  ✓ ${fname}  (${(buf.length / 1024).toFixed(1)} KB)  alt="${r.alt}"`);
    } catch (e) {
      logger.error(`  ${r.pid} ${shortId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  logger.info(`\nDone. Open ${OUT_DIR}/ to view.`);
}

await main();
