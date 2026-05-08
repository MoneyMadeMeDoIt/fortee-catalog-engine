/**
 * Inspect BAD-ALT media on L01210 and L01250: list current alts, image
 * URLs, and surface enough info to decide (rename / whitelist / delete).
 *
 * Per the plan, the proposal would write a TSV with `pid | mediaId |
 * image_url | current_alt | proposed_alt | inferred_color | inferred_view`.
 * But before locking in a rename direction, we want to see the full
 * media context for each pid (canonical color/view alts that DO exist
 * alongside the bad ones), since the bad-alt rows might be intentional
 * decoration samples rather than mislabeled color images.
 *
 * Output: tmp/bad-alt-mapping-proposal.tsv  (rows for 13 BAD-ALT media)
 *         + per-pid context summary in stdout
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { createShopifyClient } from '../src/shopify/client.js';
import { resolveStoreProduct } from '../src/shopify/resolve-store-product.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const PIDS = ['L01210', 'L01250'];

const MEDIA_QUERY = `
  query productMedia($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      media(first: 250) {
        edges {
          node {
            ... on MediaImage { id alt image { url } }
          }
        }
      }
    }
  }
`;

interface MediaRow { pid: string; mediaId: string; alt: string; url: string }

const DECORATION_PATTERNS = [
  /^left chest print$/i,
  /^right chest print$/i,
  /^back print$/i,
  /^front print$/i,
  /^sleeve print$/i,
];

function isCanonicalAlt(alt: string): boolean {
  // canonical = "<color> (front|back|left side|right side|side)"
  return /^.+\s+(front|back|left side|right side|side|model front)$/i.test(alt);
}

function isDecorationAlt(alt: string): boolean {
  return DECORATION_PATTERNS.some(re => re.test(alt));
}

async function inspectPid(client: ShopifyClient, pid: string): Promise<MediaRow[]> {
  const product = await resolveStoreProduct(client, pid);
  const r = (await client.request(MEDIA_QUERY, { variables: { id: product.id } })) as { data: { product: { handle: string; title: string; media: { edges: { node: { id?: string; alt?: string; image?: { url?: string } } }[] } } } };
  const all = r.data.product.media.edges.map(e => e.node).filter(n => n?.id);

  // Bucket
  const canonical: typeof all = [];
  const decoration: typeof all = [];
  const empty: typeof all = [];
  const other: typeof all = [];
  for (const m of all) {
    const alt = (m.alt ?? '').trim();
    if (alt === '') empty.push(m);
    else if (isCanonicalAlt(alt)) canonical.push(m);
    else if (isDecorationAlt(alt)) decoration.push(m);
    else other.push(m);
  }

  logger.info(`\n=== ${product.handle} (${product.title}) ===`);
  logger.info(`Total media: ${all.length}`);
  logger.info(`  canonical (color view): ${canonical.length}`);
  logger.info(`  decoration-zone:        ${decoration.length}`);
  logger.info(`  empty alt:              ${empty.length}`);
  logger.info(`  other:                  ${other.length}`);

  if (decoration.length > 0) {
    logger.info(`\n  Decoration alts:`);
    for (const m of decoration) logger.info(`    "${m.alt}"  ${m.image?.url?.split('/').pop()}`);
  }
  if (empty.length > 0) {
    logger.info(`\n  Empty alts:`);
    for (const m of empty) logger.info(`    (empty)  ${m.image?.url?.split('/').pop()}`);
  }
  if (other.length > 0) {
    logger.info(`\n  Other non-canonical alts:`);
    for (const m of other) logger.info(`    "${m.alt}"  ${m.image?.url?.split('/').pop()}`);
  }

  // Output rows: ALL non-canonical media (decoration + empty + other)
  const out: MediaRow[] = [];
  for (const m of [...decoration, ...empty, ...other]) {
    out.push({ pid, mediaId: m.id!, alt: (m.alt ?? '').trim(), url: m.image?.url ?? '' });
  }
  return out;
}

async function main(): Promise<void> {
  const client = await createShopifyClient('DEST_SHOPIFY_');
  const allRows: MediaRow[] = [];
  for (const pid of PIDS) {
    const rows = await inspectPid(client, pid);
    allRows.push(...rows);
  }

  // Write TSV (no proposed_alt yet — user decides direction first)
  const lines = [`pid\tmediaId\tcurrent_alt\timage_url\tcategory`];
  for (const r of allRows) {
    let category = 'OTHER';
    if (r.alt === '') category = 'EMPTY';
    else if (isDecorationAlt(r.alt)) category = 'DECORATION-ZONE';
    lines.push(`${r.pid}\t${r.mediaId}\t${r.alt || '(empty)'}\t${r.url}\t${category}`);
  }
  writeFileSync('tmp/bad-alt-mapping-proposal.tsv', lines.join('\n') + '\n');
  logger.info(`\nWrote tmp/bad-alt-mapping-proposal.tsv with ${allRows.length} rows`);
}

await main();
