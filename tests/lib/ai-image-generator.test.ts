/**
 * Tests for ai-image-generator.ts — generateGarmentView() and enhanceFrontImage().
 *
 * All OpenAI API calls are mocked. No real network calls made.
 * Covers AIGEN-01 through AIGEN-04 and D-04, D-07 decisions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostTracker } from '../../src/lib/cost-tracker.js';
import {
  COST_PER_IMAGE,
  CANDIDATES_PER_CALL,
} from '../../src/lib/ai-image-types.js';

// ---------------------------------------------------------------------------
// Mock: openai module
// ---------------------------------------------------------------------------

const mockImagesEdit = vi.fn();

vi.mock('openai', () => {
  class BadRequestError extends Error {
    status: number;
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestError';
      this.status = 400;
    }
  }

  // Must be a class (constructor function) so `new OpenAI(...)` works
  class OpenAI {
    images = { edit: mockImagesEdit };
    static BadRequestError = BadRequestError;
  }

  return {
    default: OpenAI,
    toFile: vi.fn().mockResolvedValue({ name: 'input.png', type: 'image/png' }),
  };
});

// ---------------------------------------------------------------------------
// Mock: scoreImageQuality
// ---------------------------------------------------------------------------

const mockScoreImageQuality = vi.fn();

vi.mock('../../src/shopify/image-scorer.js', () => ({
  scoreImageQuality: mockScoreImageQuality,
}));

// ---------------------------------------------------------------------------
// Mock: extractDominantHue
// ---------------------------------------------------------------------------

const mockExtractDominantHue = vi.fn();

vi.mock('../../src/lib/hue-utils.js', () => ({
  extractDominantHue: mockExtractDominantHue,
  hueDrift: vi.fn().mockImplementation((h1: number, h2: number) => {
    const diff = Math.abs(h1 - h2);
    return Math.min(diff, 360 - diff);
  }),
  isAchromatic: vi.fn().mockReturnValue(false),
  rgbToHue: vi.fn().mockReturnValue(200),
}));

// ---------------------------------------------------------------------------
// Mock: sharp (resize before API call)
// ---------------------------------------------------------------------------

vi.mock('sharp', () => {
  const sharpInstance = {
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-png')),
  };
  return {
    default: vi.fn().mockReturnValue(sharpInstance),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeBuffer(label: string): Buffer {
  return Buffer.from(`fake-image-${label}`, 'utf8');
}

function makeEditResponse(buffers: Buffer[]) {
  return {
    data: buffers.map(b => ({
      b64_json: b.toString('base64'),
    })),
  };
}

function makeQualityResult(score: number, verdict: 'pass' | 'fail' = score >= 70 ? 'pass' : 'fail') {
  return {
    score,
    verdict,
    reasons: verdict === 'fail' ? ['mock fail reason'] : [],
    dimensions: { blur: score, resolution: score, proportion: score, content: score },
  };
}

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

let generateGarmentView: typeof import('../../src/lib/ai-image-generator.js').generateGarmentView;
let enhanceFrontImage: typeof import('../../src/lib/ai-image-generator.js').enhanceFrontImage;

beforeEach(async () => {
  vi.clearAllMocks();
  // Restore hueDrift implementation after clearAllMocks (clearAllMocks only clears call
  // history — not implementation — but in some vitest versions it may affect mockImplementation)
  const { hueDrift: realHueDrift } = await import('../../src/lib/hue-utils.js');
  (realHueDrift as ReturnType<typeof vi.fn>).mockImplementation((h1: number, h2: number) => {
    const diff = Math.abs(h1 - h2);
    return Math.min(diff, 360 - diff);
  });

  const mod = await import('../../src/lib/ai-image-generator.js');
  generateGarmentView = mod.generateGarmentView;
  enhanceFrontImage = mod.enhanceFrontImage;
});

// ---------------------------------------------------------------------------
// AIGEN-01: Basic generation — returns buffer with score
// ---------------------------------------------------------------------------

describe('generateGarmentView — AIGEN-01 basic generation', () => {
  it('returns buffer with score=80, callCount=1, usedRetry=false when first candidate passes', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    // Front hue = 200 (not achromatic)
    mockExtractDominantHue.mockResolvedValue({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } });

    // API returns 3 candidates
    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));

    // scoreImageQuality: all pass, first gets score=80
    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(80, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(70, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(60, 'pass'));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(80);
    expect(result!.callCount).toBe(1);
    expect(result!.usedRetry).toBe(false);
    expect(result!.verdict).toBe('pass');
    expect(mockImagesEdit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AIGEN-02a: Picks highest-scoring candidate
// ---------------------------------------------------------------------------

describe('generateGarmentView — AIGEN-02 highest-score selection', () => {
  it('returns the candidate with score=90 when candidates have scores 60, 90, 70', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    mockExtractDominantHue.mockResolvedValue({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } });
    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));

    // Scores: 60, 90, 70 — hue drift all within threshold (same hue returned)
    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(60, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(90, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(70, 'pass'));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// AIGEN-02b: Skips hue-failing candidates, picks highest among passing
// ---------------------------------------------------------------------------

describe('generateGarmentView — AIGEN-02 hue rejection', () => {
  it('skips candidate with drift=20 and returns candidate 3 (score=85) over candidate 2 (score=70)', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    // Front hue = 200
    // Candidate 1: hue = 225 → drift = 25 (FAIL)
    // Candidate 2: hue = 205 → drift = 5 (PASS)
    // Candidate 3: hue = 202 → drift = 2 (PASS)
    mockExtractDominantHue
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }) // front
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } }) // c1
      .mockResolvedValueOnce({ hue: 205, achromatic: false, rgb: { r: 0, g: 128, b: 205 } }) // c2
      .mockResolvedValueOnce({ hue: 202, achromatic: false, rgb: { r: 0, g: 128, b: 202 } }); // c3

    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));

    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(80, 'pass'))  // c1 - hue fails so irrelevant
      .mockResolvedValueOnce(makeQualityResult(70, 'pass'))  // c2
      .mockResolvedValueOnce(makeQualityResult(85, 'pass')); // c3

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(85);
  });
});

// ---------------------------------------------------------------------------
// AIGEN-04: Retry on all-fail
// ---------------------------------------------------------------------------

describe('generateGarmentView — AIGEN-04 retry on all-fail hue', () => {
  it('retries with stronger prompt when all 3 initial candidates fail hue; returns passing candidate from retry', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const initialCandidates = [makeFakeBuffer('i1'), makeFakeBuffer('i2'), makeFakeBuffer('i3')];
    const retryCandidates = [makeFakeBuffer('r1'), makeFakeBuffer('r2'), makeFakeBuffer('r3')];

    // Front hue = 200
    // Initial candidates: all drift=25 (FAIL hue)
    // Retry candidates: first passes drift=5, score=75
    mockExtractDominantHue
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }) // front
      // Initial round - all fail hue (drift 25)
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } })
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } })
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } })
      // Retry round - first passes (drift 5)
      .mockResolvedValueOnce({ hue: 205, achromatic: false, rgb: { r: 0, g: 128, b: 205 } })
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } })
      .mockResolvedValueOnce({ hue: 225, achromatic: false, rgb: { r: 0, g: 100, b: 225 } });

    mockImagesEdit
      .mockResolvedValueOnce(makeEditResponse(initialCandidates))
      .mockResolvedValueOnce(makeEditResponse(retryCandidates));

    // Initial: all get scores but hue-fail (doesn't matter which score)
    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(60, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(55, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(50, 'pass'))
      // Retry: first passes with score=75
      .mockResolvedValueOnce(makeQualityResult(75, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(50, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(45, 'pass'));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).not.toBeNull();
    expect(result!.usedRetry).toBe(true);
    expect(result!.callCount).toBe(2);
    expect(result!.score).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// D-04: Best-of-6 fallback — all 6 candidates fail hue
// ---------------------------------------------------------------------------

describe('generateGarmentView — D-04 best-of-6 fallback', () => {
  it('returns best-scoring candidate (score=65) from all 6 when all fail hue', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const initialCandidates = [makeFakeBuffer('i1'), makeFakeBuffer('i2'), makeFakeBuffer('i3')];
    const retryCandidates = [makeFakeBuffer('r1'), makeFakeBuffer('r2'), makeFakeBuffer('r3')];

    // Front hue = 200; all candidates have drift=30 (all fail)
    mockExtractDominantHue.mockResolvedValue({ hue: 230, achromatic: false, rgb: { r: 0, g: 100, b: 230 } });
    // Override front call to return 200
    mockExtractDominantHue
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } })
      // all 6 candidates have hue=230 → drift=30
      .mockResolvedValue({ hue: 230, achromatic: false, rgb: { r: 0, g: 100, b: 230 } });

    mockImagesEdit
      .mockResolvedValueOnce(makeEditResponse(initialCandidates))
      .mockResolvedValueOnce(makeEditResponse(retryCandidates));

    // Scores: 50, 55, 60, 65, 45, 40 — best is 65
    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(50))
      .mockResolvedValueOnce(makeQualityResult(55))
      .mockResolvedValueOnce(makeQualityResult(60))
      .mockResolvedValueOnce(makeQualityResult(65))
      .mockResolvedValueOnce(makeQualityResult(45))
      .mockResolvedValueOnce(makeQualityResult(40));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(65);
    expect(result!.usedRetry).toBe(true);
    expect(result!.callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D-07: Budget exhaustion — returns null without calling API
// ---------------------------------------------------------------------------

describe('generateGarmentView — D-07 budget exhaustion', () => {
  it('returns null and never calls images.edit when budget is insufficient', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(0.01); // too small for any call

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(result).toBeNull();
    expect(mockImagesEdit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Achromatic bypass — hue check skipped for achromatic front images
// ---------------------------------------------------------------------------

describe('generateGarmentView — achromatic bypass', () => {
  it('skips hue check for achromatic front image; returns best quality-scored candidate', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    // Front is achromatic (white/black/gray)
    // When front is achromatic, extractDominantHue is only called for the front image.
    // Candidate hue checks are skipped entirely — no extractDominantHue calls for candidates.
    mockExtractDominantHue
      .mockResolvedValueOnce({ hue: 0, achromatic: true, rgb: { r: 200, g: 200, b: 200 } }); // front only

    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));

    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(60, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(85, 'pass'))  // best
      .mockResolvedValueOnce(makeQualityResult(70, 'pass'));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'white', costTracker);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(85);
    expect(result!.callCount).toBe(1);
    expect(result!.usedRetry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Content policy error handling
// ---------------------------------------------------------------------------

describe('generateGarmentView — content policy error', () => {
  it('treats content policy rejection as 0 candidates; proceeds to retry; returns null if retry also fails', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    mockExtractDominantHue.mockResolvedValue({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } });

    // Both calls throw content policy error
    const { default: OpenAI } = await import('openai');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BadRequestError = (OpenAI as any).BadRequestError;
    mockImagesEdit.mockRejectedValue(new BadRequestError('content_policy violation'));

    const result = await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    // Both calls failed with content policy — should return null (no candidates at all)
    expect(result).toBeNull();
    expect(mockImagesEdit).toHaveBeenCalledTimes(2); // initial + retry (both fail)
  });
});

// ---------------------------------------------------------------------------
// AIGEN-03: enhanceFrontImage
// ---------------------------------------------------------------------------

describe('enhanceFrontImage — AIGEN-03', () => {
  it('calls images.edit with CLEANUP_PROMPT, n=1, and returns scored buffer', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const enhancedBuffer = makeFakeBuffer('enhanced');
    mockImagesEdit.mockResolvedValue(makeEditResponse([enhancedBuffer]));
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(75, 'pass'));

    const result = await enhanceFrontImage(frontBuffer, costTracker);

    expect(result).not.toBeNull();
    expect(result.score).toBe(75);
    expect(result.verdict).toBe('pass');
    expect(result.cost).toBeCloseTo(COST_PER_IMAGE * 1);

    // Verify n=1 was used
    expect(mockImagesEdit).toHaveBeenCalledTimes(1);
    const callArgs = mockImagesEdit.mock.calls[0][0];
    expect(callArgs.n).toBe(1);
  });

  it('returns null when budget is insufficient', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(0.01);

    const result = await enhanceFrontImage(frontBuffer, costTracker);

    // enhanceFrontImage should return null when budget is exhausted
    expect(result).toBeNull();
    expect(mockImagesEdit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cost tracking: verify record called with correct amount
// ---------------------------------------------------------------------------

describe('generateGarmentView — cost tracking', () => {
  it('records CANDIDATES_PER_CALL * COST_PER_IMAGE after a single successful call', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);
    const recordSpy = vi.spyOn(costTracker, 'record');

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    // Use mockResolvedValueOnce for all calls to avoid interference with prior mock state.
    // Pattern: 1 front call + 3 candidate calls = 4 total extractDominantHue calls.
    // All hue=200 → hueDrift(200, 200)=0 <= 15, all pass hue check.
    mockExtractDominantHue
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }) // front
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }) // c1
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }) // c2
      .mockResolvedValueOnce({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } }); // c3

    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));

    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(80, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(70, 'pass'))
      .mockResolvedValueOnce(makeQualityResult(60, 'pass'));

    await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(CANDIDATES_PER_CALL * COST_PER_IMAGE);
    // 3 * 0.042 = 0.126
    expect(recordSpy.mock.calls[0][0]).toBeCloseTo(0.126);
  });
});

// ---------------------------------------------------------------------------
// API parameters: verify no forbidden params passed to images.edit
// ---------------------------------------------------------------------------

describe('generateGarmentView — API parameters', () => {
  it('calls images.edit with ONLY: model, image, prompt, n, size, quality (no response_format/input_fidelity/output_format)', async () => {
    const frontBuffer = makeFakeBuffer('front');
    const costTracker = new CostTracker(200);

    const candidates = [makeFakeBuffer('c1'), makeFakeBuffer('c2'), makeFakeBuffer('c3')];

    mockExtractDominantHue.mockResolvedValue({ hue: 200, achromatic: false, rgb: { r: 0, g: 128, b: 200 } });
    mockImagesEdit.mockResolvedValue(makeEditResponse(candidates));
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(80, 'pass'));

    await generateGarmentView(frontBuffer, 'back', 'tops', 'navy blue', costTracker);

    const callArgs = mockImagesEdit.mock.calls[0][0];
    expect(callArgs).toHaveProperty('model', 'gpt-image-1');
    expect(callArgs).toHaveProperty('prompt');
    expect(callArgs).toHaveProperty('n', CANDIDATES_PER_CALL);
    expect(callArgs).toHaveProperty('size', '1024x1024');
    expect(callArgs).toHaveProperty('quality', 'medium');
    expect(callArgs).not.toHaveProperty('response_format');
    expect(callArgs).not.toHaveProperty('input_fidelity');
    expect(callArgs).not.toHaveProperty('output_format');
  });
});
