/**
 * AI image generation functions for garment view synthesis (Phase 10).
 *
 * Implements generateGarmentView() and enhanceFrontImage() using OpenAI images.edit().
 * Covers AIGEN-01 through AIGEN-04 and decisions D-03 through D-08.
 *
 * Key behaviors:
 * - 3 candidates per API call (n=3); picks best hue-passing + highest-quality candidate
 * - Retries once with stronger prompt if all initial candidates fail hue/quality
 * - If all 6 candidates fail, returns best-scoring candidate regardless (D-04)
 * - Budget-checks before every API call; returns null if budget exhausted (D-07)
 * - Achromatic garments bypass hue check — accepted on quality score alone
 * - Content policy errors produce 0 candidates (not a throw)
 * - Input image resized to 1024x1024 PNG before sending to avoid 413 errors
 */

import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import {
  COST_PER_IMAGE,
  CANDIDATES_PER_CALL,
  HUE_DRIFT_THRESHOLD,
  type AIView,
  type GenerateViewResult,
  type EnhanceFrontResult,
} from './ai-image-types.js';
import { extractDominantHue, hueDrift } from './hue-utils.js';
import { type CostTracker } from './cost-tracker.js';
import { buildPrompt, buildRetryPrompt, buildPromptFromName, buildRetryPromptFromName, CLEANUP_PROMPT } from './prompt-templates.js';
import { appendRejectRow, getOrCreateRunId } from './rejects-tsv.js';

/**
 * Use OpenAI Vision to describe the garment in an image.
 * Returns a short description like "women's boxy cropped t-shirt" or "men's quarter-zip pullover".
 */
