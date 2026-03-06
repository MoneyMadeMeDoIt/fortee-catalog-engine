import { CanadaSportswearAdapter } from './canada-sportswear.js';
import { SSCanadaAdapter } from './ss-canada.js';
import { validateProduct } from './types.js';
import type { SupplierProduct } from './types.js';
import { logger } from '../lib/logger.js';

export type ExtractionResult = {
  supplier: string;
  products: SupplierProduct[];
  validationErrors: Array<{ styleNumber: string; errors: string[] }>;
  summary: { total: number; valid: number; invalid: number };
};

type SupplierName = 'canada-sportswear' | 'ss-canada';

export async function extractFromSupplier(
  supplier: SupplierName
): Promise<ExtractionResult> {
  const adapter =
    supplier === 'canada-sportswear'
      ? new CanadaSportswearAdapter()
      : new SSCanadaAdapter();

  const rawProducts = await adapter.fetchProducts();

  const validProducts: SupplierProduct[] = [];
  const validationErrors: Array<{ styleNumber: string; errors: string[] }> = [];

  for (const product of rawProducts) {
    const result = validateProduct(product);
    if (result.valid) {
      validProducts.push(result.data);
    } else {
      validationErrors.push({
        styleNumber:
          (product as Record<string, unknown>).styleNumber as string ??
          'unknown',
        errors: result.errors,
      });
    }
  }

  const summary = {
    total: rawProducts.length,
    valid: validProducts.length,
    invalid: validationErrors.length,
  };

  logger.info(
    `Extracted ${summary.total} products from ${supplier}: ${summary.valid} valid, ${summary.invalid} invalid`
  );

  return { supplier, products: validProducts, validationErrors, summary };
}

export async function extractProductsByIds(
  supplier: SupplierName,
  productIds: string[],
  options: { skipValidation?: boolean } = {},
): Promise<ExtractionResult> {
  const adapter =
    supplier === 'canada-sportswear'
      ? new CanadaSportswearAdapter()
      : new SSCanadaAdapter();

  logger.info(`${supplier}: Fetching ${productIds.length} specific products...`);

  const rawProducts: SupplierProduct[] = [];
  const validProducts: SupplierProduct[] = [];
  const validationErrors: Array<{ styleNumber: string; errors: string[] }> = [];

  for (const id of productIds) {
    try {
      const product = await adapter.fetchProduct(id);
      rawProducts.push(product);

      if (options.skipValidation) {
        validProducts.push(product);
      } else {
        const result = validateProduct(product);
        if (result.valid) {
          validProducts.push(result.data);
        } else {
          validationErrors.push({
            styleNumber: product.styleNumber ?? 'unknown',
            errors: result.errors,
          });
        }
      }
    } catch (error) {
      logger.warn(`${supplier}: Failed to fetch product ${id}: ${error}`);
      validationErrors.push({ styleNumber: id, errors: [String(error)] });
    }
  }

  const summary = {
    total: rawProducts.length,
    valid: validProducts.length,
    invalid: validationErrors.length,
  };

  logger.info(
    `Extracted ${summary.total} products from ${supplier}: ${summary.valid} valid, ${summary.invalid} invalid`
  );

  return { supplier, products: validProducts, validationErrors, summary };
}

export async function extractAll(): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];

  results.push(await extractFromSupplier('canada-sportswear'));
  results.push(await extractFromSupplier('ss-canada'));

  return results;
}
