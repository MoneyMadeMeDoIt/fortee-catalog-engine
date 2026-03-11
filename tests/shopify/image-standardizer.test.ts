import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import {
  standardizeImage,
  downloadImage,
  uploadStagedImage,
  processProductImages,
  detectGarmentBounds,
  placeGarmentOnCanvas,
  derivePrintAreaCoords,
  REFERENCE_RATIOS,
  GARMENT_RELATIVE_PRINT_FRACTIONS,
} from '../../src/shopify/image-standardizer.js';

describe('standardizeImage', () => {
  it('returns 2000x2000 PNG buffer and garmentPlacement for tops', async () => {
    // Create a garment-like image: colored rectangle on white background
    const canvas = await sharp({
      create: { width: 1000, height: 1000, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    }).png().toBuffer();
    const garmentPng = await sharp(canvas)
      .composite([{
        input: await sharp({
          create: { width: 500, height: 800, channels: 3, background: { r: 200, g: 50, b: 50 } },
        }).png().toBuffer(),
        left: 250,
        top: 100,
      }])
      .png()
      .toBuffer();

    const result = await standardizeImage(garmentPng, 'tops');
    const meta = await sharp(result.buffer).metadata();

    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(2000);
    expect(meta.format).toBe('png');
    expect(result.garmentPlacement).toBeDefined();
    expect(result.garmentPlacement).toHaveProperty('left');
    expect(result.garmentPlacement).toHaveProperty('top');
    expect(result.garmentPlacement).toHaveProperty('width');
    expect(result.garmentPlacement).toHaveProperty('height');
  });

  it('returns 2000x2000 PNG for hoodies', async () => {
    const input = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await standardizeImage(input, 'hoodies');
    const meta = await sharp(result.buffer).metadata();

    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(2000);
  });
});

describe('detectGarmentBounds', () => {
  it('returns correct bounding box for a garment on a white background', async () => {
    // Create a 1000x1000 white canvas with a 500x800 red rectangle at (250, 100)
    const whiteCanvas = await sharp({
      create: { width: 1000, height: 1000, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    }).png().toBuffer();
    const image = await sharp(whiteCanvas)
      .composite([{
        input: await sharp({
          create: { width: 500, height: 800, channels: 3, background: { r: 255, g: 0, b: 0 } },
        }).png().toBuffer(),
        left: 250,
        top: 100,
      }])
      .png()
      .toBuffer();

    const bounds = await detectGarmentBounds(image);

    expect(bounds.originalWidth).toBe(1000);
    expect(bounds.originalHeight).toBe(1000);
    // Trim should detect the garment roughly at x=250, y=100, w=500, h=800
    // Allow ±5px tolerance for edge effects
    expect(bounds.offsetLeft).toBeGreaterThanOrEqual(245);
    expect(bounds.offsetLeft).toBeLessThanOrEqual(255);
    expect(bounds.offsetTop).toBeGreaterThanOrEqual(95);
    expect(bounds.offsetTop).toBeLessThanOrEqual(105);
    expect(bounds.width).toBeGreaterThanOrEqual(495);
    expect(bounds.width).toBeLessThanOrEqual(505);
    expect(bounds.height).toBeGreaterThanOrEqual(795);
    expect(bounds.height).toBeLessThanOrEqual(805);
  });

  it('returns fallback bounds (full dimensions) when trim removes >70% of image', async () => {
    // Create an image where the colored pixel is only in a tiny corner (< 30% of image)
    const whiteCanvas = await sharp({
      create: { width: 1000, height: 1000, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    }).png().toBuffer();
    const tinyGarment = await sharp(whiteCanvas)
      .composite([{
        input: await sharp({
          create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
        }).png().toBuffer(),
        left: 0,
        top: 0,
      }])
      .png()
      .toBuffer();

    const bounds = await detectGarmentBounds(tinyGarment);

    // Garment is only 50x50 on 1000x1000 — trim removes >95%, triggers fallback
    expect(bounds.offsetLeft).toBe(0);
    expect(bounds.offsetTop).toBe(0);
    expect(bounds.width).toBe(1000);
    expect(bounds.height).toBe(1000);
  });
});

describe('placeGarmentOnCanvas', () => {
  it('always outputs exactly 2000x2000 PNG', async () => {
    const garmentBuffer = await sharp({
      create: { width: 300, height: 500, channels: 3, background: { r: 100, g: 100, b: 200 } },
    }).png().toBuffer();

    const result = await placeGarmentOnCanvas(garmentBuffer, 1460, 120);
    const meta = await sharp(result).metadata();

    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(2000);
    expect(meta.format).toBe('png');
  });

  it('places garment at approximately the specified top offset', async () => {
    const garmentBuffer = await sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer();

    const targetTop = 120;
    const result = await placeGarmentOnCanvas(garmentBuffer, 1460, targetTop);

    // Check pixel just above the garment is white and pixel at garment position is non-white
    const topPixel = await sharp(result)
      .extract({ left: 1000, top: targetTop - 10, width: 1, height: 1 })
      .raw()
      .toBuffer();
    // Should be white (255, 255, 255)
    expect(topPixel[0]).toBe(255);
    expect(topPixel[1]).toBe(255);
    expect(topPixel[2]).toBe(255);
  });
});

describe('derivePrintAreaCoords', () => {
  it('returns Front Print and Back Print for tops', () => {
    const coords = derivePrintAreaCoords(87, 120, 1826, 1460, 'tops');

    expect(coords).toHaveProperty('Front Print');
    expect(coords).toHaveProperty('Back Print');

    const fractions = GARMENT_RELATIVE_PRINT_FRACTIONS.tops['Front Print'];
    const expectedX = ((87 + fractions.xFrac * 1826) / 2000) * 100;
    const expectedY = ((120 + fractions.yFrac * 1460) / 2000) * 100;

    expect(parseFloat(coords['Front Print'].x)).toBeCloseTo(expectedX, 1);
    expect(parseFloat(coords['Front Print'].y)).toBeCloseTo(expectedY, 1);
  });

  it('returns Front Print and Back Print for hoodies', () => {
    const coords = derivePrintAreaCoords(87, 100, 1826, 1560, 'hoodies');

    expect(coords).toHaveProperty('Front Print');
    expect(coords).toHaveProperty('Back Print');

    const fractions = GARMENT_RELATIVE_PRINT_FRACTIONS.hoodies['Back Print'];
    const expectedX = ((87 + fractions.xFrac * 1826) / 2000) * 100;

    expect(parseFloat(coords['Back Print'].x)).toBeCloseTo(expectedX, 1);
  });

  it('computes width and height as percentages of canvas', () => {
    const coords = derivePrintAreaCoords(0, 0, 2000, 2000, 'tops');
    const fractions = GARMENT_RELATIVE_PRINT_FRACTIONS.tops['Front Print'];

    // Width = (fractions.wFrac * garmentWidth / canvasSize) * 100
    const expectedWidth = (fractions.wFrac * 2000 / 2000) * 100;
    expect(parseFloat(coords['Front Print'].width)).toBeCloseTo(expectedWidth, 1);
  });

  it('REFERENCE_RATIOS has tops and hoodies keys', () => {
    expect(REFERENCE_RATIOS).toHaveProperty('tops');
    expect(REFERENCE_RATIOS).toHaveProperty('hoodies');
    expect(REFERENCE_RATIOS.tops).toHaveProperty('targetHeightFrac');
    expect(REFERENCE_RATIOS.tops).toHaveProperty('topOffsetFrac');
  });
});

describe('downloadImage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns buffer from successful fetch', async () => {
    const fakeData = new Uint8Array([1, 2, 3, 4]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => fakeData.buffer,
    } as Response);

    const result = await downloadImage('https://example.com/image.png');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  it('throws descriptive error on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    await expect(downloadImage('https://example.com/missing.png')).rejects.toThrow(
      'Failed to download image from https://example.com/missing.png: HTTP 404 Not Found'
    );
  });
});

