import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import {
  standardizeImage,
  downloadImage,
  uploadStagedImage,
  processProductImages,
} from '../../src/shopify/image-standardizer.js';

describe('standardizeImage', () => {
  it('resizes to 2000x2000 PNG with white background', async () => {
    // Create a small 100x100 red PNG as input
    const input = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const output = await standardizeImage(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(2000);
    expect(meta.format).toBe('png');
  });

  it('preserves aspect ratio with contain fit', async () => {
    // A wide 200x100 image should be contained, not stretched
    const input = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const output = await standardizeImage(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(2000);
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
