import { CREATE_PRINT_AREA_DEFINITION, CREATE_METAFIELD_DEFINITION } from './mutations.js';
import { logger } from '../lib/logger.js';

interface UserError {
  field: string[];
  message: string;
  code?: string;
}

type ShopifyClient = {
  request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown>;
};

/**
 * One-time setup: creates all metaobject/metafield definitions needed for product push.
 *
 * Safe to run multiple times -- handles "already exists" errors gracefully.
 */
export async function setupPrintAreaDefinitions(client: ShopifyClient): Promise<void> {
  await createPrintAreaMetaobjectDefinition(client);
  await createPrintAreasMetafieldDefinition(client);
  await setupVariantMetafieldDefinition(client);
  await setupMinOrderQtyMetafieldDefinition(client);
}

/** Alias for backward compatibility. */
export const setupMetafieldDefinitions = setupPrintAreaDefinitions;

/**
 * Creates the metafield definition for custom.print_area_position (JSON, on PRODUCTVARIANT).
 */
export async function setupVariantMetafieldDefinition(client: ShopifyClient): Promise<void> {
  try {
    const response = await client.request(CREATE_METAFIELD_DEFINITION, {
      variables: {
        definition: {
          namespace: 'custom',
          key: 'print_area_position',
          name: 'Print Area Position',
          type: 'json',
          ownerType: 'PRODUCTVARIANT',
        },
      },
    }) as {
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: { id: string; namespace: string; key: string } | null;
          userErrors: UserError[];
        };
      };
    };

    const { createdDefinition, userErrors } = response.data.metafieldDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes('already exists') || e.message.toLowerCase().includes('taken'),
      );
      if (alreadyExists) {
        logger.info('Variant print_area_position metafield definition already exists -- skipping');
        return;
      }
      throw new Error(`Failed to create variant metafield definition: ${userErrors.map((e) => e.message).join(', ')}`);
    }

    logger.info(`Created variant metafield definition: ${createdDefinition?.namespace}.${createdDefinition?.key}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
    logger.error('Error creating variant metafield definition:', error);
    throw error;
  }
}

/**
 * Creates the metafield definition for custom.minimum_order_quantity (number_integer, on PRODUCT).
 */
export async function setupMinOrderQtyMetafieldDefinition(client: ShopifyClient): Promise<void> {
  try {
    const response = await client.request(CREATE_METAFIELD_DEFINITION, {
      variables: {
        definition: {
          namespace: 'custom',
          key: 'minimum_order_quantity',
          name: 'Minimum Order Quantity',
          type: 'number_integer',
          ownerType: 'PRODUCT',
        },
      },
    }) as {
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: { id: string; namespace: string; key: string } | null;
          userErrors: UserError[];
        };
      };
    };

    const { createdDefinition, userErrors } = response.data.metafieldDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes('already exists') || e.message.toLowerCase().includes('taken'),
      );
      if (alreadyExists) {
        logger.info('Product minimum_order_quantity metafield definition already exists -- skipping');
        return;
      }
      throw new Error(`Failed to create MOQ metafield definition: ${userErrors.map((e) => e.message).join(', ')}`);
    }

    logger.info(`Created product metafield definition: ${createdDefinition?.namespace}.${createdDefinition?.key}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
    logger.error('Error creating MOQ metafield definition:', error);
    throw error;
  }
}

async function createPrintAreaMetaobjectDefinition(client: ShopifyClient): Promise<void> {
  try {
    const response = await client.request(CREATE_PRINT_AREA_DEFINITION, {
      variables: {
        definition: {
          type: 'print_area',
          name: 'Print Area',
          fieldDefinitions: [
            { key: 'method', name: 'Method', type: 'single_line_text_field' },
            { key: 'placement', name: 'Placement', type: 'single_line_text_field' },
            { key: 'max_size', name: 'Max Size', type: 'single_line_text_field' },
            { key: 'common_sizes', name: 'Common Sizes', type: 'single_line_text_field' },
            { key: 'notes', name: 'Notes', type: 'multi_line_text_field' },
          ],
        },
      },
    }) as {
      data: {
        metaobjectDefinitionCreate: {
          metaobjectDefinition: { id: string; type: string } | null;
          userErrors: UserError[];
        };
      };
    };

    const { metaobjectDefinition, userErrors } = response.data.metaobjectDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes('already exists') || e.message.toLowerCase().includes('taken'),
      );
      if (alreadyExists) {
        logger.info('Print Area metaobject definition already exists -- skipping');
        return;
      }
      throw new Error(`Failed to create Print Area definition: ${userErrors.map((e) => e.message).join(', ')}`);
    }

    logger.info(`Created Print Area metaobject definition: ${metaobjectDefinition?.id}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
    logger.error('Error creating Print Area metaobject definition:', error);
    throw error;
  }
}

async function createPrintAreasMetafieldDefinition(client: ShopifyClient): Promise<void> {
  try {
    const response = await client.request(CREATE_METAFIELD_DEFINITION, {
      variables: {
        definition: {
          namespace: 'custom',
          key: 'print_areas',
          name: 'Print Areas',
          type: 'list.metaobject_reference',
          ownerType: 'PRODUCT',
        },
      },
    }) as {
      data: {
        metafieldDefinitionCreate: {
          createdDefinition: { id: string; namespace: string; key: string } | null;
          userErrors: UserError[];
        };
      };
    };

    const { createdDefinition, userErrors } = response.data.metafieldDefinitionCreate;

    if (userErrors.length > 0) {
      const alreadyExists = userErrors.some(
        (e) => e.message.toLowerCase().includes('already exists') || e.message.toLowerCase().includes('taken'),
      );
      if (alreadyExists) {
        logger.info('Product print_areas metafield definition already exists -- skipping');
        return;
      }
      throw new Error(`Failed to create metafield definition: ${userErrors.map((e) => e.message).join(', ')}`);
    }

    logger.info(`Created product metafield definition: ${createdDefinition?.namespace}.${createdDefinition?.key}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
    logger.error('Error creating metafield definition:', error);
    throw error;
  }
}
