/**
 * Unit tests for verifyGarmentTypeMatch() — Phase 15 R2.
 *
 * All OpenAI Vision calls are mocked. No real network calls. No real API key required.
 * This file lives separately from tests/lib/ai-image-generator.test.ts so the verifier
 * unit coverage sits next to the verifier helper and does not entangle with the
 * existing images.edit mocks reserved for Plan 02.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: openai
// ---------------------------------------------------------------------------

const mockChatCompletionsCreate = vi.fn();

vi.mock('openai', () => {
  class BadRequestError extends Error {
    status: number;
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestError';
      this.status = 400;
    }
  }
  class OpenAI {
    chat = { completions: { create: mockChatCompletionsCreate } };
    // images.edit is mocked but unused in these tests — present so the OpenAI
    // class shape matches the production module's expectations.
    images = { edit: vi.fn() };
    static BadRequestError = BadRequestError;
  }
  return {
    default: OpenAI,
    toFile: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

const mockLoggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: scoreImageQuality + hue-utils + sharp — these are imported at module
// top by ai-image-generator.ts; mock them so importing the module is cheap and
// side-effect-free.
// ---------------------------------------------------------------------------

vi.mock('../../src/shopify/image-scorer.js', () => ({
  scoreImageQuality: vi.fn(),
}));

vi.mock('../../src/lib/hue-utils.js', () => ({
  extractDominantHue: vi.fn(),
  hueDrift: vi.fn(),
  isAchromatic: vi.fn(),
  rgbToHue: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: vi.fn().mockReturnValue({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-png')),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

const frontBuffer = Buffer.from('front-fake', 'utf8');
const genBuffer = Buffer.from('gen-fake', 'utf8');

// ---------------------------------------------------------------------------
// Module under test — imported lazily so each test sees a clean mock state
// ---------------------------------------------------------------------------

let verifyGarmentTypeMatch: typeof import('../../src/lib/ai-image-generator.js').verifyGarmentTypeMatch;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../../src/lib/ai-image-generator.js');
  verifyGarmentTypeMatch = mod.verifyGarmentTypeMatch;
});

// ---------------------------------------------------------------------------
// Test 1 — R2 happy path: match=true
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — R2 happy match', () => {
  it('returns { match: true, reason: "both crewnecks" } when Vision returns a match=true JSON', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      makeChatResponse('{"match":true,"reason":"both crewnecks"}'),
    );

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result).toEqual({ match: true, reason: 'both crewnecks' });
  });
});

// ---------------------------------------------------------------------------
// Test 2 — R2 happy mismatch: match=false
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — R2 happy mismatch', () => {
  it('returns { match: false, reason: ... } when Vision returns a match=false JSON', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      makeChatResponse('{"match":false,"reason":"front is crewneck, candidate is hoodie"}'),
    );

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result).toEqual({
      match: false,
      reason: 'front is crewneck, candidate is hoodie',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Parse fallback: malformed content (no JSON object)
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — parse fallback', () => {
  it('returns parse-fallback when content has no extractable JSON object, and logger.warn fires', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(makeChatResponse('not even json'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result).toEqual({ match: true, reason: 'verifier parse error fallback' });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(String(mockLoggerWarn.mock.calls[0][0])).toContain('[ai-image-generator]');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Regex-extract: trailing text around valid JSON
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — regex-extract fallback', () => {
  it('parses correctly when JSON is wrapped in surrounding prose', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      makeChatResponse('sure: {"match":false,"reason":"x"}\nmore text'),
    );

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result).toEqual({ match: false, reason: 'x' });
  });
});

// ---------------------------------------------------------------------------
// Test 5 — API error fallback: chat.completions.create throws
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — api error fallback', () => {
  it('returns { match: true, reason: "verifier api error fallback" } when the API call rejects', async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(new Error('API timeout'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result).toEqual({ match: true, reason: 'verifier api error fallback' });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Reason truncation: 250-char reason → 200 chars on return
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — reason truncation', () => {
  it('truncates a 250-char reason to exactly 200 chars', async () => {
    const longReason = 'x'.repeat(250);
    mockChatCompletionsCreate.mockResolvedValueOnce(
      makeChatResponse(JSON.stringify({ match: false, reason: longReason })),
    );

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    const result = await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(result.match).toBe(false);
    expect(result.reason.length).toBe(200);
    expect(result.reason).toBe('x'.repeat(200));
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Call shape: model, response_format, max_tokens, 2 image blocks, detail=low
// ---------------------------------------------------------------------------

describe('verifyGarmentTypeMatch — call shape', () => {
  it('invokes chat.completions.create with gpt-4o-mini, json_object response_format, max_tokens 100, and 2 detail-low image blocks', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(
      makeChatResponse('{"match":true,"reason":"both crewnecks"}'),
    );

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();
    await verifyGarmentTypeMatch(client, genBuffer, frontBuffer);

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);

    const arg = mockChatCompletionsCreate.mock.calls[0][0];
    expect(arg.model).toBe('gpt-4o-mini');
    expect(arg.response_format).toEqual({ type: 'json_object' });
    expect(arg.max_tokens).toBe(100);

    // user message is index 1 (system is index 0); its content is an array of text+image blocks
    const userContent = arg.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageBlocks = userContent.filter((b: any) => b.type === 'image_url');
    expect(imageBlocks.length).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(imageBlocks.every((b: any) => b.image_url.detail === 'low')).toBe(true);
  });
});
