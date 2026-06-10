/**
 * Unit tests for scripts/check-br-image-urls.ts — Phase 18-03 Task 1.
 *
 * Tests the pure `classifyHeadResponse` function against mocked response objects.
 * NO real network calls are made in this suite.
 *
 * Cases covered:
 *   1. status 200 + image/png → "ok"
 *   2. status 200 + image/jpeg → "ok"
 *   3. status 200 + image/webp → "ok"
 *   4. status 200 + text/html → "not-image" (Drive permission interstitial)
 *   5. status 200 + text/html;charset=utf-8 → "not-image"
 *   6. status 403 → "forbidden" (missing public permission)
 *   7. status 302 with final image/png → "ok" (redirect followed to image)
 *   8. status 302 with final text/html → "not-image"
 *   9. status 404 → "forbidden" (missing/gone)
 *  10. contentType undefined + status 200 → "not-image" (no content-type header)
 */

import { describe, it, expect } from 'vitest';
import { classifyHeadResponse, type HeadResponseInput, type UrlClassification } from '../../scripts/check-br-image-urls.js';

describe('classifyHeadResponse — image/* variants → "ok"', () => {
  it('returns "ok" for status 200 + image/png', () => {
    const result: UrlClassification = classifyHeadResponse({ status: 200, contentType: 'image/png' });
    expect(result).toBe('ok');
  });

  it('returns "ok" for status 200 + image/jpeg', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'image/jpeg' })).toBe('ok');
  });

  it('returns "ok" for status 200 + image/webp', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'image/webp' })).toBe('ok');
  });

  it('returns "ok" for status 200 + image/gif', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'image/gif' })).toBe('ok');
  });

  it('returns "ok" for status 200 + image/png with extra params', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'image/png; charset=binary' })).toBe('ok');
  });
});

describe('classifyHeadResponse — HTML interstitial → "not-image"', () => {
  it('returns "not-image" for status 200 + text/html', () => {
    const result: UrlClassification = classifyHeadResponse({ status: 200, contentType: 'text/html' });
    expect(result).toBe('not-image');
  });

  it('returns "not-image" for status 200 + text/html;charset=utf-8', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'text/html;charset=utf-8' })).toBe('not-image');
  });

  it('returns "not-image" for status 200 + text/html; charset=UTF-8 (spaced)', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'text/html; charset=UTF-8' })).toBe('not-image');
  });

  it('returns "not-image" for status 200 + application/json (not an image)', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'application/json' })).toBe('not-image');
  });
});

describe('classifyHeadResponse — 403 / permission errors → "forbidden"', () => {
  it('returns "forbidden" for status 403 (missing public permission)', () => {
    const result: UrlClassification = classifyHeadResponse({ status: 403, contentType: undefined });
    expect(result).toBe('forbidden');
  });

  it('returns "forbidden" for status 403 with text/html body', () => {
    expect(classifyHeadResponse({ status: 403, contentType: 'text/html' })).toBe('forbidden');
  });

  it('returns "forbidden" for status 404 (file gone or not found)', () => {
    expect(classifyHeadResponse({ status: 404, contentType: undefined })).toBe('forbidden');
  });

  it('returns "forbidden" for status 401', () => {
    expect(classifyHeadResponse({ status: 401, contentType: undefined })).toBe('forbidden');
  });
});

describe('classifyHeadResponse — redirects', () => {
  it('returns "ok" for status 302 with final content-type image/png (redirect followed to image)', () => {
    // The caller follows redirects and passes the final response; if status ended up 200+image/* → ok
    expect(classifyHeadResponse({ status: 200, contentType: 'image/png', wasRedirected: true })).toBe('ok');
  });

  it('returns "not-image" for status 302 with final content-type text/html', () => {
    expect(classifyHeadResponse({ status: 200, contentType: 'text/html', wasRedirected: true })).toBe('not-image');
  });
});

describe('classifyHeadResponse — missing contentType', () => {
  it('returns "not-image" when contentType is undefined (no Content-Type header)', () => {
    expect(classifyHeadResponse({ status: 200, contentType: undefined })).toBe('not-image');
  });

  it('returns "not-image" when contentType is empty string', () => {
    expect(classifyHeadResponse({ status: 200, contentType: '' })).toBe('not-image');
  });
});

describe('classifyHeadResponse — 5xx errors', () => {
  it('returns "forbidden" for status 500 (server error treated as non-ok)', () => {
    expect(classifyHeadResponse({ status: 500, contentType: undefined })).toBe('forbidden');
  });

  it('returns "forbidden" for status 503', () => {
    expect(classifyHeadResponse({ status: 503, contentType: undefined })).toBe('forbidden');
  });
});
