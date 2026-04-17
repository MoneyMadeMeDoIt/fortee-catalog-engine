/**
 * AI on-model image generation — places a garment on a photorealistic model
 * over a white background, given the garment's front image as reference.
 *
 * Standalone from ai-image-generator.ts (which targets garment-on-white views) —
 * the selection logic differs (no hue check, no garment-on-white quality scoring).
 *
 * CLI: `npx tsx src/lib/ai-model-image.ts <front-image-path> <gender>` for testing one image.
 */

import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { writeFileSync, readFileSync } from 'fs';
import { CostTracker, COST_PER_IMAGE } from './cost-tracker.js';
import { CANDIDATES_PER_CALL } from './ai-image-types.js';

export type ModelGender = 'women' | 'men' | 'youth' | 'unisex';

export interface GenerateModelImageResult {
  buffer: Buffer;
  cost: number;
  callCount: number;
  garmentDesc: string;
  modelDescriptor: string;
}

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 600_000,
  });
}

/** Map gender hint to natural-language model descriptor for the prompt. */
function modelDescriptorFor(gender: ModelGender): string {
  switch (gender) {
    case 'women': return 'adult woman';
    case 'men': return 'adult man';
    case 'youth': return 'young teenager';
    case 'unisex': return 'adult man';
  }
}

/** Vision-describe the garment so the prompt names the right item. */
async function describeGarment(client: OpenAI, imageBuffer: Buffer): Promise<string> {
  try {
    const base64 = imageBuffer.toString('base64');
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What type of garment is this? Reply with ONLY a short description like "men\'s polo shirt", "women\'s boxy t-shirt", "unisex hoodie", "quarter-zip pullover", etc. No other text.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    });
    return response.choices[0]?.message?.content?.trim() ?? '';
  } catch {
    return '';
  }
}

export function buildModelImagePrompt(garmentDesc: string, modelDescriptor: string): string {
  const subject = garmentDesc || 'garment';
  return `Generate a photorealistic product photoshoot of an ${modelDescriptor} model wearing this ${subject}. Plain white seamless studio background. The garment is the main subject — neutral pose, three-quarter to full body framing, soft even lighting, no props, no text, no watermark, no logos other than what is on the garment itself.`;
}

/** Resize input to 1024x1024 PNG and call images.edit with n candidates. */
async function callImagesEdit(client: OpenAI, inputBuffer: Buffer, prompt: string, n: number): Promise<Buffer[]> {
  const resized = await sharp(inputBuffer)
    .resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  try {
    const response = await client.images.edit({
      model: 'gpt-image-1',
      image: await toFile(resized, 'input.png', { type: 'image/png' }),
      prompt,
      n,
      size: '1024x1024' as const,
      quality: 'medium' as const,
    });
    return (response.data ?? [])
      .filter(img => img.b64_json != null)
      .map(img => Buffer.from(img.b64_json!, 'base64'));
  } catch (err) {
    if (err instanceof OpenAI.BadRequestError &&
        (err.message.includes('content_policy') || err.message.includes('safety'))) {
      return [];
    }
    throw err;
  }
}

/**
 * Generate a model image. Returns null if budget exhausted or all candidates rejected.
 *
 * Selection: returns the first candidate buffer. On-model shots vary widely — the
 * existing garment-on-white quality scorer would misjudge them, so we trust the
 * model output. Caller is responsible for human review when needed.
 */
export async function generateModelImage(
  frontBuffer: Buffer,
  gender: ModelGender,
  costTracker: CostTracker,
  client?: OpenAI,
): Promise<GenerateModelImageResult | null> {
  const openai = client ?? createOpenAIClient();
  const callCost = CANDIDATES_PER_CALL * COST_PER_IMAGE;

  if (!costTracker.canAfford(callCost)) return null;

  const garmentDesc = await describeGarment(openai, frontBuffer);
  const modelDescriptor = modelDescriptorFor(gender);
  const prompt = buildModelImagePrompt(garmentDesc, modelDescriptor);

  const buffers = await callImagesEdit(openai, frontBuffer, prompt, CANDIDATES_PER_CALL);
  costTracker.record(callCost);

  if (buffers.length === 0) return null;

  return {
    buffer: buffers[0],
    cost: callCost,
    callCount: 1,
    garmentDesc,
    modelDescriptor,
  };
}

async function main(): Promise<void> {
  const [, , imagePath, gender] = process.argv;
  if (!imagePath || !gender) {
    console.error('Usage: npx tsx src/lib/ai-model-image.ts <front-image-path> <women|men|youth|unisex>');
    process.exit(1);
  }
  if (!['women', 'men', 'youth', 'unisex'].includes(gender)) {
    console.error(`Invalid gender: ${gender}`);
    process.exit(1);
  }
  const front = readFileSync(imagePath);
  const tracker = new CostTracker(5);
  const result = await generateModelImage(front, gender as ModelGender, tracker);
  if (!result) {
    console.error('Generation failed (budget or content policy).');
    process.exit(1);
  }
  const outPath = imagePath.replace(/\.[^.]+$/, '') + `_model_${gender}.png`;
  writeFileSync(outPath, result.buffer);
  console.log(`Wrote ${outPath} (cost $${result.cost.toFixed(3)}, garment="${result.garmentDesc}", model=${result.modelDescriptor})`);
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });
