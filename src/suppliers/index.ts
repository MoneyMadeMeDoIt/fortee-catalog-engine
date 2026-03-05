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

export async function extractAll(): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];

  // Sequential: CSW first (no rate limits), then S&S
  results.push(await extractFromSupplier('canada-sportswear'));
  results.push(await extractFromSupplier('ss-canada'));

  return results;
}
