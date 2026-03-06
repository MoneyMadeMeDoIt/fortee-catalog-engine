/**
 * CLI entry point for decoration enrichment.
 * Reads the master product sheet, resolves decoration rules, calculates pricing,
 * and fills empty decoration/pricing cells.
 *
 * Usage:
 *   npx tsx scripts/enrich-decoration.ts                    # Run with default 45% discount
 *   npx tsx scripts/enrich-decoration.ts --dry-run          # Preview without writing
 *   npx tsx scripts/enrich-decoration.ts --discount 0.40    # Use 40% discount
 *   npx tsx scripts/enrich-decoration.ts --help             # Show usage
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { enrichDecoration } from '../src/sheets/enrich-decoration.js';

function main(): void {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      discount: { type: 'string', default: '0.45' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: npx tsx scripts/enrich-decoration.ts [options]

Options:
  --dry-run           Preview changes without writing to the sheet
  --discount <value>  Discount percentage as decimal (default: 0.45 = 45%)
  --help              Show this help message

Environment variables required:
  GOOGLE_SERVICE_ACCOUNT_EMAIL  GCP service account email
  GOOGLE_PRIVATE_KEY            Private key from GCP service account JSON
  GOOGLE_SPREADSHEET_ID         Spreadsheet ID from the Google Sheets URL
  GOOGLE_SHEET_NAME             Tab name (defaults to "Sheet1")

Examples:
  npx tsx scripts/enrich-decoration.ts                    # Run with default 45% discount
  npx tsx scripts/enrich-decoration.ts --dry-run          # Preview without writing
  npx tsx scripts/enrich-decoration.ts --discount 0.40    # Use 40% discount`);
    process.exit(0);
  }

  const discountPercent = parseFloat(values.discount!);
  if (isNaN(discountPercent) || discountPercent < 0 || discountPercent > 1) {
    console.error(`Invalid --discount value: ${values.discount}`);
    console.error('Must be a number between 0 and 1 (e.g., 0.45 for 45%)');
    process.exit(1);
  }

  const dryRun = values['dry-run'] ?? false;

  console.log('Starting decoration enrichment...');
  if (dryRun) console.log('  Mode: DRY RUN (no changes will be written)');
  console.log(`  Discount: ${(discountPercent * 100).toFixed(0)}%`);

  enrichDecoration({ dryRun, discountPercent })
    .then((report) => {
      console.log('\n=== Decoration Enrichment Summary ===');
      console.log(`  Rows scanned:       ${report.rowsScanned}`);
      console.log(`  Rows enriched:      ${report.rowsEnriched}`);
      console.log(`  Cells written:      ${report.cellsWritten}`);
      console.log(`  Skipped (no match): ${report.skippedNoMatch}`);

      if (report.errors.length > 0) {
        console.log(`  Errors: ${report.errors.length}`);
        for (const err of report.errors) {
          console.error(`    ${err.partId}: ${err.error}`);
        }
        process.exit(1);
      }
    })
    .catch((error: Error) => {
      console.error(`Decoration enrichment failed: ${error.message}`);
      process.exit(1);
    });
}

main();
