/**
 * Calibration script for the image quality scorer.
 *
 * Fetches product images from Shopify, runs each through scoreImageQuality(),
 * and outputs a tab-separated report to stdout.
 *
 * Usage:
 *   npx tsx scripts/calibrate-scorer.ts > calibration-report.tsv
 *
 * The summary footer is written to stderr so it doesn't pollute the TSV.
 */
import 'dotenv/config';
import { createShopifyClient } from '../src/shopify/client.js';
import { scoreImageQuality } from '../src/shopify/image-scorer.js';
import { downloadImage } from '../src/shopify/image-standardizer.js';

// ---------------------------------------------------------------------------
// GraphQL query — fetch products with media images
// ---------------------------------------------------------------------------

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 20, after: $cursor) {
      edges {
        node {
          id
          title
          media(first: 5) {
            edges {
              node {
                ... on MediaImage {
                  image {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaImage {
  image?: {
    url: string;
    altText: string | null;
  };
}

interface ProductNode {
  id: string;
  title: string;
  media: {
    edges: Array<{ node: MediaImage }>;
  };
}

interface ProductsPage {
  data?: {
    products?: {
      edges: Array<{ node: ProductNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

// ---------------------------------------------------------------------------
// Image collection — paginate up to 3 pages (60 products) to gather 50+ images
// ---------------------------------------------------------------------------

interface ImageEntry {
  productTitle: string;
  altText: string;
  url: string;
}

async function collectImages(client: Awaited<ReturnType<typeof createShopifyClient>>): Promise<ImageEntry[]> {
  const images: ImageEntry[] = [];
  let cursor: string | null = null;
  let page = 0;
  const MAX_PAGES = 3;

  while (page < MAX_PAGES) {
    const result = (await client.request(PRODUCTS_QUERY, {
      variables: { cursor },
    })) as ProductsPage;

    const productsData = result.data?.products;
    if (!productsData) break;

    for (const { node: product } of productsData.edges) {
      for (const { node: mediaNode } of product.media.edges) {
        if (mediaNode.image?.url) {
          images.push({
            productTitle: product.title,
            altText: mediaNode.image.altText ?? '',
            url: mediaNode.image.url,
          });
        }
      }
    }

    if (!productsData.pageInfo.hasNextPage) break;
    cursor = productsData.pageInfo.endCursor;
    page++;
  }

  return images;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = await createShopifyClient();

  process.stderr.write('Collecting product images from Shopify...\n');
  const images = await collectImages(client);
  process.stderr.write(`Found ${images.length} images across up to 3 pages of products.\n\n`);

  // TSV header
  console.log('product\talt\tscore\tverdict\treasons\tblur\tresolution\tproportion\tcontent');

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const entry of images) {
    try {
      const buffer = await downloadImage(entry.url);
      const result = await scoreImageQuality(buffer);

      const row = [
        entry.productTitle.replace(/\t/g, ' '),
        (entry.altText ?? '').replace(/\t/g, ' '),
        result.score,
        result.verdict,
        result.reasons.join('; ').replace(/\t/g, ' '),
        result.dimensions.blur,
        result.dimensions.resolution,
        result.dimensions.proportion,
        result.dimensions.content,
      ].join('\t');

      console.log(row);

      if (result.verdict === 'pass') {
        passCount++;
      } else {
        failCount++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        [
          entry.productTitle.replace(/\t/g, ' '),
          (entry.altText ?? '').replace(/\t/g, ' '),
          'ERROR',
          'error',
          message.replace(/\t/g, ' '),
          '',
          '',
          '',
          '',
        ].join('\t'),
      );
      errorCount++;
    }
  }

  // Summary footer to stderr — does not pollute TSV output
  const total = images.length;
  const scored = passCount + failCount;
  const failRate = scored > 0 ? ((failCount / scored) * 100).toFixed(1) : '0.0';
  const passRate = scored > 0 ? ((passCount / scored) * 100).toFixed(1) : '0.0';

  process.stderr.write('\n=== Calibration Summary ===\n');
  process.stderr.write(`Total images: ${total}\n`);
  process.stderr.write(`Scored: ${scored}\n`);
  process.stderr.write(`Pass: ${passCount} (${passRate}%)\n`);
  process.stderr.write(`Fail: ${failCount} (${failRate}%)\n`);
  if (errorCount > 0) {
    process.stderr.write(`Errors (skipped): ${errorCount}\n`);
  }
  process.stderr.write('\n');
  process.stderr.write('If fail rate is above 10-15%, review the TSV and tune QUALITY_THRESHOLDS in src/shopify/image-scorer.ts\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
