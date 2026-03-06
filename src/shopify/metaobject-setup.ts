import { createLogger, transports, format } from 'winston';
import { CREATE_PRINT_AREA_DEFINITION, CREATE_METAFIELD_DEFINITION } from './mutations.js';

const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.simple()),
  transports: [new transports.Console()],
});

interface UserError {
  field: string[];
  message: string;
  code?: string;
}

/**
 * One-time setup: creates the Print Area metaobject definition and the
 * product metafield definition that links products to Print Area metaobjects.
 *
 * Safe to run multiple times -- handles "already exists" errors gracefully.
 */
export async function setupPrintAreaDefinitions(
  client: { request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown> },
): Promise<void> {
  // Step 1: Create the "print_area" metaobject type definition
  await createPrintAreaMetaobjectDefinition(client);

  // Step 2: Create the product metafield definition for print_areas
  await createPrintAreasMetafieldDefinition(client);
}

async function createPrintAreaMetaobjectDefinition(
  client: { request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown> },
): Promise<void> {
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

async function createPrintAreasMetafieldDefinition(
  client: { request: (query: string, options: { variables: Record<string, unknown> }) => Promise<unknown> },
): Promise<void> {
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
