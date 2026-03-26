import sharp from 'sharp';
import { logger } from '../lib/logger.js';
import { STAGED_UPLOADS_CREATE } from './mutations.js';
import type { FileSetInput, CategoryGroup, GarmentBounds, PrintAreaCoords, ImageProcessResult } from './types.js';
import type { sheets_v4 } from 'googleapis';
import type { EnrichmentUpdate } from '../sheets/types.js';
import { writeUpdates } from '../sheets/writer.js';

/** Client interface matching the Shopify Admin API client pattern. */
export interface ShopifyClient {
  request: (
    query: string,
    options: { variables: Record<string, unknown> }
  ) => Promise<unknown>;
}

/** Fixed garment height as fraction of canvas size. All garments use this (D-01). */
export const FIXED_GARMENT_HEIGHT_FRAC = 0.85;    // 1700px on 2000px canvas

/** Fixed top offset fraction — centers remaining whitespace equally top and bottom. */
export const FIXED_TOP_OFFSET_FRAC = 0.075;       // 150px top, 150px bottom on 2000px canvas

/** @deprecated Use FIXED_GARMENT_HEIGHT_FRAC instead. Kept for image-scorer.ts backward compatibility. */
export const REFERENCE_RATIOS = {
  tops: { targetHeightFrac: 0.73, topOffsetFrac: 0.06 },
  hoodies: { targetHeightFrac: 0.78, topOffsetFrac: 0.05 },
} as const;

/** Print area fractions relative to garment bounding box (not canvas).
 * Derived from known-good canvas coordinates on reference images (S05280 tops, L00550 hoodies).
 * Note: garment width includes sleeves, so wFrac is relative to full garment width.
 */
