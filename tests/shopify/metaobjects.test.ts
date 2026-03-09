import { describe, it, expect, vi } from 'vitest';
import {
  buildPrintAreaMetafieldInput,
  getExistingPrintAreaGids,
  linkPrintAreasToProduct,
} from '../../src/shopify/metaobjects.js';

describe('buildPrintAreaMetafieldInput', () => {
  it('creates JSON-stringified array of GIDs', () => {
    const result = buildPrintAreaMetafieldInput('gid://shopify/Product/1', [
      'gid://shopify/Metaobject/123',
      'gid://shopify/Metaobject/456',
    ]);
    expect(result).toEqual({
      ownerId: 'gid://shopify/Product/1',
      namespace: 'custom',
      key: 'print_areas',
      type: 'list.metaobject_reference',
      value: '["gid://shopify/Metaobject/123","gid://shopify/Metaobject/456"]',
    });
  });

  it('returns empty JSON array for empty GIDs', () => {
    const result = buildPrintAreaMetafieldInput('gid://shopify/Product/1', []);
    expect(result.value).toBe('[]');
  });
});

describe('getExistingPrintAreaGids', () => {
  it('calls metaobjectByHandle for front-dtf and back-print with type print_area', async () => {
    const mockClient = {
      request: vi.fn()
        .mockResolvedValueOnce({
          data: {
            metaobjectByHandle: { id: 'gid://shopify/Metaobject/100', handle: 'front-dtf' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            metaobjectByHandle: { id: 'gid://shopify/Metaobject/200', handle: 'back-print' },
          },
        }),
    };

    await getExistingPrintAreaGids(mockClient);

    expect(mockClient.request).toHaveBeenCalledTimes(2);
    // First call: front-dtf
    const firstCall = mockClient.request.mock.calls[0];
    expect(firstCall[1].variables.handle).toEqual({ type: 'print_area', handle: 'front-dtf' });
    // Second call: back-print
    const secondCall = mockClient.request.mock.calls[1];
    expect(secondCall[1].variables.handle).toEqual({ type: 'print_area', handle: 'back-print' });
  });

  it('returns array of GIDs when both found', async () => {
    const mockClient = {
      request: vi.fn()
        .mockResolvedValueOnce({
          data: {
            metaobjectByHandle: { id: 'gid://shopify/Metaobject/100' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            metaobjectByHandle: { id: 'gid://shopify/Metaobject/200' },
          },
        }),
    };

    const gids = await getExistingPrintAreaGids(mockClient);
    expect(gids).toEqual(['gid://shopify/Metaobject/100', 'gid://shopify/Metaobject/200']);
  });

  it('throws when front-dtf metaobject is not found', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: { metaobjectByHandle: null },
      }),
    };

    await expect(getExistingPrintAreaGids(mockClient)).rejects.toThrow('front-dtf');
  });

  it('throws when back-print metaobject is not found', async () => {
    const mockClient = {
      request: vi.fn()
        .mockResolvedValueOnce({
          data: {
            metaobjectByHandle: { id: 'gid://shopify/Metaobject/100' },
          },
        })
        .mockResolvedValueOnce({
          data: { metaobjectByHandle: null },
        }),
    };

    await expect(getExistingPrintAreaGids(mockClient)).rejects.toThrow('back-print');
  });
});

describe('linkPrintAreasToProduct', () => {
  it('calls METAFIELDS_SET with correct input', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          metafieldsSet: {
            metafields: [{ id: 'gid://shopify/Metafield/1' }],
            userErrors: [],
          },
        },
      }),
    };

    await linkPrintAreasToProduct(mockClient, 'gid://shopify/Product/1', [
      'gid://shopify/Metaobject/123',
    ]);
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it('throws on userErrors', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          metafieldsSet: {
            metafields: null,
            userErrors: [{ message: 'Invalid metafield' }],
          },
        },
      }),
    };

    await expect(
      linkPrintAreasToProduct(mockClient, 'gid://shopify/Product/1', ['gid://shopify/Metaobject/123']),
    ).rejects.toThrow('Invalid metafield');
  });
});
