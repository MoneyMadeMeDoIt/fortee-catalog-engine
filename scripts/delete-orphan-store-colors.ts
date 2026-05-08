/**
 * Delete orphan-color media from a store product (one-shot).
 *
 * Background: pid 5000 carries 15 colors on the store that don't exist in
 * Bestsellers-Ready. They were left behind when the BR rows for those
 * colors were dropped (see drop-br-colors.ts) but the store-side media was
 * never reaped because the previous lookup silently picked the wrong
 * handle (`first: 1` against `handle:*5000*` matched a stale duplicate).
 *
 * This script reaps those 15 colors from the LIVE store product, resolved
 * via resolveStoreProduct (which throws on >1 match — see 14-01).
 *
 * Default mode is dry-run (per-color match counts). Pass --apply to mutate.
 *
 * Output log: tmp/orphan-5000-delete.log
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { createShopifyClient } from '../src/shopify/client.js';
import { resolveStoreProduct } from '../src/shopify/resolve-store-product.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const PID = '5000';
const ORPHAN_COLORS = [
  'Aquatic',
  'Antique Jade Dome',
  'Antique Orange',
  'Berry',
  'Blackberry',
  'Blue Dusk',
  'Brown Savana',
  'Cobalt',
  'Dusty Rose',
  'Electric Green',
  'Lilac',
  'Midnight',
  'Neon Blue',
  'Neon Green',
  'Russet',
];

const LOG_PATH = 'tmp/orphan-5000-delete.log';

const PRODUCT_MEDIA_QUERY = `
  query productMedia($id: ID!) {
    product(id: $id) {
      id
      handle
      media(first: 250) {
        edges {
          node {
            ... on MediaImage { id alt }
          }
        }
      }
    }
  }
`;

const PRODUCT_DELETE_MEDIA = `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message code }
    }
  }
`;

interface Args { apply: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false };
  for (const x of argv) {
    if (x === '--apply') a.apply = true;
  }
  return a;
}

interface Match { mediaId: string; alt: string; color: string }

async function fetchMediaMatches(
  client: ShopifyClient,
  productId: string,
): Promise<Match[]> {
  const r = (await client.request(PRODUCT_MEDIA_QUERY, {
    variables: { id: productId },
  })) as { data: { product: { media: { edges: { node: { id?: string; alt?: string } }[] } } } };

  const colorLower = new Set(ORPHAN_COLORS.map(c => c.toLowerCase()));
  const matches: Match[] = [];

  for (const edge of r.data.product.media.edges) {
    const m = edge.node;
    if (!m?.id) continue;
    const alt = (m.alt ?? '').trim();
    const mm = alt.match(/^(.+?)\s+(left side|right side|front|back|side)$/i);
    if (!mm) continue;
    const colorName = mm[1].trim();
    if (colorLower.has(colorName.toLowerCase())) {
      matches.push({ mediaId: m.id, alt, color: colorName });
    }
  }
  return matches;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lines: string[] = [];
  const log = (msg: string): void => { logger.info(msg); lines.push(msg); };

  log(`delete-orphan-store-colors: pid=${PID} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} colors=${ORPHAN_COLORS.length}`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  const product = await resolveStoreProduct(client, PID);
  log(`resolved: ${product.handle} (${product.id})`);

  const matches = await fetchMediaMatches(client, product.id);

  // Per-color summary
  const perColor = new Map<string, number>();
  for (const m of matches) perColor.set(m.color, (perColor.get(m.color) ?? 0) + 1);
  log(`\n=== Match summary ===`);
  for (const c of ORPHAN_COLORS) {
    const n = perColor.get(c) ?? 0;
    log(`  ${n.toString().padStart(3)} × ${c}${n === 0 ? '  (no media — already absent)' : ''}`);
  }
  log(`Total matches: ${matches.length}`);

  if (matches.length === 0) {
    log(`No matching media — nothing to do.`);
    writeFileSync(LOG_PATH, lines.join('\n') + '\n');
    return;
  }

  if (!args.apply) {
    log(`\n[DRY-RUN] Would delete ${matches.length} media. Re-run with --apply to execute.`);
    writeFileSync(LOG_PATH, lines.join('\n') + '\n');
    return;
  }

  // Live delete (chunked — Shopify caps mediaIds per call)
  const CHUNK = 100;
  let deleted = 0;
  let errorCount = 0;
  for (let i = 0; i < matches.length; i += CHUNK) {
    const slice = matches.slice(i, i + CHUNK);
    const ids = slice.map(m => m.mediaId);
    const resp = (await client.request(PRODUCT_DELETE_MEDIA, {
      variables: { productId: product.id, mediaIds: ids },
    })) as { data: { productDeleteMedia: { deletedMediaIds: string[]; mediaUserErrors: { field: string[]; message: string; code: string }[] } } };

    const errs = resp.data.productDeleteMedia.mediaUserErrors ?? [];
    const got = resp.data.productDeleteMedia.deletedMediaIds?.length ?? 0;
    deleted += got;
    if (errs.length > 0) {
      errorCount += errs.length;
      for (const e of errs) log(`  ERROR: ${e.code} — ${e.message}`);
    }
    log(`  chunk ${i / CHUNK + 1}: requested=${slice.length} deleted=${got} errors=${errs.length}`);
  }

  log(`\n=== Summary ===`);
  log(`Deleted: ${deleted}/${matches.length}`);
  log(`Errors:  ${errorCount}`);

  writeFileSync(LOG_PATH, lines.join('\n') + '\n');
}

await main();