async function describeGarment(client: OpenAI, imageBuffer: Buffer): Promise<string> {
  try {
    const base64 = imageBuffer.toString('base64');
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What type of garment is this? Reply with ONLY a short description like "men\'s polo shirt", "women\'s boxy t-shirt", "unisex hoodie", "quarter-zip pullover", etc. No other text.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64}` },
            },
          ],
        },
      ],
    });
    const desc = response.choices[0]?.message?.content?.trim() ?? '';
    logger.info(`[ai-image-generator] Garment described as: "${desc}"`);
    return desc;
  } catch (err) {
    logger.warn(`[ai-image-generator] Vision describe failed: ${err}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Phase 15: Garment Type Verifier (D-01, D-02, D-03)
// ---------------------------------------------------------------------------

/**
 * Result from verifyGarmentTypeMatch(): does the candidate match the reference's garment family?
 * Phase 15 / R2.
 */
export interface VerifyGarmentTypeResult {
  match: boolean;
  reason: string;
}

/**
 * System prompt for the verifier. Verbatim from 15-RESEARCH.md Vision Prompt Design.
 * Asks gpt-4o-mini to compare two garment photos at the CategoryGroup (family) level (D-02).
 */
const VERIFIER_SYSTEM_PROMPT = `You are comparing two product photos of garments on white backgrounds.
The FIRST image is the reference (the source front view).
The SECOND image is a candidate (a generated back or side view).

Decide whether the two images depict the SAME GARMENT FAMILY.

Families (use exactly these labels):
- tops (t-shirts, tanks, short-sleeve casual)
- hoodies (any pullover or zip with a hood)
- polos (collared placket tops)
- crewnecks (round-neck sweatshirts, no hood)
- jackets (zip/snap outerwear, not hoodies)

Coarse match only:
- Long-sleeve vs short-sleeve = SAME family
- Boxy vs relaxed fit = SAME family
- Crewneck vs hoodie = DIFFERENT families (the bug we are catching)
- Hoodie vs jacket = DIFFERENT families
- Polo vs crewneck = DIFFERENT families

Respond with ONLY a JSON object on a single line:
{"match": true|false, "reason": "<short phrase, max 80 chars>"}

Examples of reasons:
- "both crewnecks"
- "front is crewneck, candidate is hoodie"
- "both hoodies"
- "front is polo, candidate is t-shirt"`;

/**
 * Phase 15 / R2: Verify that a generated candidate image depicts the same garment family
 * as the reference front image. Uses gpt-4o-mini Vision in a single side-by-side call (D-01).
 *
 * NOTE: verifier calls bypass CostTracker per SPEC R5 — do NOT pass costTracker here.
 *
 * Error policy (per CONTEXT specifics + RESEARCH Pitfall 1): on Vision/parse failure,
 * return `{ match: true, reason: 'verifier ... fallback' }` — never false-reject when
 * the verifier itself broke. Cost of a false-accept is one wrong image; cost of false-
 * reject is wasted generation budget.
 *
 * @param client OpenAI client (DI seam for tests).
 * @param generatedBuffer Candidate image (back or side) to verify.
 * @param frontBuffer Reference front image.
 * @returns `{ match, reason }` where match=true means same garment family.
 */
export async function verifyGarmentTypeMatch(
  client: OpenAI,
  generatedBuffer: Buffer,
  frontBuffer: Buffer,
): Promise<VerifyGarmentTypeResult> {
  try {
    const frontB64 = frontBuffer.toString('base64');
    const genB64 = generatedBuffer.toString('base64');

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VERIFIER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reference (source front):' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${frontB64}`, detail: 'low' } },
            { type: 'text', text: 'Candidate (generated view):' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${genB64}`, detail: 'low' } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';

    // First try direct JSON.parse; on failure, regex-extract a {...} block from the raw text.
    let parsed: { match?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m === null) {
        logger.warn(`[ai-image-generator] verifyGarmentTypeMatch parse failed (no JSON object found in: ${raw.slice(0, 100)})`);
        return { match: true, reason: 'verifier parse error fallback' };
      }
      // If the regex-extracted block is itself unparseable, the throw falls through
      // to the outer catch which returns the api-error fallback shape.
      parsed = JSON.parse(m[0]);
    }

    return {
      match: parsed.match === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    };
  } catch (err) {
    logger.warn(`[ai-image-generator] verifyGarmentTypeMatch failed: ${err}`);
    return { match: true, reason: 'verifier api error fallback' };
  }
}

import { scoreImageQuality } from '../shopify/image-scorer.js';
import type { CategoryGroup } from '../shopify/types.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CandidateResult {
  buffer: Buffer;
  score: number;
  verdict: 'pass' | 'fail';
  hue: number;
  drift: number;
  passesHue: boolean;
  passesType: boolean;
  typeMatchReason: string;
}

// ---------------------------------------------------------------------------
// OpenAI client factory
// ---------------------------------------------------------------------------

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 600_000, // 10 minutes — gpt-image-1 can take 44–130s
  });
}

// ---------------------------------------------------------------------------
// Internal helper: resize + call images.edit()
// ---------------------------------------------------------------------------

/**
 * Resizes the input buffer to 1024x1024 PNG and calls images.edit().
 *
 * Returns empty array on content policy rejection (not a throw).
 * Re-throws all other errors (network, auth, rate limit).
 *
 * Do NOT pass response_format, input_fidelity, or output_format — all cause
 * BadRequestError on gpt-image-1's images.edit() endpoint (per research anti-patterns).
 */
async function callImagesEdit(
  client: OpenAI,
  inputBuffer: Buffer,
  prompt: string,
  n: number,
): Promise<Buffer[]> {
  // Resize to 1024x1024 to avoid 413 errors — practical API limit ~4MB
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
      // DO NOT pass: response_format, input_fidelity, output_format
    });

    // Handle partial results — some entries may be null on partial content policy blocks
    return response.data
      .filter(img => img.b64_json != null)
      .map(img => Buffer.from(img.b64_json!, 'base64'));
  } catch (err) {
    const isContentPolicy =
      err instanceof OpenAI.BadRequestError &&
      (err.message.includes('content_policy') || err.message.includes('safety'));

    if (isContentPolicy) {
      logger.warn(`[ai-image-generator] Content policy rejection: ${err.message}`);
      return []; // 0 candidates from this call
    }

    throw err; // re-throw network/auth/rate-limit errors
  }
}

// ---------------------------------------------------------------------------
// Internal helper: score and evaluate a set of candidate buffers
// ---------------------------------------------------------------------------

async function scoreCandidates(
  buffers: Buffer[],
  frontHue: number,
  frontIsAchromatic: boolean,
  garmentType: CategoryGroup,
  openai: OpenAI,
  frontBuffer: Buffer,
): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];

  for (const buffer of buffers) {
    const qualityResult = await scoreImageQuality(buffer, garmentType);

    let candidateHue = 0;
    let drift = 0;
    let passesHue = true;

    if (!frontIsAchromatic) {
      const dominantResult = await extractDominantHue(buffer);
      candidateHue = dominantResult.hue;
      drift = hueDrift(frontHue, candidateHue);
      passesHue = drift <= HUE_DRIFT_THRESHOLD;
    }

    // SPEC R1/R3: Per-candidate type-match check via Vision API.
    // NOTE: verifier calls bypass CostTracker per SPEC R5.
    const typeResult = await verifyGarmentTypeMatch(openai, buffer, frontBuffer);
    const passesType = typeResult.match;
    const typeMatchReason = typeResult.reason;

    results.push({
      buffer,
      score: qualityResult.score,
      verdict: qualityResult.verdict,
      hue: candidateHue,
      drift,
      passesHue,
      passesType,
      typeMatchReason,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API: generateGarmentView
// ---------------------------------------------------------------------------

/**
 * Generates a garment view (back or side) using OpenAI images.edit() from
 * a front image buffer.
 *
 * Algorithm:
 * 1. Pre-flight budget check (D-07). Returns null if budget exhausted.
 * 2. Extract front image dominant hue for color drift comparison (AIGEN-04).
 * 3. Call images.edit() with n=3 candidates (AIGEN-01/D-03).
 * 4. Score all candidates; filter by hue drift ≤ 15° (non-achromatic only).
 * 5. If any pass: return highest-quality passing candidate (AIGEN-02).
 * 6. If all fail: retry with stronger prompt once (D-04).
 * 7. If still all fail: return best-scoring candidate from all 6 (D-04 fallback).
 *
 * @param frontBuffer - Front view image as raw buffer
 * @param view - Target view: 'back' or 'side'
 * @param garmentType - Garment category for prompt template and quality scoring
 * @param colorName - Garment color name for prompt (D-02)
 * @param costTracker - Global budget tracker (D-07)
 * @param client - Optional OpenAI client (for testing dependency injection)
 * @returns GenerateViewResult or null if budget exhausted
 */
export async function generateGarmentView(
  frontBuffer: Buffer,
  view: AIView,
  garmentType: CategoryGroup,
  colorName: string,
  pid: string,
  costTracker: CostTracker,
  client?: OpenAI,
  productName?: string,
): Promise<GenerateViewResult | null> {
  const openai = client ?? createOpenAIClient();
  const callCost = CANDIDATES_PER_CALL * COST_PER_IMAGE;

  // D-07: Pre-flight budget check
  if (!costTracker.canAfford(callCost)) {
    logger.warn(
      `[ai-image-generator] Budget exhausted (remaining: $${costTracker.remaining.toFixed(4)}). Skipping generation.`,
    );
    return null;
  }

  // Extract front image dominant hue for color drift comparison
  const frontDominant = await extractDominantHue(frontBuffer);
  const frontHue = frontDominant.hue;
  const frontIsAchromatic = frontDominant.achromatic;

  // Use Vision API to describe the actual garment in the front image
  // This prevents generating the wrong garment type (e.g., hoodie for a t-shirt)
  let garmentDesc = productName || '';
  if (!garmentDesc) {
    garmentDesc = await describeGarment(openai, frontBuffer);
  }

  let callCount = 0;
  let usedRetry = false;
  let totalCost = 0;
  const allCandidates: CandidateResult[] = [];

  // --- Round 1: initial generation ---
  const prompt = garmentDesc
    ? buildPromptFromName(garmentDesc, view, colorName)
    : buildPrompt(garmentType, view, colorName);
  const round1Buffers = await callImagesEdit(openai, frontBuffer, prompt, CANDIDATES_PER_CALL);
  callCount++;
  costTracker.record(callCost);
  totalCost += callCost;

  const round1Candidates = await scoreCandidates(round1Buffers, frontHue, frontIsAchromatic, garmentType, openai, frontBuffer);
  allCandidates.push(...round1Candidates);

  // Find best candidate passing BOTH hue AND type-match from round 1 (SPEC R3 strict AND).
  const round1Passing = round1Candidates.filter(c => c.passesHue && c.passesType);
  if (round1Passing.length > 0) {
    const best = round1Passing.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      buffer: best.buffer,
      score: best.score,
      verdict: best.verdict,
      totalCost,
      callCount,
      usedRetry,
      hueDrift: best.drift,
    };
  }

  // --- Round 2: retry with stronger prompt ---
  usedRetry = true;

  // Budget check for retry
  if (costTracker.canAfford(callCost)) {
    const retryPrompt = garmentDesc
      ? buildRetryPromptFromName(garmentDesc, view, colorName)
      : buildRetryPrompt(garmentType, view, colorName);
    const round2Buffers = await callImagesEdit(openai, frontBuffer, retryPrompt, CANDIDATES_PER_CALL);
    callCount++;
    costTracker.record(callCost);
    totalCost += callCost;

    const round2Candidates = await scoreCandidates(round2Buffers, frontHue, frontIsAchromatic, garmentType, openai, frontBuffer);
    allCandidates.push(...round2Candidates);

    // Find best candidate passing BOTH hue AND type-match from retry round (SPEC R3 strict AND).
    const round2Passing = round2Candidates.filter(c => c.passesHue && c.passesType);
    if (round2Passing.length > 0) {
      const best = round2Passing.reduce((a, b) => (b.score > a.score ? b : a));
      return {
        buffer: best.buffer,
        score: best.score,
        verdict: best.verdict,
        totalCost,
        callCount,
        usedRetry,
        hueDrift: best.drift,
      };
    }
  }

  // --- D-04 fallback: all 6 candidates failed hue — but Phase 15 inserts a
  //     type-match gate first per SPEC R4.
  if (allCandidates.length === 0) {
    // All API calls failed with content policy or other issues — return null
    return null;
  }

  // SPEC R4: If every candidate failed type-match, skip the view + log to
  // rejects TSV. No D-04 hue-fallback is allowed to return a wrong-shape image.
  const typePassing = allCandidates.filter(c => c.passesType);
  if (typePassing.length === 0) {
    const reason = allCandidates[0]?.typeMatchReason ?? 'unknown';
    logger.warn(
      `[ai-image-generator] All ${allCandidates.length} candidates failed type-match for ${pid}/${view}. Returning null.`,
    );
    await appendRejectRow({
      pid,
      view,
      reason,
      timestamp: new Date().toISOString(),
      run_id: getOrCreateRunId(),
    });
    return null;
  }

  // D-04 hue-fallback (unchanged behavior) but constrained to type-passing
  // candidates only — we never return a wrong-shape image.
  const bestOfTypePassing = typePassing.reduce((a, b) => (b.score > a.score ? b : a));
  logger.warn(
    `[ai-image-generator] All ${allCandidates.length} candidates failed hue check; returning best type-passing (score=${bestOfTypePassing.score}) per D-04 (constrained to typePassing).`,
  );

  return {
    buffer: bestOfTypePassing.buffer,
    score: bestOfTypePassing.score,
    verdict: bestOfTypePassing.verdict,
    totalCost,
    callCount,
    usedRetry,
    hueDrift: bestOfTypePassing.drift,
  };
}

// ---------------------------------------------------------------------------
// Public API: enhanceFrontImage
// ---------------------------------------------------------------------------

/**
 * AI-enhances a failing front image via images.edit() with the cleanup prompt (D-05).
 *
 * Uses the real front image as input — does not generate from scratch.
 * Applies cleanup prompt to remove blur, fix lighting, ensure white background.
 *
 * @param frontBuffer - Failing front image to enhance
 * @param costTracker - Global budget tracker (D-07)
 * @param garmentType - Optional garment category for quality scoring context
 * @param client - Optional OpenAI client (for testing dependency injection)
 * @returns EnhanceFrontResult or null if budget exhausted
 */
export async function enhanceFrontImage(
  frontBuffer: Buffer,
  costTracker: CostTracker,
  garmentType?: CategoryGroup,
  client?: OpenAI,
): Promise<EnhanceFrontResult | null> {
  const openai = client ?? createOpenAIClient();
  const cost = 1 * COST_PER_IMAGE;

  // D-07: Budget check
  if (!costTracker.canAfford(cost)) {
    logger.warn(
      `[ai-image-generator] Budget exhausted for front enhancement (remaining: $${costTracker.remaining.toFixed(4)}).`,
    );
    return null;
  }

  const [enhancedBuffer] = await callImagesEdit(openai, frontBuffer, CLEANUP_PROMPT, 1);

  if (!enhancedBuffer) {
    // Content policy or empty result
    logger.warn('[ai-image-generator] Front enhancement returned no buffer (content policy or empty).');
    costTracker.record(cost); // cost was incurred even if content-rejected
    return null;
  }

  costTracker.record(cost);

  const qualityResult = await scoreImageQuality(enhancedBuffer, garmentType);

  return {
    buffer: enhancedBuffer,
    score: qualityResult.score,
    verdict: qualityResult.verdict,
    cost,
  };
}
