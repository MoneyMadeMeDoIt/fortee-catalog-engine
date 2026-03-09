/**
 * CLI entry point for pushing products to Shopify (old store format).
 *
 * Usage:
 *   npx tsx scripts/push-product.ts <styleID>    # Push one product
 *   npx tsx scripts/push-product.ts --setup       # One-time: create metafield definitions
 *   npx tsx scripts/push-product.ts --help        # Show usage
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { pushProduct } from '../src/shopify/product-push.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { setupPrintAreaDefinitions } from '../src/shopify/metaobject-setup.js';

function showHelp(): void {
  console.log(`
Shopify Product Push CLI (Old Store Format)

Pushes products with Color x Size x # of Print Areas variants.
Supported categories: T-Shirt, Long Sleeve, Crewneck, Hoodie.
Unsupported categories (Cap, Beanie, Pants, etc.) are skipped.

Usage:
  npx tsx scripts/push-product.ts <styleID>    Push one product to Shopify
  npx tsx scripts/push-product.ts --setup      One-time store setup (creates metafield definitions)
  npx tsx scripts/push-product.ts --help       Show this help message

Environment variables required:
  SHOPIFY_STORE_DOMAIN          Your Shopify store domain (e.g., my-store.myshopify.com)
  SHOPIFY_ADMIN_ACCESS_TOKEN    Admin API access token with write_products scope
  GOOGLE_SHEET_ID               Google Sheet ID (from the sheet URL)
  GOOGLE_APPLICATION_CREDENTIALS  Path to service account JSON key file

Examples:
  npx tsx scripts/push-product.ts ST100
  npx tsx scripts/push-product.ts --setup
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      setup: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.setup) {
    console.log('Running one-time Shopify store setup...');
    const client = createShopifyClient();
    await setupPrintAreaDefinitions(client);
    console.log('Setup complete. You can now push products.');
    process.exit(0);
  }

  const styleID = positionals[0];
  if (!styleID) {
    console.error('Error: styleID is required. Run with --help for usage.');
    process.exit(1);
  }

  try {
    console.log(`Pushing product for styleID: ${styleID}...`);
    const result = await pushProduct(styleID);
    console.log(
      `Product created: ${result.productGid}, ${result.variantCount} variants`,
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Missing SHOPIFY_')) {
        console.error(`Configuration error: ${error.message}`);
        console.error('Set the required environment variables in your .env file.');
      } else if (error.message.includes('Unsupported category')) {
        console.error(`Category error: ${error.message}`);
      } else if (error.message.includes('productSet errors')) {
        console.error(`Shopify API error:\n${error.message}`);
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        console.error(`Network error: ${error.message}`);
        console.error('Check your internet connection and try again.');
      } else {
        console.error(`Error: ${error.message}`);
      }
    } else {
      console.error('Unexpected error:', error);
    }
    process.exit(1);
  }
}

main();
