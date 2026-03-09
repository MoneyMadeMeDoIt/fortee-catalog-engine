import sharp from 'sharp';
import { logger } from '../lib/logger.js';
import { STAGED_UPLOADS_CREATE } from './mutations.js';
import type { FileSetInput } from './types.js';

/** Client interface matching the Shopify Admin API client pattern. */
export interface ShopifyClient {
  request: (
    query: string,
    options: { variables: Record<string, unknown> }
  ) => Promise<unknown>;
}

/**
 * Resize an image buffer to 2000x2000 with white background.
 * Uses `fit: contain` so the image is scaled down proportionally and
 * centered on a white canvas.
 */
export async function standardizeImage(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .resize(2000, 2000, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
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
 */
export async function processProductImages(
  client: ShopifyClient,
  imageUrls: { front?: string; back?: string; side?: string },
  productName: string,
  colorName: string
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
      const standardized = await standardizeImage(raw);
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