describe('uploadStagedImage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls stagedUploadsCreate and returns resourceUrl', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.shopify.com/staged',
                resourceUrl: 'https://cdn.shopify.com/image.png',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      }),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
    } as Response);

    const buffer = Buffer.from('test-image-data');
    const result = await uploadStagedImage(mockClient, buffer, 'test.png');

    expect(result).toBe('https://cdn.shopify.com/image.png');
    expect(mockClient.request).toHaveBeenCalledOnce();

    // Verify the mutation was called with correct variables
    const callArgs = mockClient.request.mock.calls[0];
    expect(callArgs[1].variables.input[0]).toMatchObject({
      resource: 'IMAGE',
      filename: 'test.png',
      mimeType: 'image/png',
      fileSize: String(buffer.length),
      httpMethod: 'PUT',
    });

    // Verify PUT was called
    expect(globalThis.fetch).toHaveBeenCalledWith('https://upload.shopify.com/staged', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: buffer,
    });
  });

  it('throws on user errors', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [],
            userErrors: [{ field: ['input'], message: 'Invalid file type' }],
          },
        },
      }),
    };

    await expect(
      uploadStagedImage(mockClient, Buffer.from('data'), 'bad.png')
    ).rejects.toThrow('Staged upload errors for bad.png: Invalid file type');
  });

  it('throws when PUT fails', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.shopify.com/staged',
                resourceUrl: 'https://cdn.shopify.com/image.png',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      }),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(
      uploadStagedImage(mockClient, Buffer.from('data'), 'fail.png')
    ).rejects.toThrow('Failed to PUT image to staged URL for fail.png: HTTP 500');
  });
});

