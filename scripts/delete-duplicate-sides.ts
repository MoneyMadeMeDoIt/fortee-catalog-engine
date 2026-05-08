/**
 * Delete duplicate per-color side media on a store product (one-shot).
 *
 * Background: pid 168 has 4 colors where the store carries TWO "left side"
 * media instead of one (uploaded ~23h apart by successive fix-store-drift
 * runs whose alt-presence check missed the prior attach). Audit flags as
 * "STORE-DRIFT — Side: expected 2, store has 3".
 *
 * For each (color, side-view) bucket with >1 media, keep the newest by
 * Shopify CDN `?v=<unix>` timestamp and trash the rest.
 *
 * Default mode is dry-run (lists keepers + trash candidates). Pass --apply
 * to mutate. Pass --pid <pid> to target a different product (default: 168).
 *
 * Output log: tmp/dedupe-sides-<pid>.log
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { createShopifyClient } from '../src/shopify/client.js';
import { resolveStoreProduct } from '../src/shopify/resolve-store-product.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

const PRODUCT_MEDIA_QUERY = `
  query productMedia($id: ID!) {
    product(id: $id) {
      id
      handle
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

const PRODUCT_DELETE_MEDIA = `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message code }
    }
  }
`;

interface Args { apply: boolean; pid: string }
function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false, pid: '168' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--pid') a.pid = argv[++i] ?? '168';
  }
  return a;
}

interface MediaRow { id: string; alt: string; url: string; ts: number }

function parseTimestamp(url: string): number {
  const m = url.match(/[?&]v=(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lines: string[] = [];
  const log = (msg: string): void => { logger.info(msg); lines.push(msg); };

  log(`delete-duplicate-sides: pid=${args.pid} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);

  const client = await createShopifyClient('DEST_SHOPIFY_');
  const product = await resolveStoreProduct(client, args.pid);
  log(`resolved: ${product.handle} (${product.id})`);

  const r = (await client.request(PRODUCT_MEDIA_QUERY, {
    variables: { id: product.id },
  })) as { data: { product: { media: { edges: { node: { id?: string; alt?: string; image?: { url?: string } } }[] } } } };

  // Group by (color, view) where view ∈ {left side, right side}
  const buckets = new Map<string, MediaRow[]>();
  for (const e of r.data.product.media.edges) {
    const m = e.node;
    if (!m?.id) continue;
    const alt = (m.alt ?? '').trim();
    const mm = alt.match(/^(.+?)\s+(left side|right side)$/i);
    if (!mm) continue;
    const color = mm[1].trim();
    const view = mm[2].toLowerCase();
    const key = `${color}|${view}`;
    const url = m.image?.url ?? '';
    const ts = parseTimestamp(url);
    const list = buckets.get(key) ?? [];
    list.push({ id: m.id, alt, url, ts });
    buckets.set(key, list);
  }

  // Find dup buckets
  const trashIds: string[] = [];
  log(`\n=== Duplicate buckets ===`);
  for (const [key, rows] of [...buckets.entries()].sort()) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) => b.ts - a.ts); // newest first
    const keep = sorted[0];
    const trash = sorted.slice(1);
    log(`  ${key}  count=${rows.length}`);
    log(`    KEEP  v=${keep.ts}  ${keep.url.split('/').pop()}`);
    for (const t of trash) {
      log(`    TRASH v=${t.ts}  ${t.url.split('/').pop()}`);
      trashIds.push(t.id);
    }
  }

  if (trashIds.length === 0) {
    log(`\nNo duplicates — nothing to do.`);
    writeFileSync(`tmp/dedupe-sides-${args.pid}.log`, lines.join('\n') + '\n');
    return;
  }

  log(`\nTotal trash candidates: ${trashIds.length}`);

  if (!args.apply) {
    log(`[DRY-RUN] Re-run with --apply to execute.`);
    writeFileSync(`tmp/dedupe-sides-${args.pid}.log`, lines.join('\n') + '\n');
    return;
  }

  const resp = (await client.request(PRODUCT_DELETE_MEDIA, {
    variables: { productId: product.id, mediaIds: trashIds },
  })) as { data: { productDeleteMedia: { deletedMediaIds: string[]; mediaUserErrors: { field: string[]; message: string; code: string }[] } } };

  const errs = resp.data.productDeleteMedia.mediaUserErrors ?? [];
  const deleted = resp.data.productDeleteMedia.deletedMediaIds?.length ?? 0;
  for (const e of errs) log(`  ERROR: ${e.code} — ${e.message}`);
  log(`\n=== Summary ===`);
  log(`Deleted: ${deleted}/${trashIds.length}`);
  log(`Errors:  ${errs.length}`);

  writeFileSync(`tmp/dedupe-sides-${args.pid}.log`, lines.join('\n') + '\n');
}

await main();
