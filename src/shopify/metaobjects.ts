import { createLogger } from 'winston';
import { UPSERT_PRINT_AREA, METAFIELDS_SET } from './mutations.js';
import type { DecorationPlacement } from '../decoration/types.js';

const logger = createLogger({ level: 'info' });

export interface MetaobjectField {
  key: string;
  value: string;
}

export interface MetaobjectUpsertInput {
  fields: MetaobjectField[];
}

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/**
 * Build a deterministic, URL-safe handle for a Print Area metaobject.
 * Format: {category}-{method}-{placement}, lowercased, non-alphanumeric replaced with hyphens.
 */
export function buildPrintAreaHandle(category: string, method: string, placement: string): string {
  return `${category}-${method}-${placement}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build the metaobject upsert input fields from a DecorationPlacement.
 */
export function buildPrintAreaInput(placement: DecorationPlacement): MetaobjectUpsertInput {
  return {
    fields: [
      { key: 'method', value: placement.method },
      { key: 'placement', value: placement.placementName },
      { key: 'max_size', value: placement.maxSize },
      { key: 'common_sizes', value: placement.commonSizes },
      { key: 'notes', value: placement.notes },
    ],
  };
}

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
 * Upsert Print Area metaobjects for all placements of a garment category.
 * Returns array of successfully created/updated metaobject GIDs.
 * Logs errors but continues (partial success is acceptable).
 */
export async function upsertPrintAreas(
  client: { request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown> },
  category: string,
  placements: DecorationPlacement[],
): Promise<string[]> {
  const gids: string[] = [];

  for (const placement of placements) {
    const handle = buildPrintAreaHandle(category, placement.method, placement.placementName);
    const input = buildPrintAreaInput(placement);

    try {
      const response = await client.request(UPSERT_PRINT_AREA, {
        variables: {
          handle: { handle, type: 'print_area' },
          metaobject: input,
        },
      }) as { data: { metaobjectUpsert: { metaobject: { id: string } | null; userErrors: { message: string }[] } } };

      const { metaobject, userErrors } = response.data.metaobjectUpsert;

      if (userErrors.length > 0) {
        logger.error(`Failed to upsert Print Area "${handle}": ${userErrors.map((e) => e.message).join(', ')}`);
        continue;
      }

      if (metaobject) {
        gids.push(metaobject.id);
      }
    } catch (error) {
      logger.error(`Error upserting Print Area "${handle}":`, error);
    }
  }

  return gids;
}

/**
 * Link Print Area metaobjects to a product via the custom.print_areas metafield.
 * Throws on userErrors from the METAFIELDS_SET mutation.
 */
export async function linkPrintAreasToProduct(
  client: { request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown> },
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