describe('processProductImages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns correct alt text for front and back images', async () => {
    // Mock fetch to return a valid small image for downloads
    const smallImage = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.shopify.com/staged',
                resourceUrl: 'https://cdn.shopify.com/result.png',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      }),
    };

    // First call = download, second call = PUT upload (per image)
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      // Even calls are PUTs (ok response), odd calls are downloads (image data)
      // Actually: for each image, downloadImage calls fetch, then uploadStagedImage calls fetch
      // So pattern is: download, PUT, download, PUT, ...
      if (callCount % 2 === 1) {
        // Download call
        return {
          ok: true,
          arrayBuffer: async () => smallImage.buffer.slice(smallImage.byteOffset, smallImage.byteOffset + smallImage.byteLength),
        } as Response;
      }
      // PUT call
      return { ok: true } as Response;
    });

    const files = await processProductImages(
      mockClient,
      { front: 'https://img.com/front.jpg', back: 'https://img.com/back.jpg' },
      'Test Tee',
      'Red'
    );

    expect(files).toHaveLength(2);
    expect(files[0].alt).toBe('Front Print');
    expect(files[1].alt).toBe('Back Print');
    expect(files[0].contentType).toBe('IMAGE');
  });

  it('assigns correct alt text for side images', async () => {
    const smallImage = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.shopify.com/staged',
                resourceUrl: 'https://cdn.shopify.com/result.png',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      }),
    };

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 1) {
        return {
          ok: true,
          arrayBuffer: async () => smallImage.buffer.slice(smallImage.byteOffset, smallImage.byteOffset + smallImage.byteLength),
        } as Response;
      }
      return { ok: true } as Response;
    });

    const files = await processProductImages(
      mockClient,
      { side: 'https://img.com/side.jpg' },
      'Cool Hoodie',
      'Blue'
    );

    expect(files).toHaveLength(1);
    expect(files[0].alt).toBe('Cool Hoodie - Blue Side');
  });

  it('skips failed image downloads gracefully', async () => {
    const smallImage = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.shopify.com/staged',
                resourceUrl: 'https://cdn.shopify.com/result.png',
                parameters: [],
              },
            ],
            userErrors: [],
          },
        },
      }),
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();

      // Front image download fails
      if (urlStr.includes('front')) {
        return { ok: false, status: 404, statusText: 'Not Found' } as Response;
      }
      // Staged upload PUT calls go to upload.shopify.com
      if (urlStr.includes('upload.shopify.com')) {
        return { ok: true } as Response;
      }
      // Back image download succeeds
      return {
        ok: true,
        arrayBuffer: async () => smallImage.buffer.slice(smallImage.byteOffset, smallImage.byteOffset + smallImage.byteLength),
      } as Response;
    });

    const files = await processProductImages(
      mockClient,
      { front: 'https://img.com/front.jpg', back: 'https://img.com/back.jpg' },
      'Test Tee',
      'Red'
    );

    // Front failed, only back should be present
    expect(files).toHaveLength(1);
    expect(files[0].alt).toBe('Back Print');
  });

  it('returns empty array when all images fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    } as Response);

    const mockClient = { request: vi.fn() };

    const files = await processProductImages(
      mockClient,
      { front: 'https://img.com/front.jpg' },
      'Test Tee',
      'Red'
    );

    expect(files).toHaveLength(0);
  });

  it('handles empty imageUrls', async () => {
    const mockClient = { request: vi.fn() };

    const files = await processProductImages(mockClient, {}, 'Test', 'Red');

    expect(files).toHaveLength(0);
    expect(mockClient.request).not.toHaveBeenCalled();
  });
});
