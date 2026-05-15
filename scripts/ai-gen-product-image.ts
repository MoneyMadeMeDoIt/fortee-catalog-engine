/**
 * Generate a single AI image for a product, standardize it, and upload it to
 * Drive under the existing supplier/pid folder so the operator can review it
 * alongside the catalog's other images.
 *
 * Calls OpenAI `images.edit` with the gpt-image-1 model (same path as
 * Phase 10's generateGarmentView but without the multi-candidate +
 * verifier-rejection scaffold — for one-off operator-driven generations
 * where the operator inspects the result manually).
 *
 * Naming: `ai_<pid>_<color>_<column>.png` (or `--no-standardize` for the raw
 * 1024x1024 model output before sharp resizing).
 *
 * Run:
 *   NODE_OPTIONS=--use-system-ca npx tsx scripts/ai-gen-product-image.ts \
 *     --pid 1540 \
 *     --color Turquoise \
 *     --column DirectSideImage \
 *     --reference "C:\\path\\to\\front.png" \
 *     --prompt "generate a direct left side view of this Turquoise ..."
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { createDriveClient, uploadToDrive } from '../src/sheets/drive.js';
import { standardizeImage } from '../src/shopify/image-standardizer.js';
import { logger } from '../src/lib/logger.js';
import type { CategoryGroup } from '../src/shopify/types.js';

interface CliArgs {
  pid: string;
  color: string;
  column: string;
  reference: string;
  prompt: string;
  supplier: string;
  category: CategoryGroup;
  standardize: boolean;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      color: { type: 'string' },
      column: { type: 'string' },
      reference: { type: 'string' },
      prompt: { type: 'string' },
      supplier: { type: 'string' },
      category: { type: 'string' },
      'no-standardize': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Generate ONE AI image for a product, standardize it, and upload to Drive.

Required:
  --pid <id>          Product ID (e.g., 1540)
  --color <name>      Color name (used in filename; should match BR colorName)
  --column <name>     BR column name (FrontImage, BackImage, DirectSideImage,
                      ModelFrontImage, ModelSideImage, ModelBackImage)
  --reference <path>  Local path to reference PNG/JPG (typically the front view)
  --prompt <text>     OpenAI prompt for the gpt-image-1 edit call

Optional:
  --supplier <code>   Drive supplier folder (default: SSCANADA)
  --category <name>   CategoryGroup for standardizer:
                      tops | hoodies | polos | crewnecks | jackets
                      (default: tops)
  --no-standardize    Skip Phase 11 standardization; upload raw 1024x1024 from
                      the model (rarely useful — most catalog cells expect
                      2000x2000)
  -h, --help          Show this help
`);
    process.exit(0);
  }

  const required = ['pid', 'color', 'column', 'reference', 'prompt'] as const;
  for (const k of required) {
    if (!values[k]) {
      console.error(`Missing required flag: --${k}`);
      process.exit(2);
    }
  }
  return {
    pid: values.pid as string,
    color: values.color as string,
    column: values.column as string,
    reference: values.reference as string,
    prompt: values.prompt as string,
    supplier: (values.supplier as string | undefined) ?? 'SSCANADA',
    category: ((values.category as string | undefined) ?? 'tops') as CategoryGroup,
    standardize: values['no-standardize'] !== true,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const envMissing = [
    'OPENAI_API_KEY',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ].filter((k) => !process.env[k]);
  if (envMissing.length > 0) {
    console.error(`Missing env vars: ${envMissing.join(', ')}`);
    process.exit(1);
  }

  console.log(`[ai-gen] pid=${args.pid} color=${args.color} column=${args.column}`);
  console.log(`[ai-gen] reference=${args.reference}`);
  console.log(`[ai-gen] prompt="${args.prompt}"`);

  const refBuf = readFileSync(args.reference);

  // gpt-image-1 wants 1024x1024 (per Phase 10 pattern in ai-image-generator.ts).
  const resized = await sharp(refBuf)
    .resize(1024, 1024, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 600_000,
  });

  console.log('[ai-gen] calling OpenAI images.edit (gpt-image-1, ~30-120s)...');
  const start = Date.now();
  let aiBuf: Buffer;
  try {
    const response = await openai.images.edit({
      model: 'gpt-image-1',
      image: await toFile(resized, 'input.png', { type: 'image/png' }),
      prompt: args.prompt,
      n: 1,
      size: '1024x1024' as const,
      quality: 'medium' as const,
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      console.error('[ai-gen] OpenAI returned no image data');
      process.exit(3);
    }
    aiBuf = Buffer.from(b64, 'base64');
  } catch (err) {
    console.error(`[ai-gen] OpenAI images.edit failed: ${err}`);
    process.exit(3);
  }
  console.log(`[ai-gen] received ${aiBuf.length} bytes in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  let toUpload = aiBuf;
  if (args.standardize) {
    console.log(`[ai-gen] standardizing (category=${args.category})...`);
    const { buffer } = await standardizeImage(aiBuf, args.category);
    toUpload = buffer;
    console.log(`[ai-gen] standardized to ${toUpload.length} bytes`);
  }

  const filename = `ai_${args.pid}_${args.color}_${args.column}.png`;
  console.log(`[ai-gen] uploading to Drive: ${args.supplier}/${args.pid}/${filename}`);

  const drive = createDriveClient();
  const url = await uploadToDrive(drive, toUpload, filename, args.supplier, args.pid);

  console.log('');
  console.log('===== AI GEN COMPLETE =====');
  console.log(`  Drive URL: ${url}`);
  console.log(`  Filename:  ${filename}`);
  console.log(`  Path:      ${args.supplier}/${args.pid}/`);
}

main().catch((err) => {
  logger.error(`[ai-gen] FAILED: ${err}`);
  process.exit(1);
});
