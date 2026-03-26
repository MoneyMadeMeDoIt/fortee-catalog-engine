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
import { buildPrompt, buildRetryPrompt, CLEANUP_PROMPT } from './prompt-templates.js';
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

    results.push({
      buffer,
      score: qualityResult.score,
      verdict: qualityResult.verdict,
      hue: candidateHue,
      drift,
      passesHue,
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
  costTracker: CostTracker,
  client?: OpenAI,
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

  let callCount = 0;
  let usedRetry = false;
  let totalCost = 0;
  const allCandidates: CandidateResult[] = [];

  // --- Round 1: initial generation ---
  const prompt = buildPrompt(garmentType, view, colorName);
  const round1Buffers = await callImagesEdit(openai, frontBuffer, prompt, CANDIDATES_PER_CALL);
  callCount++;
  costTracker.record(callCost);
  totalCost += callCost;

  const round1Candidates = await scoreCandidates(round1Buffers, frontHue, frontIsAchromatic, garmentType);
  allCandidates.push(...round1Candidates);

  // Find best hue-passing candidate from round 1
  const round1Passing = round1Candidates.filter(c => c.passesHue);
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
    const retryPrompt = buildRetryPrompt(garmentType, view, colorName);
    const round2Buffers = await callImagesEdit(openai, frontBuffer, retryPrompt, CANDIDATES_PER_CALL);
    callCount++;
    costTracker.record(callCost);
    totalCost += callCost;

    const round2Candidates = await scoreCandidates(round2Buffers, frontHue, frontIsAchromatic, garmentType);
    allCandidates.push(...round2Candidates);

    // Find best hue-passing candidate from retry round
    const round2Passing = round2Candidates.filter(c => c.passesHue);
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

  // --- D-04 fallback: all 6 candidates failed — return best-scoring regardless ---
  if (allCandidates.length === 0) {
    // All API calls failed with content policy or other issues — return null
    return null;
  }

  const bestOfAll = allCandidates.reduce((a, b) => (b.score > a.score ? b : a));
  logger.warn(
    `[ai-image-generator] All ${allCandidates.length} candidates failed hue check. Returning best-scoring (score=${bestOfAll.score}) per D-04.`,
  );

  return {
    buffer: bestOfAll.buffer,
    score: bestOfAll.score,
    verdict: bestOfAll.verdict,
    totalCost,
    callCount,
    usedRetry,
    hueDrift: bestOfAll.drift,
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
