/**
 * Unit tests for verifySameProduct() — Phase 16 Plan 01 Task 2.
 *
 * All OpenAI Vision calls are mocked. No real network calls. No real API key
 * required. Sibling to Phase 15's verifyGarmentTypeMatch — same false-accept-on-
 * error policy (T-16-02), same gpt-4o-mini + json_object + detail:'low' shape,
 * but with the candidate-first prompt order (different from Phase 15's
 * reference-first).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

const mockLoggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

function makeClient(create: ReturnType<typeof vi.fn>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

const candidateBuffer = Buffer.from('candidate-png', 'utf8');
const referenceBuffer = Buffer.from('reference-png', 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test 1 — Happy match: candidate and reference depict the same product
// ---------------------------------------------------------------------------

describe('verifySameProduct — happy match', () => {
  it('returns { match: true, reason } when Vision returns match=true JSON', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      makeChatResponse('{"match":true,"reason":"same Bella 6110 t-shirt, different color"}'),
    );

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({
      match: true,
      reason: 'same Bella 6110 t-shirt, different color',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Mismatch: clearly different products
// ---------------------------------------------------------------------------

describe('verifySameProduct — mismatch flows through', () => {
  it('returns { match: false, reason } unchanged when Vision returns match=false', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      makeChatResponse(
        '{"match":false,"reason":"candidate is baby onesie, reference is adult t-shirt"}',
      ),
    );

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({
      match: false,
      reason: 'candidate is baby onesie, reference is adult t-shirt',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Parse fallback (regex rescue): JSON wrapped in prose
// ---------------------------------------------------------------------------

describe('verifySameProduct — regex-extract parse fallback', () => {
  it('extracts the JSON object when wrapped in surrounding text', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      makeChatResponse('Some preamble {"match":true,"reason":"x"} trailing'),
    );

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({ match: true, reason: 'x' });
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Parse failure (no JSON at all) → FALSE-ACCEPT fallback (T-16-02)
// ---------------------------------------------------------------------------

describe('verifySameProduct — parse failure fallback (T-16-02)', () => {
  it('returns { match: true, reason: parse-fallback } when no JSON object can be extracted', async () => {
    const create = vi.fn().mockResolvedValueOnce(makeChatResponse('no json here'));

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({ match: true, reason: 'verifier parse error fallback' });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('[verify-same-product]');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — API error → FALSE-ACCEPT fallback (T-16-02)
// ---------------------------------------------------------------------------

describe('verifySameProduct — api error fallback (T-16-02)', () => {
  it('returns { match: true, reason: api-fallback } when the API call rejects', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('network'));

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({ match: true, reason: 'verifier api error fallback' });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('[verify-same-product]');
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Empty content → parse-fallback (false-accept)
// ---------------------------------------------------------------------------

describe('verifySameProduct — empty content fallback', () => {
  it('returns { match: true, reason: parse-fallback } when content is empty', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    const result = await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(result).toEqual({ match: true, reason: 'verifier parse error fallback' });
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Request shape: gpt-4o-mini + max_tokens + json_object + detail=low
// ---------------------------------------------------------------------------

describe('verifySameProduct — request shape', () => {
  it('invokes create with the exact Phase-15-compatible OpenAI Vision shape', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      makeChatResponse('{"match":true,"reason":"ok"}'),
    );

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];

    expect(arg.model).toBe('gpt-4o-mini');
    expect(arg.max_tokens).toBe(100);
    expect(arg.response_format).toEqual({ type: 'json_object' });

    // system + user messages
    expect(arg.messages).toHaveLength(2);
    expect(arg.messages[0].role).toBe('system');
    expect(arg.messages[1].role).toBe('user');

    // user content array has 2 image_url blocks, each with detail:'low' and a
    // data:image/png;base64, prefix
    const userContent = arg.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageBlocks = userContent.filter((b: any) => b.type === 'image_url');
    expect(imageBlocks).toHaveLength(2);
    for (const b of imageBlocks) {
      expect(b.image_url.detail).toBe('low');
      expect(b.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Prompt order: CANDIDATE first, REFERENCE second (Phase-16-specific)
// ---------------------------------------------------------------------------

describe('verifySameProduct — candidate-first prompt order', () => {
  it('places the candidate image+label BEFORE the reference image+label', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      makeChatResponse('{"match":true,"reason":"ok"}'),
    );

    const { verifySameProduct } = await import('../../src/lib/verify-same-product.js');
    await verifySameProduct(makeClient(create), candidateBuffer, referenceBuffer);

    const arg = create.mock.calls[0][0];
    const userContent = arg.messages[1].content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;

    // Exactly 4 blocks: text(candidate label) -> image(candidate) -> text(reference label) -> image(reference)
    expect(userContent).toHaveLength(4);
    expect(userContent[0].type).toBe('text');
    expect(userContent[0].text).toBe('Candidate (BR image being audited):');
    expect(userContent[1].type).toBe('image_url');
    expect(userContent[2].type).toBe('text');
    expect(userContent[2].text).toBe('Reference (supplier canonical):');
    expect(userContent[3].type).toBe('image_url');

    // The candidate buffer is base64('candidate-png'); reference is base64('reference-png').
    // Confirm the URL prefix order matches the labels (catches a swap regression).
    const candidateB64 = candidateBuffer.toString('base64');
    const referenceB64 = referenceBuffer.toString('base64');
    expect(userContent[1].image_url!.url).toContain(candidateB64);
    expect(userContent[3].image_url!.url).toContain(referenceB64);
  });
});
