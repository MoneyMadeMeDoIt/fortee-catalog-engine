/**
 * Resolve a single Shopify store product from a productId (pid).
 *
 * Background: tonight's `first: 1` lookup against `handle:*5000*` silently
 * picked a stale orphan duplicate (`t-shirt-gildan-5000`) instead of the
 * live `unisex-heavy-cotton-t-shirt-5000`, causing 15 colors to be dropped
 * from BR while the real store product kept them — leaving 15 store-only
 * orphan colors. This helper enforces fail-loudly semantics so silent-pick
 * cannot recur.
 *
 * Algorithm:
 *   1. `products(first: 50, query: "handle:*${pid}*")`
 *   2. Filter to handles whose last hyphen-separated segment === pid
 *      (case-insensitive). Caps the surface to "real" pid-suffixed handles
 *      and drops accidental substring matches.
 *   3. 0 surviving matches  → throw NoStoreProductError
 *   4. >1 surviving matches → throw MultipleStoreProductsError(pid, list)
 *   5. exactly 1            → log + return { id, handle, title }
 *
 * Caller may override the wildcard pattern via `options.queryPattern`
 * (advanced; defaults to `handle:*${pid}*`).
 */
import type { createShopifyClient } from './client.js';
import { logger } from '../lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;

export interface ResolvedStoreProduct {
  id: string;
  handle: string;
  title: string;
}

export interface ResolveStoreProductOptions {
  /** Override the default `handle:*${pid}*` pattern. Use sparingly. */
  queryPattern?: string;
  /** GraphQL `products` page size (default 50). */
  pageSize?: number;
}

export class NoStoreProductError extends Error {
  readonly pid: string;
  constructor(pid: string) {
    super(`No store product found for pid="${pid}" (queried handle:*${pid}*).`);
    this.name = 'NoStoreProductError';
    this.pid = pid;
  }
}

export class MultipleStoreProductsError extends Error {
  readonly pid: string;
  readonly matches: ResolvedStoreProduct[];
  constructor(pid: string, matches: ResolvedStoreProduct[]) {
    const listing = matches.map(m => `  - ${m.handle} (${m.id})`).join('\n');
    super(
      `Multiple store products matched pid="${pid}" (${matches.length} total):\n${listing}\n` +
      `Refusing to silent-pick. Resolve the duplicate manually before retrying.`,
    );
    this.name = 'MultipleStoreProductsError';
    this.pid = pid;
    this.matches = matches;
  }
}

const RESOLVE_QUERY = `
  query resolveStoreProduct($q: String!, $first: Int!) {
    products(first: $first, query: $q) {
      edges { node { id handle title } }
    }
  }
`;

/**
 * Resolve a pid to exactly one store product. Throws on 0 or >1 matches.
 *
 * @param client  Shopify Admin API client (typically `createShopifyClient('DEST_SHOPIFY_')`).
 * @param pid     Product id to resolve (e.g. "5000", "L01210", "168").
 * @param options Optional overrides; rarely needed.
 * @returns       `{ id, handle, title }` for the single matching product.
 *
 * @throws {NoStoreProductError}      when 0 surviving matches.
 * @throws {MultipleStoreProductsError} when >1 surviving matches.
 */
export async function resolveStoreProduct(
  client: ShopifyClient,
  pid: string,
  options: ResolveStoreProductOptions = {},
): Promise<ResolvedStoreProduct> {
  const queryPattern = options.queryPattern ?? `handle:*${pid}*`;
  const pageSize = options.pageSize ?? 50;
  const pidLower = pid.toLowerCase();

  const r = (await client.request(RESOLVE_QUERY, {
    variables: { q: queryPattern, first: pageSize },
  })) as { data: { products: { edges: { node: ResolvedStoreProduct }[] } } };

  const allMatches: ResolvedStoreProduct[] = r.data.products.edges.map(e => e.node);

  // Filter: keep only handles where the last hyphen-segment === pid (case-insensitive).
  // This drops accidental substring hits (e.g. searching "168" wouldn't match
  // "richardson-trucker-1683").
  const filtered = allMatches.filter(m => {
    const segs = m.handle.split('-');
    return segs.length > 0 && segs[segs.length - 1].toLowerCase() === pidLower;
  });

  logger.info(
    `[resolve] pid=${pid} query="${queryPattern}" raw=${allMatches.length} surviving=${filtered.length}`,
  );

  if (filtered.length === 0) {
    throw new NoStoreProductError(pid);
  }
  if (filtered.length > 1) {
    throw new MultipleStoreProductsError(pid, filtered);
  }

  const winner = filtered[0];
  logger.info(`[resolve] pid=${pid} → handle=${winner.handle} id=${winner.id}`);
  return winner;
}
