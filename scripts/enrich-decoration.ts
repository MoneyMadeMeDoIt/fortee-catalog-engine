/**
 * CLI entry point for decoration enrichment.
 * Fills: embroideryAvailable, dtfAvailable, sellPrice1Area, sellPrice2Area, decorationPlacements
 *
 * Pricing: 1 area = cost*2+10, 2 areas = cost*2+16
 *
 * Usage:
 *   npx tsx scripts/enrich-decoration.ts              # Run enrichment
 *   npx tsx scripts/enrich-decoration.ts --dry-run    # Preview without writing
 *   npx tsx scripts/enrich-decoration.ts --help       # Show usage
 */
import 'dotenv/config';
import { enrichDecoration } from '../src/sheets/enrich-decoration.js';

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: npx tsx scripts/enrich-decoration.ts [options]

Options:
  --dry-run    Preview changes without writing to the sheet
  --help, -h   Show this help message

Pricing formulas:
  1 Decoration Area: costPrice * 2 + $10
  2 Decoration Areas: costPrice * 2 + $16

Fills columns:
  embroideryAvailable = "No" (old store is DTF only)
  dtfAvailable = "Yes"
  sellPrice1Area = costPrice * 2 + 10
  sellPrice2Area = costPrice * 2 + 16
  decorationPlacements = "Front, Back"`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');

  console.log('Starting decoration enrichment...');
  if (dryRun) console.log('  Mode: DRY RUN (no changes will be written)');
  console.log('  Pricing: 1 area = cost*2+$10, 2 areas = cost*2+$16');

  enrichDecoration({ dryRun })
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
