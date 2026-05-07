/**
 * Backfill missing per-color media on dest store products.
 *
 * The audit (tmp/imagery-audit.tsv) flags STORE-DRIFT for any (pid, color,
 * view) combo where BR has all 3 images (so the color was pushable) but the
 * store is missing one or more views. Causes:
 *   - color was added to BR after the original push
 *   - earlier push aborted mid-product
 *   - prior cleanup deleted media that wasn't re-attached
 *
 * For each affected pid, this script re-reads the store product (fresh, not
 * from audit cache) and for each color where BR has front/back/side, ensures
 * the store has:
 *   <color> front     ← BR.FrontImage
 *   <color> back      ← BR.BackImage
 *   <color> left side ← buildSidePair(BR.DirectSideImage).leftSideUrl
 *   <color> right side ← buildSidePair(BR.DirectSideImage).rightSideUrl
 * Already-present media are left alone — only missing ones are attached.
 *
 * Flags:
 *   --dry-run         no Shopify writes (still calls Drive for buildSidePair)
 *   --pids a,b,c      restrict to these productIds
 *   --limit N         stop after N pids
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createSheetsClient } from '../src/sheets/client.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { buildSidePair } from '../src/lib/side-pair-builder.js';
import { logger } from '../src/lib/logger.js';

type ShopifyClient = Awaited<ReturnType<typeof createShopifyClient>>;
const MAIN_ID = '1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs';
const READY_TAB = 'Bestsellers-Ready';
const AUDIT_TSV = 'tmp/imagery-audit.tsv';

interface Args { dryRun: boolean; pids: string[] | null; limit: number }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, pids: null, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--pids') a.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (x === '--limit') a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

function safeColor(name: string): string { return name.replace(/[^a-z0-9-]+/gi, '_'); }

const STORE_QUERY = `
  query($after: String) {
    products(first: 25, after: $after) {
      edges { node { id handle media(first: 250) { edges { node { ... on MediaImage { id alt image { url } } } } } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const PRODUCT_CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id alt }
      mediaUserErrors { field message code }
    }
  }
`;

interface StoreProd { id: string; handle: string; mediaByAlt: Map<string, number> }
async function fetchStore(client: ShopifyClient, pidByLower: Map<string, string>, pidsWanted: Set<string>): Promise<Map<string, StoreProd>> {
  const out = new Map<string, StoreProd>();
  let after: string | null = null;
  for (let p = 0; p < 60; p++) {
    const r = (await client.request(STORE_QUERY, { variables: { after } })) as any;
    for (const e of r.data.products.edges) {
      const node = e.node;
      const segs = node.handle.split('-');
      let pid: string | null = null;
      for (let i = segs.length - 1; i >= 0; i--) {
        const cand = pidByLower.get(segs[i].toLowerCase());
        if (cand) { pid = cand; break; }
      }
      if (!pid || !pidsWanted.has(pid)) continue;
      const mediaByAlt = new Map<string, number>();
      for (const me of node.media.edges) {
        const alt = (me.node?.alt ?? '').trim().toLowerCase();
        if (alt) mediaByAlt.set(alt, (mediaByAlt.get(alt) ?? 0) + 1);
      }
      out.set(pid, { id: node.id, handle: node.handle, mediaByAlt });
    }
    if (!r.data.products.pageInfo.hasNextPage) break;
    after = r.data.products.pageInfo.endCursor;
  }
  return out;
}

async function attach(client: ShopifyClient, productId: string, src: string, alt: string): Promise<string | null> {
  try {
    const r = (await client.request(PRODUCT_CREATE_MEDIA, {
      variables: { productId, media: [{ originalSource: src, alt, mediaContentType: 'IMAGE' }] },
    })) as { data?: { productCreateMedia?: { mediaUserErrors?: { field: string[]; message: string }[] } } };
    const errs = r.data?.productCreateMedia?.mediaUserErrors ?? [];
    if (errs.length > 0) return errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ');
    return null;
  } catch (e) {
    return `request failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`fix-store-drift: ${JSON.stringify({ ...args, pids: args.pids?.length })}`);

  // 1. Get pids with STORE-DRIFT in audit
  const auditLines = readFileSync(AUDIT_TSV, 'utf-8').trim().split('\n').slice(1);
  const driftPids = new Set<string>();
  for (const l of auditLines) {
    const c = l.split('\t');
    if (c[2] === 'STORE-DRIFT') driftPids.add(c[0]);
  }
  if (args.pids) {
    for (const p of [...driftPids]) if (!args.pids.includes(p)) driftPids.delete(p);
  }
  let pidsToFix = [...driftPids];
  if (Number.isFinite(args.limit)) pidsToFix = pidsToFix.slice(0, args.limit);
  logger.info(`Pids with STORE-DRIFT: ${pidsToFix.length}`);

  // 2. Read BR per (pid, color) → Front/Back/Side URLs and supplier/styleId
  const sheets = createSheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: MAIN_ID, range: `'${READY_TAB}'` });
  const rows = (r.data.values ?? []) as string[][];
  const h: Record<string, number> = {};
  rows[0].forEach((x, i) => { h[x] = i; });
  interface BrPid { supplier: string; styleId: string; variants: Map<string, { Front: string; Back: string; Side: string }> }
  const brByPid = new Map<string, BrPid>();
  for (let i = 1; i < rows.length; i++) {
    const pid = String(rows[i][h['productId']] ?? '').trim();
    if (!pid) continue;
    const supplier = String(rows[i][h['supplierCode']] ?? '').trim();
    const styleId = String(rows[i][h['styleID']] ?? '').trim() || pid;
    if (!brByPid.has(pid)) brByPid.set(pid, { supplier, styleId, variants: new Map() });
    const e = brByPid.get(pid)!;
    if (supplier && !e.supplier) e.supplier = supplier;
    if (styleId && !e.styleId) e.styleId = styleId;
    const color = String(rows[i][h['colorName']] ?? '').trim();
    if (!color) continue;
    if (e.variants.has(color)) continue;
    const f = String(rows[i][h['FrontImage']] ?? '').trim();
    const b = String(rows[i][h['BackImage']] ?? '').trim();
    const s = String(rows[i][h['DirectSideImage']] ?? '').trim();
    if (f && b && s) e.variants.set(color, { Front: f, Back: b, Side: s });
  }

  // 3. Fetch store products fresh
  const pidByLower = new Map<string, string>();
  for (const p of brByPid.keys()) pidByLower.set(p.toLowerCase(), p);
  const client = await createShopifyClient('DEST_SHOPIFY_');
  const wantSet = new Set(pidsToFix);
  logger.info(`Fetching store products for ${wantSet.size} pids…`);
  const storeByPid = await fetchStore(client, pidByLower, wantSet);
  logger.info(`Matched ${storeByPid.size}/${wantSet.size} store products`);

  // 4. Per-pid backfill
  let totalAttached = 0, totalSkipped = 0, totalErrs = 0, processed = 0, totalCapHit = 0;
  // Shopify hard limit per product. We can't push more than this many media,
  // even if the variant list demands more. Track current count and bail
  // gracefully when we'd exceed it.
  const SHOPIFY_MEDIA_LIMIT = 250;
  for (const pid of pidsToFix) {
    const br = brByPid.get(pid);
    const sp = storeByPid.get(pid);
    if (!br || !sp) { processed++; continue; }
    let perPidAttached = 0;
    let mediaCount = [...sp.mediaByAlt.values()].reduce((s, n) => s + n, 0);
    if (mediaCount >= SHOPIFY_MEDIA_LIMIT) {
      logger.warn(`[${sp.handle}] already at Shopify media cap (${mediaCount}/${SHOPIFY_MEDIA_LIMIT}) — skipping. Product has more BR variants than Shopify can hold.`);
      totalCapHit++;
      processed++;
      continue;
    }
    for (const [color, urls] of br.variants) {
      const have = (alt: string) => (sp.mediaByAlt.get(alt.toLowerCase()) ?? 0) > 0;
      const wantFront = `${color} front`;
      const wantBack = `${color} back`;
      const wantLeft = `${color} left side`;
      const wantRight = `${color} right side`;
      const needs: { url: string; alt: string }[] = [];
      if (!have(wantFront)) needs.push({ url: urls.Front, alt: wantFront });
      if (!have(wantBack)) needs.push({ url: urls.Back, alt: wantBack });

      // Side handling: build the pair only if at least one of left/right is missing
      const needLeft = !have(wantLeft);
      const needRight = !have(wantRight);
      if (needLeft || needRight) {
        let leftUrl = urls.Side, rightUrl = urls.Side;
        try {
          const pair = await buildSidePair(urls.Side, br.supplier, br.styleId, safeColor(color));
          if (pair) { leftUrl = pair.leftSideUrl; rightUrl = pair.rightSideUrl; }
        } catch (e) {
          logger.warn(`[${pid}/${color}] buildSidePair failed: ${e instanceof Error ? e.message : e}`);
        }
        if (needLeft) needs.push({ url: leftUrl, alt: wantLeft });
        if (needRight) needs.push({ url: rightUrl, alt: wantRight });
      }

      if (needs.length === 0) { totalSkipped++; continue; }
      for (const n of needs) {
        if (mediaCount >= SHOPIFY_MEDIA_LIMIT) {
          logger.warn(`[${sp.handle}] hit Shopify media cap mid-fill (${mediaCount}). Stopping for this pid.`);
          totalCapHit++;
          break;
        }
        if (args.dryRun) {
          logger.info(`[${sp.handle}/${color}] DRY would attach "${n.alt}"`);
          perPidAttached++; mediaCount++; continue;
        }
        const err = await attach(client, sp.id, n.url, n.alt);
        if (err) {
          totalErrs++;
          logger.error(`[${sp.handle}/${color}] attach "${n.alt}" failed: ${err}`);
          // Stop the pid if we hit the cap mid-run
          if (/Limit of \d+ media/i.test(err)) { mediaCount = SHOPIFY_MEDIA_LIMIT; }
        } else {
          totalAttached++; perPidAttached++; mediaCount++;
        }
      }
      if (mediaCount >= SHOPIFY_MEDIA_LIMIT) break;
    }
    processed++;
    if (perPidAttached > 0) logger.info(`[${sp.handle}] ${args.dryRun ? 'WOULD attach' : 'attached'} ${perPidAttached} media`);
    if (processed % 10 === 0) logger.info(`Progress: ${processed}/${pidsToFix.length}, attached=${totalAttached}`);
  }

  logger.info(`\n=== Summary ===`);
  logger.info(`Pids processed:    ${processed}`);
  logger.info(`Media attached:    ${args.dryRun ? '(dry) ' + totalAttached : totalAttached}`);
  logger.info(`(color, view) skipped (already had): ${totalSkipped}`);
  logger.info(`Pids hit 250-media cap: ${totalCapHit}`);
  logger.info(`Errors:            ${totalErrs}`);
}

await main();
