import sharp from 'sharp';
import { logger } from '../lib/logger.js';
import { STAGED_UPLOADS_CREATE } from './mutations.js';
import type { FileSetInput, CategoryGroup, GarmentBounds, PrintAreaCoords } from './types.js';

/** Client interface matching the Shopify Admin API client pattern. */
export interface ShopifyClient {
  request: (
    query: string,
    options: { variables: Record<string, unknown> }
  ) => Promise<unknown>;
}

/** Reference garment-to-canvas ratios measured from reference images (S05280 tops, L00550 hoodies). */
export const REFERENCE_RATIOS = {
  tops: { targetHeightFrac: 0.73, topOffsetFrac: 0.06 },
  hoodies: { targetHeightFrac: 0.78, topOffsetFrac: 0.05 },
} as const;

/** Print area fractions relative to garment bounding box (not canvas). */
export const GARMENT_RELATIVE_PRINT_FRACTIONS = {
  tops: {
    'Front Print': { xFrac: 0.15, yFrac: 0.10, wFrac: 0.70, hFrac: 0.55 },
    'Back Print':  { xFrac: 0.13, yFrac: 0.10, wFrac: 0.74, hFrac: 0.53 },
  },
  hoodies: {
    'Front Print': { xFrac: 0.20, yFrac: 0.28, wFrac: 0.60, hFrac: 0.40 },
    'Back Print':  { xFrac: 0.18, yFrac: 0.35, wFrac: 0.64, hFrac: 0.43 },
  },
} as const;

/**
 * Detect the bounding box of a garment on a white background image.
 * Uses sharp's trim() to find non-white pixels.
 * Falls back to full image dimensions if trim removes more than 70% of the image.
 */
export async function detectGarmentBounds(imageBuffer: Buffer): Promise<GarmentBounds> {
  const meta = await sharp(imageBuffer).metadata();
  const originalWidth = meta.width ?? 0;
  const originalHeight = meta.height ?? 0;

  try {
    const { info } = await sharp(imageBuffer)
      .trim({ background: '#ffffff', threshold: 10 })
      .toBuffer({ resolveWithObject: true });

    const trimmedWidth = info.width;
    const trimmedHeight = info.height;

    // Safety check: if trim removed >70% of the image, something went wrong — fall back
    if (trimmedWidth < originalWidth * 0.3 || trimmedHeight < originalHeight * 0.3) {
      logger.warn(
        `Trim removed >70% of image (${trimmedWidth}x${trimmedHeight} from ${originalWidth}x${originalHeight}), using full bounds`
      );
      return {
        offsetLeft: 0,
        offsetTop: 0,
        width: originalWidth,
        height: originalHeight,
        originalWidth,
        originalHeight,
      };
    }

    // sharp trim offsets can be negative per issue #4085 — use Math.abs()
    const offsetLeft = Math.abs(info.trimOffsetLeft ?? 0);
    const offsetTop = Math.abs(info.trimOffsetTop ?? 0);

    return {
      offsetLeft,
      offsetTop,
      width: trimmedWidth,
      height: trimmedHeight,
      originalWidth,
      originalHeight,
    };
  } catch {
    logger.warn(`Trim failed for image, using full bounds`);
    return {
      offsetLeft: 0,
      offsetTop: 0,
      width: originalWidth,
      height: originalHeight,
      originalWidth,
      originalHeight,
    };
  }
}

/**
 * Place a garment image on a white canvas at a specified position and scale.
 * The garment is scaled to targetHeightPx while preserving aspect ratio,
 * then centered horizontally at the given top offset.
 */
export async function placeGarmentOnCanvas(
  garmentBuffer: Buffer,
  targetHeightPx: number,
  targetTopOffsetPx: number,
  canvasSize = 2000,
): Promise<Buffer> {
  const meta = await sharp(garmentBuffer).metadata();
  const garmentWidth = meta.width ?? 1;
  const garmentHeight = meta.height ?? 1;
  const aspectRatio = garmentWidth / garmentHeight;

  const scaledWidth = Math.round(targetHeightPx * aspectRatio);
  const leftOffset = Math.round((canvasSize - scaledWidth) / 2);

  const resized = await sharp(garmentBuffer)
    .resize(scaledWidth, targetHeightPx, { fit: 'fill' })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: resized, left: leftOffset, top: targetTopOffsetPx }])
    .png()
    .toBuffer();
}

/**
 * Convert garment pixel placement on a 2000x2000 canvas to percentage-based print area coords.
 * Each print area is positioned relative to the garment bounding box using category-specific fractions.
 */
export function derivePrintAreaCoords(
  garmentLeftPx: number,
  garmentTopPx: number,
  garmentWidthPx: number,
  garmentHeightPx: number,
  categoryGroup: CategoryGroup,
  canvasSize = 2000,
): PrintAreaCoords {
  const fractions = GARMENT_RELATIVE_PRINT_FRACTIONS[categoryGroup];
  const result: PrintAreaCoords = {};

  for (const [areaName, frac] of Object.entries(fractions) as Array<[string, { xFrac: number; yFrac: number; wFrac: number; hFrac: number }]>) {
    const pixelX = garmentLeftPx + frac.xFrac * garmentWidthPx;
    const pixelY = garmentTopPx + frac.yFrac * garmentHeightPx;
    const pixelW = frac.wFrac * garmentWidthPx;
    const pixelH = frac.hFrac * garmentHeightPx;

    result[areaName] = {
      x: ((pixelX / canvasSize) * 100).toFixed(2),
      y: ((pixelY / canvasSize) * 100).toFixed(2),
      width: ((pixelW / canvasSize) * 100).toFixed(2),
      height: ((pixelH / canvasSize) * 100).toFixed(2),
    };
  }

  return result;
}

