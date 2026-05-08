/**
 * Apply BAD-ALT fixes for L01210 + L01250 (one-shot).
 *
 * Resolves each pid via resolveStoreProduct, fetches its media, then
 * for each (mediaId, action) pair below:
 *   - DELETE: productDeleteMedia
 *   - RENAME: productUpdateMedia (alt only)
 *
 * Actions are hardcoded after visual inspection of all 13 BAD-ALT
 * images. See plan 14-03 Task 2 for the rationale per row.
 *
 * Default dry-run; --apply mutates.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { createShopifyClient } from '../src/shopify/client.js';
import { resolveStoreProduct } from '../src/shopify/resolve-store-product.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;
const LOG_PATH = 'tmp/bad-alt-applied.log';

interface Action { pid: string; mediaId: string; op: 'DELETE' | 'RENAME'; newAlt?: string; reason: string }

// Hardcoded after visual inspection of tmp/bad-alt-images/.
// mediaId is the full Shopify gid.
const ACTIONS: Action[] = [
  // L01210 (Reversible Jacket)
  { pid: 'L01210', mediaId: 'gid://shopify/MediaImage/37348514300119', op: 'DELETE',
    reason: 'Black jacket front — duplicate of existing canonical "Black/Hv Yel/Orange front"' },
  { pid: 'L01210', mediaId: 'gid://shopify/MediaImage/37348514332887', op: 'RENAME',
    newAlt: 'Tan/Hv Yel/Orange front',
    reason: 'Tan jacket front — fills missing canonical for Tan/Hv Yel/Orange' },
  { pid: 'L01210', mediaId: 'gid://shopify/MediaImage/37348514365655', op: 'DELETE',
    reason: 'Black jacket back — duplicate of existing canonical "Black/Hv Yel/Orange back"' },
  { pid: 'L01210', mediaId: 'gid://shopify/MediaImage/37348514398423', op: 'RENAME',
    newAlt: 'Tan/Hv Yel/Orange back',
    reason: 'Tan jacket back — fills missing canonical for Tan/Hv Yel/Orange' },

  // L01250 (Parka)
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513349847', op: 'RENAME',
    newAlt: 'Black/Yellow Stripe model front',
    reason: 'Black parka model view — fills Black/Yellow Stripe canonical model alt' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513382615', op: 'RENAME',
    newAlt: 'Black/Yellow Stripe back',
    reason: 'Black parka back — fills Black/Yellow Stripe canonical back alt' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513415383', op: 'RENAME',
    newAlt: 'Black/Yellow Stripe front',
    reason: 'Black parka front — fills Black/Yellow Stripe canonical front alt' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513448151', op: 'DELETE',
    reason: 'Hi-Vis Orange front — duplicate of existing canonical' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513480919', op: 'DELETE',
    reason: 'Hi-Vis Orange back — duplicate of existing canonical' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513513687', op: 'DELETE',
    reason: 'Hi-Vis Yellow front — duplicate of existing canonical' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513546455', op: 'DELETE',
    reason: 'Hi-Vis Yellow back — duplicate of existing canonical' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513579223', op: 'DELETE',
    reason: 'Navy/Yellow Stripe front — duplicate of existing canonical' },
  { pid: 'L01250', mediaId: 'gid://shopify/MediaImage/37348513611991', op: 'DELETE',
    reason: 'Navy/Yellow Stripe back — duplicate of existing canonical' },
];

const PRODUCT_DELETE_MEDIA = `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message code }
    }
  }
`;

const PRODUCT_UPDATE_MEDIA = `
  mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { id alt }
      mediaUserErrors { field message code }
    }
  }
`;

interface Args { apply: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false };
  for (const x of argv) if (x === '--apply') a.apply = true;
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lines: string[] = [];
  const log = (msg: string): void => { logger.info(msg); lines.push(msg); };

  log(`apply-bad-alt-fixes: mode=${args.apply ? 'APPLY' : 'DRY-RUN'}  actions=${ACTIONS.length}`);

  const client = await createShopifyClient('DEST_SHOPIFY_');

  // Resolve productId per pid (group actions per pid).
  const byPid = new Map<string, Action[]>();
  for (const a of ACTIONS) {
    const list = byPid.get(a.pid) ?? [];
    list.push(a);
    byPid.set(a.pid, list);
  }

  let deleted = 0, renamed = 0, errs = 0;

  for (const [pid, actions] of byPid) {
    const product = await resolveStoreProduct(client, pid);
    log(`\n[${pid}] resolved → ${product.handle} (${product.id}) — ${actions.length} actions`);

    const deletes = actions.filter(a => a.op === 'DELETE');
    const renames = actions.filter(a => a.op === 'RENAME');

    // Apply deletes (batched)
    if (deletes.length > 0) {
      const ids = deletes.map(a => a.mediaId);
      log(`  DELETE batch: ${ids.length} media`);
      for (const a of deletes) log(`    - ${a.mediaId}  // ${a.reason}`);
      if (args.apply) {
        try {
          const resp = (await client.request(PRODUCT_DELETE_MEDIA, {
            variables: { productId: product.id, mediaIds: ids },
          })) as { data: { productDeleteMedia: { deletedMediaIds: string[]; mediaUserErrors: { code: string; message: string }[] } } };
          const got = resp.data.productDeleteMedia.deletedMediaIds?.length ?? 0;
          const errors = resp.data.productDeleteMedia.mediaUserErrors ?? [];
          deleted += got;
          for (const e of errors) { log(`    ERR: ${e.code} — ${e.message}`); errs++; }
          log(`  DELETE result: ${got}/${ids.length} deleted`);
        } catch (e) {
          log(`  ERR delete batch: ${e instanceof Error ? e.message : e}`);
          errs += deletes.length;
        }
      }
    }

    // Apply renames (one batch with media list)
    if (renames.length > 0) {
      log(`  RENAME batch: ${renames.length} media`);
      for (const a of renames) log(`    - ${a.mediaId} → "${a.newAlt}"  // ${a.reason}`);
      if (args.apply) {
        try {
          const media = renames.map(a => ({ id: a.mediaId, alt: a.newAlt }));
          const resp = (await client.request(PRODUCT_UPDATE_MEDIA, {
            variables: { productId: product.id, media },
          })) as { data: { productUpdateMedia: { media: { id: string; alt: string }[]; mediaUserErrors: { code: string; message: string }[] } } };
          const got = resp.data.productUpdateMedia.media?.length ?? 0;
          const errors = resp.data.productUpdateMedia.mediaUserErrors ?? [];
          renamed += got;
          for (const e of errors) { log(`    ERR: ${e.code} — ${e.message}`); errs++; }
          log(`  RENAME result: ${got}/${renames.length} updated`);
        } catch (e) {
          log(`  ERR rename batch: ${e instanceof Error ? e.message : e}`);
          errs += renames.length;
        }
      }
    }
  }

  log(`\n=== Summary ===`);
  log(`Mode:      ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  log(`Deleted:   ${args.apply ? deleted : ACTIONS.filter(a => a.op === 'DELETE').length} (intended ${ACTIONS.filter(a => a.op === 'DELETE').length})`);
  log(`Renamed:   ${args.apply ? renamed : ACTIONS.filter(a => a.op === 'RENAME').length} (intended ${ACTIONS.filter(a => a.op === 'RENAME').length})`);
  log(`Errors:    ${errs}`);

  writeFileSync(LOG_PATH, lines.join('\n') + '\n');
}

await main();
