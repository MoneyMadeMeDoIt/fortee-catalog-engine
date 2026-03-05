/**
 * CLI entry point for sheet enrichment.
 * Reads the master product sheet, pulls supplier data, and fills empty cells.
 *
 * Usage:
 *   npx tsx scripts/enrich.ts                          # Enrich from all suppliers
 *   npx tsx scripts/enrich.ts --supplier canada-sportswear  # Single supplier
 *   npx tsx scripts/enrich.ts --dry-run                # Preview without writing
 *   npx tsx scripts/enrich.ts --help                   # Show usage
 */
import 'dotenv/config';
import { enrichSheet } from '../src/sheets/enrich.js';

type SupplierName = 'canada-sportswear' | 'ss-canada';

const VALID_SUPPLIERS: SupplierName[] = ['canada-sportswear', 'ss-canada'];

function parseArgs(): { supplier?: SupplierName; dryRun: boolean } {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: npx tsx scripts/enrich.ts [options]

Options:
  --supplier <name>   Enrich from a single supplier (canada-sportswear | ss-canada)
  --dry-run           Preview changes without writing to the sheet
  --help, -h          Show this help message

Environment variables required:
  GOOGLE_SERVICE_ACCOUNT_EMAIL  GCP service account email
  GOOGLE_PRIVATE_KEY            Private key from GCP service account JSON
  GOOGLE_SPREADSHEET_ID         Spreadsheet ID from the Google Sheets URL
  GOOGLE_SHEET_NAME             Tab name (defaults to "Sheet1")

Examples:
  npx tsx scripts/enrich.ts                              # Enrich all suppliers
  npx tsx scripts/enrich.ts --supplier canada-sportswear # CSW only
  npx tsx scripts/enrich.ts --dry-run                    # Preview changes
  npx tsx scripts/enrich.ts --supplier ss-canada --dry-run`);
    process.exit(0);
  }

  let supplier: SupplierName | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--supplier' && args[i + 1]) {
      const value = args[i + 1] as SupplierName;
      if (!VALID_SUPPLIERS.includes(value)) {
        console.error(
          `Invalid supplier: ${value}. Valid options: ${VALID_SUPPLIERS.join(', ')}`,
        );
        process.exit(1);
      }
      supplier = value;
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
    }
  }

  return { supplier, dryRun };
}

async function main(): Promise<void> {
  const { supplier, dryRun } = parseArgs();

  console.log('Starting enrichment...');
  if (supplier) console.log(`  Supplier filter: ${supplier}`);
  if (dryRun) console.log('  Mode: DRY RUN (no changes will be written)');

  const report = await enrichSheet({ supplier, dryRun });

  console.log('\n=== Enrichment Summary ===');
  console.log(`  Rows scanned:    ${report.rowsScanned}`);
  console.log(`  Rows enriched:   ${report.rowsEnriched}`);
  console.log(`  Cells written:   ${report.cellsWritten}`);
  console.log(`  Skipped (no match): ${report.skippedNoMatch}`);

  if (report.errors.length > 0) {
    console.log(`  Errors: ${report.errors.length}`);
    for (const err of report.errors) {
      console.error(`    ${err.partId}: ${err.error}`);
    }
  }

  if (report.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`Enrichment failed: ${error.message}`);
  process.exit(1);
});