/**
 * Standardize a garment image to a 2000x2000 canvas using the trim-place-composite pipeline.
 * Detects the garment bounds via trim, then places the garment at the reference ratio for the category.
 * Returns the processed buffer and the garment's final placement on the canvas.
 *
 * Falls back to fit:contain behavior with a warning if trim fails or removes too much.
 */
export async function standardizeImage(
  imageBuffer: Buffer,
  categoryGroup: CategoryGroup = 'tops',
  canvasSize = 2000,
): Promise<{ buffer: Buffer; garmentPlacement: { left: number; top: number; width: number; height: number } }> {
  try {
    const bounds = await detectGarmentBounds(imageBuffer);

    // Extract the trimmed garment from the source image
    const garmentBuffer = await sharp(imageBuffer)
      .extract({
        left: bounds.offsetLeft,
        top: bounds.offsetTop,
        width: bounds.width,
        height: bounds.height,
      })
      .png()
      .toBuffer();

    const ratios = REFERENCE_RATIOS[categoryGroup];
    const targetHeightPx = Math.round(canvasSize * ratios.targetHeightFrac);
    const targetTopOffsetPx = Math.round(canvasSize * ratios.topOffsetFrac);

    const garmentAspect = bounds.width / bounds.height;
    const scaledWidth = Math.round(targetHeightPx * garmentAspect);
    const leftOffset = Math.round((canvasSize - scaledWidth) / 2);

    const buffer = await placeGarmentOnCanvas(garmentBuffer, targetHeightPx, targetTopOffsetPx, canvasSize);

    return {
      buffer,
      garmentPlacement: {
        left: leftOffset,
        top: targetTopOffsetPx,
        width: scaledWidth,
        height: targetHeightPx,
      },
    };
  } catch (err) {
    logger.warn(
      `standardizeImage trim-place pipeline failed, falling back to fit:contain: ${(err as Error).message}`
    );
    const buffer = await sharp(imageBuffer)
      .resize(canvasSize, canvasSize, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png()
      .toBuffer();

    return {
      buffer,
      garmentPlacement: { left: 0, top: 0, width: canvasSize, height: canvasSize },
    };
  }
}

/**
 * Download an image from a URL with a 30-second timeout.
 * Throws a descriptive error on non-OK responses.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download image from ${url}: HTTP ${response.status} ${response.statusText}`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Upload an image buffer via Shopify staged uploads.
 *
 * 1. Calls stagedUploadsCreate to get an upload target
 * 2. PUTs the buffer to the target URL
 * 3. Returns the resourceUrl for use in productSet files
 */
export async function uploadStagedImage(
  client: ShopifyClient,
  buffer: Buffer,
  filename: string
): Promise<string> {
  const result = (await client.request(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          resource: 'IMAGE',
          filename,
          mimeType: 'image/png',
          fileSize: String(buffer.length),
          httpMethod: 'PUT',
        },
      ],
    },
  })) as {
    data?: {
      stagedUploadsCreate?: {
        stagedTargets?: Array<{
          url: string;
          resourceUrl: string;
          parameters: Array<{ name: string; value: string }>;
        }>;
        userErrors?: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const payload = result.data?.stagedUploadsCreate;
  if (!payload) {
    throw new Error(`Staged upload mutation returned no data for ${filename}`);
  }

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Staged upload errors for ${filename}: ${userErrors.map((e) => e.message).join(', ')}`
    );
  }

  const target = payload.stagedTargets?.[0];
  if (!target) {
    throw new Error(`No staged target returned for ${filename}`);
  }

  const putResponse = await fetch(target.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: buffer,
  });

  if (!putResponse.ok) {
    throw new Error(
      `Failed to PUT image to staged URL for ${filename}: HTTP ${putResponse.status}`
    );
  }

  return target.resourceUrl;
}

/**
 * Download, standardize, and upload all product images.
 * Failed individual images are skipped with a warning.
 *
 * NOTE: categoryGroup will be wired in Plan 02. Defaults to 'tops' as a transitional measure.
 */
export async function processProductImages(
  client: ShopifyClient,
  imageUrls: { front?: string; back?: string; side?: string },
  productName: string,
  colorName: string,
  categoryGroup: CategoryGroup = 'tops',
): Promise<FileSetInput[]> {
  const entries: Array<{
    key: 'front' | 'back' | 'side';
    url: string;
    alt: string;
  }> = [];

  if (imageUrls.front) {
    entries.push({ key: 'front', url: imageUrls.front, alt: 'Front Print' });
  }
  if (imageUrls.back) {
    entries.push({ key: 'back', url: imageUrls.back, alt: 'Back Print' });
  }
  if (imageUrls.side) {
    entries.push({
      key: 'side',
      url: imageUrls.side,
      alt: `${productName} - ${colorName} Side`,
    });
  }

  const files: FileSetInput[] = [];

  for (const entry of entries) {
    try {
      const raw = await downloadImage(entry.url);
      const { buffer: standardized } = await standardizeImage(raw, categoryGroup);
      const filename = `${productName}-${colorName}-${entry.key}.png`
        .replace(/\s+/g, '-')
        .toLowerCase();
      const resourceUrl = await uploadStagedImage(client, standardized, filename);

      files.push({
        originalSource: resourceUrl,
        alt: entry.alt,
        contentType: 'IMAGE',
      });
    } catch (err) {
      logger.warn(
        `Skipping ${entry.key} image for ${productName} ${colorName}: ${(err as Error).message}`
      );
    }
  }

  return files;
}