export const GARMENT_RELATIVE_PRINT_FRACTIONS = {
  tops: {
    'Front Print': { xFrac: 0.239, yFrac: 0.178, wFrac: 0.506, hFrac: 0.630 },
    'Back Print':  { xFrac: 0.224, yFrac: 0.178, wFrac: 0.537, hFrac: 0.603 },
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

    const targetHeightPx = Math.round(canvasSize * FIXED_GARMENT_HEIGHT_FRAC);
    const targetTopOffsetPx = Math.round(canvasSize * FIXED_TOP_OFFSET_FRAC);

    if (targetTopOffsetPx + targetHeightPx > canvasSize) {
      throw new Error(`Garment overflow: top(${targetTopOffsetPx}) + height(${targetHeightPx}) > canvas(${canvasSize})`);
    }

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
 * Front and back images go through the full garment detection pipeline.
 * Side images use simple contain-resize (no garment detection needed).
 *
 * Returns both the uploaded file inputs and computed print area coords
 * (derived from the front image's garment placement, or null if no front image succeeded).
 */
export async function processProductImages(
  client: ShopifyClient,
  imageUrls: { front?: string; back?: string; side?: string },
  productName: string,
  colorName: string,
  categoryGroup: CategoryGroup,
): Promise<ImageProcessResult> {
  const files: FileSetInput[] = [];
  let printAreaCoords: PrintAreaCoords | null = null;

  // Process front image — full garment detection pipeline
  if (imageUrls.front) {
    try {
      const raw = await downloadImage(imageUrls.front);
      const { buffer: standardized, garmentPlacement } = await standardizeImage(raw, categoryGroup);
      const filename = `${productName}-${colorName}-front.png`
        .replace(/\s+/g, '-')
        .toLowerCase();
      const resourceUrl = await uploadStagedImage(client, standardized, filename);
      files.push({ originalSource: resourceUrl, alt: 'Front Print', contentType: 'IMAGE' });
      // Derive print area coords from front image's garment placement
      printAreaCoords = derivePrintAreaCoords(
        garmentPlacement.left,
        garmentPlacement.top,
        garmentPlacement.width,
        garmentPlacement.height,
        categoryGroup,
      );
    } catch (err) {
      logger.warn(
        `Skipping front image for ${productName} ${colorName}: ${(err as Error).message}`
      );
    }
  }

  // Process back image — full garment detection pipeline
  if (imageUrls.back) {
    try {
      const raw = await downloadImage(imageUrls.back);
      const { buffer: standardized } = await standardizeImage(raw, categoryGroup);
      const filename = `${productName}-${colorName}-back.png`
        .replace(/\s+/g, '-')
        .toLowerCase();
      const resourceUrl = await uploadStagedImage(client, standardized, filename);
      files.push({ originalSource: resourceUrl, alt: 'Back Print', contentType: 'IMAGE' });
    } catch (err) {
      logger.warn(
        `Skipping back image for ${productName} ${colorName}: ${(err as Error).message}`
      );
    }
  }

  // Process side image — simple contain-resize (no garment detection)
  if (imageUrls.side) {
    try {
      const raw = await downloadImage(imageUrls.side);
      const standardized = await sharp(raw)
        .resize(2000, 2000, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
      const filename = `${productName}-${colorName}-side.png`
        .replace(/\s+/g, '-')
        .toLowerCase();
      const resourceUrl = await uploadStagedImage(client, standardized, filename);
      files.push({
        originalSource: resourceUrl,
        alt: `${productName} - ${colorName} Side`,
        contentType: 'IMAGE',
      });
    } catch (err) {
      logger.warn(
        `Skipping side image for ${productName} ${colorName}: ${(err as Error).message}`
      );
    }
  }

  return { files, printAreaCoords };
}

/**
 * Build EnrichmentUpdate objects for standardized image URLs.
 * Targets FrontImage (col K, index 10), BackImage (col L, index 11), DirectSideImage (col M, index 12).
 * INTENTIONALLY bypasses buildUpdates() skip-if-nonempty logic — standardization MUST overwrite existing URLs.
 */
export function buildStandardizationUpdates(
  sheetName: string,
  rowIndex: number,  // 0-based data row index
  urls: { front?: string; back?: string; side?: string },
): EnrichmentUpdate[] {
  const sheetRowNumber = rowIndex + 2;  // row 1 = headers, data starts row 2
  const updates: EnrichmentUpdate[] = [];
  if (urls.front) updates.push({ range: `${sheetName}!K${sheetRowNumber}`, values: [[urls.front]] });
  if (urls.back)  updates.push({ range: `${sheetName}!L${sheetRowNumber}`, values: [[urls.back]] });
  if (urls.side)  updates.push({ range: `${sheetName}!M${sheetRowNumber}`, values: [[urls.side]] });
  return updates;
}

/**
 * Download, standardize, and upload images via Shopify staged uploads for CDN URLs,
 * then write those URLs to Google Sheets image columns.
 *
 * Per D-03: does NOT attach images to Shopify products. Uses staged uploads ONLY for URL generation.
 * Per D-04: CDN URLs from staged uploads are written to sheets for future use.
 *
 * Front and back images go through the garment detection pipeline.
 * Side images use contain-resize (no garment detection, matching processProductImages behavior).
 */
export async function standardizeImagesToSheets(
  client: ShopifyClient,
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  imageUrls: { front?: string; back?: string; side?: string },
  rowIndex: number,
  productName: string,
  colorName: string,
  categoryGroup: CategoryGroup,
): Promise<{ cellsWritten: number; printAreaCoords: PrintAreaCoords | null }> {
  const cdnUrls: { front?: string; back?: string; side?: string } = {};
  let printAreaCoords: PrintAreaCoords | null = null;

  // Process front image — full garment detection pipeline
  if (imageUrls.front) {
    try {
      const raw = await downloadImage(imageUrls.front);
      const { buffer: standardized, garmentPlacement } = await standardizeImage(raw, categoryGroup);
      const filename = `${productName}-${colorName}-front-std.png`.replace(/\s+/g, '-').toLowerCase();
      cdnUrls.front = await uploadStagedImage(client, standardized, filename);
      printAreaCoords = derivePrintAreaCoords(
        garmentPlacement.left, garmentPlacement.top,
        garmentPlacement.width, garmentPlacement.height,
        categoryGroup,
      );
    } catch (err) {
      logger.warn(`Skipping front standardization for ${productName} ${colorName}: ${(err as Error).message}`);
    }
  }

  // Process back image — full garment detection pipeline
  if (imageUrls.back) {
    try {
      const raw = await downloadImage(imageUrls.back);
      const { buffer: standardized } = await standardizeImage(raw, categoryGroup);
      const filename = `${productName}-${colorName}-back-std.png`.replace(/\s+/g, '-').toLowerCase();
      cdnUrls.back = await uploadStagedImage(client, standardized, filename);
    } catch (err) {
      logger.warn(`Skipping back standardization for ${productName} ${colorName}: ${(err as Error).message}`);
    }
  }

  // Process side image — contain-resize only (no garment detection)
  if (imageUrls.side) {
    try {
      const raw = await downloadImage(imageUrls.side);
      const standardized = await sharp(raw)
        .resize(2000, 2000, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
      const filename = `${productName}-${colorName}-side-std.png`.replace(/\s+/g, '-').toLowerCase();
      cdnUrls.side = await uploadStagedImage(client, standardized, filename);
    } catch (err) {
      logger.warn(`Skipping side standardization for ${productName} ${colorName}: ${(err as Error).message}`);
    }
  }

  // Build sheet updates — overwrite existing URLs (not skip-if-nonempty)
  const updates = buildStandardizationUpdates(sheetName, rowIndex, cdnUrls);

  if (updates.length === 0) {
    return { cellsWritten: 0, printAreaCoords };
  }

  const cellsWritten = await writeUpdates(sheets, spreadsheetId, updates);
  logger.info(`Wrote ${cellsWritten} standardized image URL(s) for ${productName} ${colorName} to row ${rowIndex + 2}`);

  return { cellsWritten, printAreaCoords };
}
