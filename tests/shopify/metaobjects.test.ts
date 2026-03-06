import { describe, it, expect, vi } from 'vitest';
import {
  buildPrintAreaHandle,
  buildPrintAreaInput,
  buildPrintAreaMetafieldInput,
  upsertPrintAreas,
  linkPrintAreasToProduct,
} from '../../src/shopify/metaobjects.js';
import type { DecorationPlacement } from '../../src/decoration/types.js';

const samplePlacement: DecorationPlacement = {
  method: 'Print',
  bodyCategory: 'Front',
  placementName: 'Left Chest',
  commonSizes: '3.5x3.5',
  maxSize: '4.5x4.5',
  verticalRef: 'Center 4in below collar seam',
  horizontalRef: '3.5-4 in from centerline',
  notes: 'Primary brand logo',
};

describe('buildPrintAreaHandle', () => {
  it('produces lowercase hyphenated handle from category, method, placement', () => {
    expect(buildPrintAreaHandle('T-Shirt', 'Print', 'Left Chest')).toBe(
      't-shirt-print-left-chest',
    );
  });

  it('handles Cap + Embroidery + Front Center', () => {
    expect(buildPrintAreaHandle('Cap', 'Embroidery', 'Front Center')).toBe(
      'cap-embroidery-front-center',
    );
  });

  it('converts special characters to hyphens and deduplicates', () => {
    expect(buildPrintAreaHandle('Long Sleeve', 'Print', 'Cuff / Wrist')).toBe(
      'long-sleeve-print-cuff-wrist',
    );
  });

  it('trims leading and trailing hyphens', () => {
    expect(buildPrintAreaHandle(' Cap ', 'Print', ' Front ')).toBe('cap-print-front');
  });
});

describe('buildPrintAreaInput', () => {
  it('maps DecorationPlacement fields to metaobject fields array', () => {
    const input = buildPrintAreaInput(samplePlacement);
    expect(input.fields).toEqual([
      { key: 'method', value: 'Print' },
      { key: 'placement', value: 'Left Chest' },
      { key: 'max_size', value: '4.5x4.5' },
      { key: 'common_sizes', value: '3.5x3.5' },
      { key: 'notes', value: 'Primary brand logo' },
    ]);
  });
});

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

describe('upsertPrintAreas', () => {
  it('calls mutation for each placement and returns GIDs', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          metaobjectUpsert: {
            metaobject: { id: 'gid://shopify/Metaobject/111' },
            userErrors: [],
          },
        },
      }),
    };

    const gids = await upsertPrintAreas(mockClient, 'T-Shirt', [samplePlacement]);
    expect(gids).toEqual(['gid://shopify/Metaobject/111']);
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it('logs errors but continues on failure', async () => {
    const mockClient = {
      request: vi.fn()
        .mockResolvedValueOnce({
          data: {
            metaobjectUpsert: {
              metaobject: null,
              userErrors: [{ message: 'Something went wrong' }],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            metaobjectUpsert: {
              metaobject: { id: 'gid://shopify/Metaobject/222' },
              userErrors: [],
            },
          },
        }),
    };

    const secondPlacement: DecorationPlacement = {
      ...samplePlacement,
      placementName: 'Right Chest',
    };

    const gids = await upsertPrintAreas(mockClient, 'T-Shirt', [samplePlacement, secondPlacement]);
    expect(gids).toEqual(['gid://shopify/Metaobject/222']);
    expect(mockClient.request).toHaveBeenCalledTimes(2);
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
