import { METAOBJECT_BY_HANDLE, METAFIELDS_SET } from './mutations.js';
import { logger } from '../lib/logger.js';

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

type ShopifyClient = {
  request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown>;
};

/**
 * Build the metafield input for linking Print Area metaobjects to a product.
 * CRITICAL: value must be JSON.stringify of the GID array for list.metaobject_reference.
 */
export function buildPrintAreaMetafieldInput(
  productGid: string,
  metaobjectGids: string[],
): MetafieldSetInput {
  return {
    ownerId: productGid,
    namespace: 'custom',
    key: 'print_areas',
    type: 'list.metaobject_reference',
    value: JSON.stringify(metaobjectGids),
  };
}

/**
 * Look up existing Print Area metaobjects by handle.
 * Queries for 'front-dtf' and 'back-print' metaobjects (must already exist in the store).
 * Returns [frontGid, backGid] array.
 * Throws if either metaobject is not found.
 */
export async function getExistingPrintAreaGids(
  client: ShopifyClient,
): Promise<string[]> {
  const handles = [
    { type: 'print_area', handle: 'front-dtf' },
    { type: 'print_area', handle: 'back-print' },
  ];

  const gids: string[] = [];

  for (const handle of handles) {
    const response = await client.request(METAOBJECT_BY_HANDLE, {
      variables: { handle },
    }) as {
      data: {
        metaobjectByHandle: { id: string; handle: string } | null;
      };
    };

    const metaobject = response.data.metaobjectByHandle;
    if (!metaobject) {
      throw new Error(
        `Print Area metaobject "${handle.handle}" not found in the store. ` +
        `Ensure the "${handle.handle}" metaobject exists before pushing products.`
      );
    }

    gids.push(metaobject.id);
  }

  return gids;
}

/**
 * Link Print Area metaobjects to a product via the custom.print_areas metafield.
 * Throws on userErrors from the METAFIELDS_SET mutation.
 */
export async function linkPrintAreasToProduct(
  client: ShopifyClient,
  productGid: string,
  metaobjectGids: string[],
): Promise<void> {
  const metafieldInput = buildPrintAreaMetafieldInput(productGid, metaobjectGids);

  const response = await client.request(METAFIELDS_SET, {
    variables: {
      metafields: [metafieldInput],
    },
  }) as { data: { metafieldsSet: { metafields: unknown[] | null; userErrors: { message: string }[] } } };

  const { userErrors } = response.data.metafieldsSet;

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(', '));
  }
}
