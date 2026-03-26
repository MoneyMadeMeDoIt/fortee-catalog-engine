import * as cheerio from 'cheerio';
import { downloadImage } from '../shopify/image-standardizer.js';
import { scoreImageQuality } from '../shopify/image-scorer.js';
import { createOneSourceClient, parseMediaContentFromXml } from './onesource-client.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ImageView = 'front' | 'back' | 'side';

export interface SourcedView {
  url: string;
  score: number;
  verdict: 'pass' | 'fail';
}

export interface SourcedImages {
  front: SourcedView | null;
  back: SourcedView | null;
  side: SourcedView | null;
}

// ---------------------------------------------------------------------------
// OMG OneSource classType view mapping (PromoStandards Media Service 1.1.0)
// ---------------------------------------------------------------------------

const VIEW_CLASS_TYPES: Record<number, ImageView> = {
  1007: 'front',  // Front
  1006: 'front',  // Primary (fallback front)
  1001: 'front',  // Blank garment (fallback front)
  1008: 'back',   // Rear
  1009: 'side',   // Right side
  1010: 'side',   // Left side
};

// Priority order for front view: 1007 > 1006 > 1001
const FRONT_PRIORITY: Record<number, number> = {
  1007: 3,
  1006: 2,
  1001: 1,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function scoreUrl(url: string): Promise<SourcedView> {
  const buffer = await downloadImage(url);
  const result = await scoreImageQuality(buffer);
  return { url, score: result.score, verdict: result.verdict };
}

/**
 * Pick the highest-scoring candidate from a list.
 * Returns null for empty arrays.
 * Per D-03: does NOT filter by verdict — returns best even if all fail.
 */
export function pickBest(views: SourcedView[]): SourcedView | null {
  if (views.length === 0) return null;
  return views.reduce((a, b) => (b.score > a.score ? b : a));
}

// ---------------------------------------------------------------------------
// Per-supplier fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch images from OMG OneSource (via CSW supplier code).
 * classType IDs identify front/back/side views.
 */
async function fetchOMGImages(
  styleId: string,
  colorName?: string,
): Promise<Partial<Record<ImageView, SourcedView>>> {
  try {
    const client = createOneSourceClient({
      keyId: process.env.ONESOURCE_KEY_ID ?? '',
      keyPassword: process.env.ONESOURCE_KEY_PASSWORD ?? '',
      supplierCode: process.env.CSW_SUPPLIER_CODE ?? 'CANADASPORTSWEAR',
    });

    const $ = await client.getMediaContent(styleId);
    const mediaItems = parseMediaContentFromXml($);

    // Track best candidate per view: { view -> { scored: SourcedView, priority: number } }
    const candidates: Partial<Record<ImageView, { scored: SourcedView; priority: number }>> = {};

    for (const item of mediaItems) {
      if (!item.url) continue;
      if (item.classTypes.length === 0) continue;

      // When colorName provided, skip items that don't match (case-insensitive)
      if (colorName && item.color) {
        if (item.color.toLowerCase() !== colorName.toLowerCase()) continue;
      }

      // Find the highest-priority classTypeId in this item's classTypes
      let bestView: ImageView | null = null;
      let bestPriority = -1;

      for (const ct of item.classTypes) {
        const view = VIEW_CLASS_TYPES[ct.id];
        if (!view) continue;

        const priority = view === 'front' ? (FRONT_PRIORITY[ct.id] ?? 0) : 1;
        if (priority > bestPriority) {
          bestView = view;
          bestPriority = priority;
        }
      }

      if (!bestView) continue;

      // Only update if this item has higher priority than the current candidate
      const existing = candidates[bestView];
      if (!existing || bestPriority > existing.priority) {
        try {
          const scored = await scoreUrl(item.url);
          candidates[bestView] = { scored, priority: bestPriority };
        } catch (err) {
          logger.warn(`fetchOMGImages: failed to score URL ${item.url}: ${err}`);
        }
      }
    }

    const result: Partial<Record<ImageView, SourcedView>> = {};
    for (const [view, candidate] of Object.entries(candidates)) {
      if (candidate) {
        result[view as ImageView] = candidate.scored;
      }
    }
    return result;
  } catch (err) {
    logger.warn(`fetchOMGImages: failed for styleId ${styleId}: ${err}`);
    return {};
  }
}

/**
 * Fetch images from Canada Sportswear storefront.
 * CSW is confirmed front-only — no back or side images exist.
 */
async function fetchCSWImages(
  styleId: string,
): Promise<Partial<Record<ImageView, SourcedView>>> {
  try {
    const searchUrl = `https://canadasportswear.com/search?type=product&q=${encodeURIComponent(styleId)}`;
    const searchResponse = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductEnrichBot/1.0)' },
    });

    if (!searchResponse.ok) return {};

    const html = await searchResponse.text();
    const $ = cheerio.load(html);

    // Extract first product link from search results
    const productLink = $('a[href*="/products/"]').first().attr('href');
    if (!productLink) return {};

    // Normalize product URL
    const productBase = productLink.startsWith('http')
      ? productLink.replace(/\?.*$/, '')
      : `https://canadasportswear.com${productLink.replace(/\?.*$/, '')}`;

    const jsonResponse = await fetch(`${productBase}.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProductEnrichBot/1.0)' },
    });

    if (!jsonResponse.ok) return {};

    const data = await jsonResponse.json() as {
      product?: { images?: Array<{ src: string }> };
    };

    const firstImageSrc = data?.product?.images?.[0]?.src;
    if (!firstImageSrc) return {};

    const scored = await scoreUrl(firstImageSrc);
    return { front: scored };
  } catch (err) {
    logger.warn(`fetchCSWImages: failed for styleId ${styleId}: ${err}`);
    return {};
  }
}

/**
 * Fetch images from S&S Canada REST API.
 * Requires SS_ACCOUNT_NUMBER and SS_API_KEY env vars.
 * Returns {} gracefully when credentials are absent.
 */
async function fetchSSCanadaImages(
  styleId: string,
): Promise<Partial<Record<ImageView, SourcedView>>> {
  const accountNumber = process.env.SS_ACCOUNT_NUMBER;
  const apiKey = process.env.SS_API_KEY;

  if (!accountNumber || !apiKey) {
    logger.warn('S&S Canada REST credentials not set (SS_ACCOUNT_NUMBER, SS_API_KEY) — skipping');
    return {};
  }

  try {
    const url = `https://api.ssactivewear.com/v2/products/?styleid=${encodeURIComponent(styleId)}&fields=colorFrontImage,colorBackImage,colorSideImage`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountNumber}:${apiKey}`).toString('base64')}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn(`fetchSSCanadaImages: HTTP ${response.status} for styleId ${styleId}`);
      return {};
    }

    const products = await response.json() as Array<{
      colorFrontImage?: string;
      colorBackImage?: string;
      colorSideImage?: string;
    }>;

    const first = products[0];
    if (!first) return {};

    const SS_BASE = 'https://www.ssactivewear.com/';
    const result: Partial<Record<ImageView, SourcedView>> = {};

    const makeLargeUrl = (relativePath: string) =>
      SS_BASE + relativePath.replace('_fm', '_fl');

    if (first.colorFrontImage) {
      result.front = await scoreUrl(makeLargeUrl(first.colorFrontImage));
    }
    if (first.colorBackImage) {
      result.back = await scoreUrl(makeLargeUrl(first.colorBackImage));
    }
    if (first.colorSideImage) {
      result.side = await scoreUrl(makeLargeUrl(first.colorSideImage));
    }

    return result;
  } catch (err) {
    logger.warn(`fetchSSCanadaImages: failed for styleId ${styleId}: ${err}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Source front/back/side images for a product style from all three suppliers in parallel.
 * Returns the highest-scoring candidate per view.
 * Per D-03: failed-quality images are returned (not discarded) so Phase 10 can enhance them.
 * Per D-05: no caching — re-fetches each time.
 * Per D-06: views with no candidates return null.
 */
export async function sourceImages(
  styleId: string,
  colorName?: string,
): Promise<SourcedImages> {
  const [omgResult, cswResult, ssResult] = await Promise.allSettled([
    fetchOMGImages(styleId, colorName),
    fetchCSWImages(styleId),
    fetchSSCanadaImages(styleId),
  ]);

  const candidates: { front: SourcedView[]; back: SourcedView[]; side: SourcedView[] } = {
    front: [],
    back: [],
    side: [],
  };

  for (const result of [omgResult, cswResult, ssResult]) {
    if (result.status === 'fulfilled') {
      for (const [view, sourced] of Object.entries(result.value)) {
        if (sourced) {
          candidates[view as keyof typeof candidates].push(sourced);
        }
      }
    } else {
      logger.warn(`sourceImages: supplier fetch rejected: ${result.reason}`);
    }
  }

  return {
    front: pickBest(candidates.front),
    back: pickBest(candidates.back),
    side: pickBest(candidates.side),
  };
}
