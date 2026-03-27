import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createDriveClient } from '../src/sheets/drive.js';
import { createSheetsClient } from '../src/sheets/client.js';
import { readAllRows } from '../src/sheets/reader.js';
import { auditProductImages } from '../src/lib/audit-runner.js';
import type { AuditResult } from '../src/lib/audit-runner.js';
import { CostTracker } from '../src/lib/cost-tracker.js';
import type { SheetRow } from '../src/sheets/types.js';
import type { sheets_v4, drive_v3 } from 'googleapis';

// ---------------------------------------------------------------------------
// Types for dependency injection (enables unit testing)
// ---------------------------------------------------------------------------

export interface RunAuditArgs {
  styleId?: string;
  all: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface RunAuditDeps {
  args: RunAuditArgs;
  driveClient: unknown;
  sheetsClient: unknown;
  readAllRowsFn: typeof readAllRows;
  auditFn: typeof auditProductImages;
  costTracker: CostTracker;
  spreadsheetId: string;
  sheetName: string;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Image Audit CLI — Fortee Catalog Engine v2.0

Audits product images: scores quality, sources missing views, generates
AI replacements, standardizes dimensions, and writes CDN URLs to Google Sheets.

Usage:
  npx tsx scripts/audit-images.ts --style-id <ID>   Audit one product (all color rows)
  npx tsx scripts/audit-images.ts --all              Audit every product in the sheet
  npx tsx scripts/audit-images.ts --dry-run --all    List products without processing
  npx tsx scripts/audit-images.ts --help             Show this help message

Flags:
  --style-id <ID>   Style ID to audit (e.g., CSW-12345). Processes all color rows.
  --all             Audit every row in the sheet.
  --dry-run         List target products without calling the audit pipeline.
  --help, -h        Show this help message.

Environment variables required:
  GOOGLE_SERVICE_ACCOUNT_EMAIL   GCP service account email
  GOOGLE_PRIVATE_KEY             GCP service account private key
  GOOGLE_SPREADSHEET_ID          Google Spreadsheet ID
  GOOGLE_SHEET_NAME              Sheet tab name (default: Sheet1)
`);
}

// ---------------------------------------------------------------------------
// Result printer
// ---------------------------------------------------------------------------

function printResult(result: AuditResult): void {
  const status = result.error ? 'ERROR' : 'OK';
  console.log(`\n  [${status}] ${result.styleId} / ${result.colorName}`);

  if (result.error) {
    console.log(`    Error: ${result.error}`);
    return;
  }

  for (const v of result.views) {
    const scoreStr = v.score !== null ? `score=${v.score}` : 'no-score';
    const urlStr = v.cdnUrl ? 'uploaded' : 'no-upload';
    const reasonStr = v.reason ? ` (${v.reason})` : '';
    console.log(`    ${v.view}: ${v.status} ${scoreStr} ${urlStr}${reasonStr}`);
  }

  console.log(`    Cells written: ${result.cellsWritten}, AI cost: $${result.aiCostIncurred.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing with dependency injection)
// ---------------------------------------------------------------------------

export async function runAudit(deps: RunAuditDeps): Promise<void> {
  const { args, driveClient, sheetsClient, readAllRowsFn, auditFn, costTracker, spreadsheetId, sheetName } = deps;

  // Validate flags
  if (!args.styleId && !args.all) {
    throw new Error('Either --style-id or --all is required. Run with --help for usage.');
  }

  // Read all rows from sheet
  const { rows } = await readAllRowsFn(
    sheetsClient as sheets_v4.Sheets,
    spreadsheetId,
    sheetName,
  );

  // Determine target rows with their original indices
  let targets: Array<{ row: SheetRow; index: number }>;

  if (args.styleId) {
    const styleId = args.styleId.trim();
    targets = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.styleID.trim() === styleId);

    if (targets.length === 0) {
      throw new Error(`No rows found for style ID "${args.styleId}". Check the ID and try again.`);
    }
  } else {
    // --all: process every row
    targets = rows.map((row, index) => ({ row, index }));
  }

  // Dry-run: log target rows and exit
  if (args.dryRun) {
    console.log(`\nDry run — ${targets.length} products would be processed:\n`);
    for (const { row, index } of targets) {
      console.log(`  [${index}] ${row.styleID} / ${row.colorName} — ${row.baseCategory}`);
    }
    console.log(`\nTotal: ${targets.length} products`);
    return;
  }

  // Process each target row
  const results: AuditResult[] = [];

  console.log(`\nProcessing ${targets.length} products...\n`);

  for (const { row, index } of targets) {
    console.log(`Auditing ${row.styleID} / ${row.colorName} (row ${index})...`);
    const result = await auditFn(
      row,
      index,
      driveClient as drive_v3.Drive,
      sheetsClient as sheets_v4.Sheets,
      spreadsheetId,
      sheetName,
      costTracker,
    );
    results.push(result);
    printResult(result);
  }

  // Print summary
  const totalProducts = results.length;
  const errorCount = results.filter(r => r.error).length;
  const totalCells = results.reduce((sum, r) => sum + r.cellsWritten, 0);
  const totalAiCost = results.reduce((sum, r) => sum + r.aiCostIncurred, 0);

  console.log('\n--- Summary ---');
  console.log(`  Products processed: ${totalProducts}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Total cells written: ${totalCells}`);
  console.log(`  AI cost incurred: $${totalAiCost.toFixed(3)}`);
  console.log(`  Budget remaining: $${costTracker.remaining.toFixed(2)}`);

  if (errorCount > 0) {
    throw new Error(`${errorCount} product(s) had errors. See output above.`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'style-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('Error: GOOGLE_SPREADSHEET_ID environment variable is required.');
    process.exit(1);
  }

  const sheetName = process.env.GOOGLE_SHEET_NAME ?? 'Sheet1';
  const driveClient = createDriveClient();
  const sheetsClient = createSheetsClient();
  const costTracker = new CostTracker();

  try {
    await runAudit({
      args: {
        styleId: values['style-id'],
        all: values.all ?? false,
        dryRun: values['dry-run'] ?? false,
        help: false,
      },
      driveClient,
      sheetsClient,
      readAllRowsFn: readAllRows,
      auditFn: auditProductImages,
      costTracker,
      spreadsheetId,
      sheetName,
    });
  } catch (err) {
    console.error(`\nFatal: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests)
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('audit-images');
if (isDirectRun) {
  main();
}
