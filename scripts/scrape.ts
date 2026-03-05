import 'dotenv/config';
import { extractAll, extractFromSupplier } from '../src/suppliers/index.js';
import { CanadaSportswearAdapter } from '../src/suppliers/canada-sportswear.js';
import { SSCanadaAdapter } from '../src/suppliers/ss-canada.js';
import { validateProduct } from '../src/suppliers/types.js';
import type { ExtractionResult } from '../src/suppliers/index.js';

type SupplierName = 'canada-sportswear' | 'ss-canada';

const VALID_SUPPLIERS: SupplierName[] = ['canada-sportswear', 'ss-canada'];

function parseArgs(): { supplier?: SupplierName; style?: string } {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: npx tsx scripts/scrape.ts [options]

Options:
  --supplier <name>   Extract from a single supplier (canada-sportswear | ss-canada)
  --style <id>        Extract a single product by identifier (handle for CSW, styleID for S&S)
  --help, -h          Show this help message

Examples:
  npx tsx scripts/scrape.ts                                    # Extract from all suppliers
  npx tsx scripts/scrape.ts --supplier canada-sportswear       # Extract from CSW only
  npx tsx scripts/scrape.ts --supplier ss-canada --style 12345 # Single S&S product`);
    process.exit(0);
  }

  let supplier: SupplierName | undefined;
  let style: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--supplier' && args[i + 1]) {
      const value = args[i + 1] as SupplierName;
      if (!VALID_SUPPLIERS.includes(value)) {
        console.error(
          `Invalid supplier: ${value}. Valid options: ${VALID_SUPPLIERS.join(', ')}`
        );
        process.exit(1);
      }
      supplier = value;
      i++;
    } else if (args[i] === '--style' && args[i + 1]) {
      style = args[i + 1];
      i++;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
    }
  }

  if (style && !supplier) {
    console.error('--style requires --supplier to be specified.');
    process.exit(1);
  }

  return { supplier, style };
}

function printResult(result: ExtractionResult): void {
  console.log(`\n=== ${result.supplier} ===`);
  console.log(
    `Total: ${result.summary.total} | Valid: ${result.summary.valid} | Invalid: ${result.summary.invalid}`
  );

  for (const product of result.products) {
    console.log(
      `  ${product.styleNumber}: ${product.title} (${product.variants.length} variants, ${product.images.length} images)`
    );
  }

  for (const error of result.validationErrors) {
    console.log(
      `  ${error.styleNumber}: INVALID - ${error.errors.join(', ')}`
    );
  }
}

async function main(): Promise<void> {
  const { supplier, style } = parseArgs();

  if (style && supplier) {
    // Single product extraction
    const adapter =
      supplier === 'canada-sportswear'
        ? new CanadaSportswearAdapter()
        : new SSCanadaAdapter();

    const product = await adapter.fetchProduct(style);
    const validation = validateProduct(product);

    console.log(`\n=== ${supplier} - Single Product ===`);
    if (validation.valid) {
      console.log(
        `  ${product.styleNumber}: ${product.title} (${product.variants.length} variants, ${product.images.length} images)`
      );
      console.log('  Validation: PASSED');
    } else {
      console.log(
        `  ${product.styleNumber}: INVALID - ${validation.errors.join(', ')}`
      );
      process.exit(1);
    }
    return;
  }

  let results: ExtractionResult[];

  if (supplier) {
    results = [await extractFromSupplier(supplier)];
  } else {
    results = await extractAll();
  }

  for (const result of results) {
    printResult(result);
  }

  const hasErrors = results.some((r) => r.summary.invalid > 0);
  if (hasErrors) {
    process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`Extraction failed: ${error.message}`);
  process.exit(1);
});
