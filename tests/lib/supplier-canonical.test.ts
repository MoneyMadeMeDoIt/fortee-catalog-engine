/**
 * Unit tests for resolveSupplierCanonical() — Phase 16 Plan 01 Task 3.
 *
 * All network calls are mocked via stubbing `global.fetch`. No real S&S /
 * CSW HTTP, no real env credentials required (the helper reads SS_ACCOUNT_NUMBER
 * / SS_API_KEY only when the S&S branch is taken — covered tests stub those).
 *
 * Covers the prefix dispatch (H08 short-circuit / S → S&S / L → CSW / allowlist
 * but no scraper / unknown), the colorSideImage caveat (memory
 * `feedback_strict_side_profile`), and the rate-limit invariant (D-05 / T-16-05).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Response-like object that the resolver's `await r.json()` /
 * `r.ok` / `r.status` checks will accept.
 */
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    status,
    ok: init.ok ?? (status >= 200 && status < 300),
    json: async () => body,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  // Default env so the S&S branch can construct Basic auth without throwing.
  process.env.SS_ACCOUNT_NUMBER = 'TESTACCT';
  process.env.SS_API_KEY = 'TESTKEY';
});

afterEach(() => {
  delete process.env.SS_ACCOUNT_NUMBER;
  delete process.env.SS_API_KEY;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test 1 — Headwear short-circuit: H08* returns null with ZERO fetch calls
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — H08* short-circuit (D-22)', () => {
  it('returns null for H08* pids without invoking fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('H08010');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — S&S happy path
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — S&S happy path', () => {
  it('resolves S* pids to colorFrontImage URL with _fm → _fl swap', async () => {
    // First call: /styles/?search=S05610 — returns one match
    // Second call: /products/?style=12345 — returns one product with colorFrontImage
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 12345, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ colorFrontImage: 'Images/Style/S05610_navy_fm.jpg' }]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('S05610');

    expect(result).toEqual({
      url: 'https://www.ssactivewear.com/Images/Style/S05610_navy_fl.jpg',
      source: 'ss',
      styleId: 12345,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — S&S unknown style: empty styles array → null
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — S&S unknown style', () => {
  it('returns null when /styles/?search= returns []', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('S99999');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — CSW happy path
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — CSW happy path', () => {
  it('resolves L* pids to first image src via /products/<handle>.json', async () => {
    // 1) search/suggest.json — find handle
    // 2) products/<handle>.json — return product JSON
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'csw-style-handle', title: 'L00550 Hoodie', tags: ['L00550'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [{ src: 'https://cdn.shopify.com/foo.jpg' }],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('L00550');

    expect(result).toEqual({
      url: 'https://cdn.shopify.com/foo.jpg',
      source: 'csw',
      styleId: 'csw-style-handle',
    });
  });
});

// ---------------------------------------------------------------------------
// Test 5 — CSW no handle
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — CSW no matching handle', () => {
  it('returns null when search/suggest returns zero products', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      jsonResponse({ resources: { results: { products: [] } } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('L99999');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Allowlist routing: post-17-04, KNOWN_SUPPLIER_PREFIXES pids
// dispatch through the S&S branch (Phase 16 D-12 expansion landed in 17-04).
// The previous "no-scraper-yet" log path is now unreachable for these pids.
// Full S&S-routing coverage lives in the '17-04 prefix routing' describe block.
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — allowlist routing post-17-04', () => {
  it('routes 6110 through the S&S branch when the pid resolves (D-12 expansion complete)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 50061, styleName: '6110' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/Style/6110_BLACK_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('6110');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Truly unknown prefix: silent null, no log
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — truly unknown prefix', () => {
  it('returns null with no log noise for pids outside S/L/H08 and the allowlist', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('XYZ999');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — colorSideImage caveat: canonical URL is built from colorFrontImage,
// never from colorSideImage / colorDirectSideImage. Memory:
// feedback_strict_side_profile.
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — colorSideImage MUST NOT be canonical', () => {
  it('uses colorFrontImage even when colorSideImage and colorDirectSideImage are also present in the API payload', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ styleID: 12345, styleName: 'S05610' }]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            colorFrontImage: 'Images/Style/S05610_navy_fm.jpg',
            // These two MUST NOT influence the canonical url.
            colorSideImage: 'Images/Style/S05610_navy_side_fm.jpg',
            colorDirectSideImage: 'Images/Style/S05610_navy_direct_fm.jpg',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('S05610');

    expect(result).not.toBeNull();
    // Use the front path; not the side or direct-side path.
    expect(result!.url).toBe(
      'https://www.ssactivewear.com/Images/Style/S05610_navy_fl.jpg',
    );
    expect(result!.url).not.toContain('side');
    expect(result!.url).not.toContain('direct');
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Rate-limit: consecutive S&S calls separated by >= RATE_LIMIT_MS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 17-02 per-color resolver tests
// (Phase 17 Plan 02 — extends Phase 16 dispatcher with optional colorName
// argument; S&S branch filters /products/?style= response by colorName
// case-insensitive trim-equality; CSW branch does best-effort filename
// substring match; wasFallback flag set when colorName provided but no match.)
// ---------------------------------------------------------------------------

describe('17-02 per-color resolver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.SS_ACCOUNT_NUMBER = 'TESTACCT';
    process.env.SS_API_KEY = 'TESTKEY';
  });

  // Test 1 — per-color happy path (S&S)
  it('S&S: returns the colorFrontImage of the matching color when colorName is provided', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'WHITE', colorFrontImage: 'Images/3001_WHITE_fm.jpg' },
          { colorName: 'ROYAL', colorFrontImage: 'Images/3001_ROYAL_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('S05610', 'ROYAL');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('3001_ROYAL');
    // wasFallback must be undefined or false (NOT a fallback — we matched).
    expect(result!.wasFallback).toBeFalsy();
    expect(result!.source).toBe('ss');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Test 2 — case-insensitive + whitespace-tolerant colorName match
  it('S&S: matches colorName case-insensitively and trims surrounding whitespace', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'ROYAL', colorFrontImage: 'Images/3001_ROYAL_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    // lowercase
    const r1 = await resolveSupplierCanonical('S05610', 'royal');
    expect(r1).not.toBeNull();
    expect(r1!.url).toContain('3001_ROYAL');
    expect(r1!.wasFallback).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Reset spy for a separate import (caching note: the SS_ENV is already set;
    // we run a fresh module to clear throttle / fetch counters).
    vi.resetModules();
    const fetchSpy2 = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'ROYAL', colorFrontImage: 'Images/3001_ROYAL_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy2);
    const { resolveSupplierCanonical: resolveAgain } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const r2 = await resolveAgain('S05610', '  Royal  ');
    expect(r2).not.toBeNull();
    expect(r2!.url).toContain('3001_ROYAL');
    expect(r2!.wasFallback).toBeFalsy();
  });

  // Test 3 — colorName not found, fall back to first
  it('S&S: falls back to first front-image-bearing variant and sets wasFallback=true when colorName has no match', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'WHITE', colorFrontImage: 'Images/3001_WHITE_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('S05610', 'NONEXISTENT-COLOR');

    expect(result).not.toBeNull();
    // BLACK is the first variant; fallback should land there.
    expect(result!.url).toContain('3001_BLACK');
    expect(result!.wasFallback).toBe(true);
    expect(result!.source).toBe('ss');
  });

  // Test 4 — no colorName arg = pre-Phase-17 behavior (no fallback flag)
  it('S&S: with no colorName argument, returns first front-image-bearing variant and does NOT mark wasFallback', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'WHITE', colorFrontImage: 'Images/3001_WHITE_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('S05610');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('3001_BLACK');
    // Operator did not ask for a specific color → wasFallback is undefined/false.
    expect(result!.wasFallback).toBeFalsy();
  });

  // Test 5 — variant matches colorName but has empty colorFrontImage → fall through
  it('S&S: skips a colorName match whose colorFrontImage is empty; falls back to first non-empty variant with wasFallback=true', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: '' },
          { colorName: 'ROYAL', colorFrontImage: 'Images/3001_ROYAL_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('S05610', 'BLACK');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('3001_ROYAL');
    expect(result!.wasFallback).toBe(true);
  });

  // Test 6 — empty /products/ response → null
  it('S&S: returns null when /products/ response is empty even with colorName provided', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('S05610', 'BLACK');

    expect(result).toBeNull();
  });

  // Test 7 — S&S API call count unchanged (Finding 4 invariant)
  it('S&S: passing colorName does NOT add extra fetches (same call count as Phase 16)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ styleID: 3001, styleName: 'S05610' }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { colorName: 'BLACK', colorFrontImage: 'Images/3001_BLACK_fm.jpg' },
          { colorName: 'ROYAL', colorFrontImage: 'Images/3001_ROYAL_fm.jpg' },
        ]),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    await resolveSupplierCanonical('S05610', 'ROYAL');
    // Exactly 2 fetches: /styles/?search= + /products/?style= — no extra
    // colorName-specific call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Test 8 — CSW per-color filename match
  it('CSW: matches the image whose filename contains the colorName slug', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'l00660-handle', title: 'L00660 Hoodie', tags: ['L00660'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [
              { src: 'https://cdn.shopify.com/.../L00660-Black-front.jpg' },
              { src: 'https://cdn.shopify.com/.../L00660-Royal-front.jpg' },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('L00660', 'Royal');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('Royal-front.jpg');
    expect(result!.source).toBe('csw');
    expect(result!.wasFallback).toBeFalsy();
  });

  // Test 9 — CSW multi-word color — hyphenated slug match
  it('CSW: converts spaces in colorName to hyphens to build the filename slug', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'l00660-handle', title: 'L00660 Hoodie', tags: ['L00660'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [
              { src: 'https://cdn.shopify.com/.../L00660-heather-gold-melange-front.jpg' },
              { src: 'https://cdn.shopify.com/.../L00660-black-front.jpg' },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('L00660', 'Heather Gold Melange');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('heather-gold-melange-front');
    expect(result!.wasFallback).toBeFalsy();
  });

  // Test 10 — CSW filename match fails — fallback to first image
  it('CSW: falls back to first image and sets wasFallback=true when no filename matches the colorName slug', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'l00660-handle', title: 'L00660 Hoodie', tags: ['L00660'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [
              { src: 'https://cdn.shopify.com/.../L00660-Black-front.jpg' },
              { src: 'https://cdn.shopify.com/.../L00660-Royal-front.jpg' },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('L00660', 'NONEXISTENT');

    expect(result).not.toBeNull();
    // Fallback = first image.
    expect(result!.url).toContain('L00660-Black-front.jpg');
    expect(result!.wasFallback).toBe(true);
  });

  // Test 11 — CSW no colorName — backward compat (no wasFallback)
  it('CSW: with no colorName argument, returns first image and does NOT mark wasFallback', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'l00660-handle', title: 'L00660 Hoodie', tags: ['L00660'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [
              { src: 'https://cdn.shopify.com/.../L00660-Black-front.jpg' },
              { src: 'https://cdn.shopify.com/.../L00660-Royal-front.jpg' },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import(
      '../../src/lib/supplier-canonical.js'
    );
    const result = await resolveSupplierCanonical('L00660');

    expect(result).not.toBeNull();
    expect(result!.url).toContain('L00660-Black-front.jpg');
    expect(result!.wasFallback).toBeFalsy();
  });

  // Test 12 — CanonicalResult interface shape
  it('exports CanonicalResult with optional url/source/styleId/wasFallback fields', async () => {
    const mod = await import('../../src/lib/supplier-canonical.js');
    type CR = import('../../src/lib/supplier-canonical.js').CanonicalResult;
    // Compile-time + runtime — any object matching the shape must assignable.
    const sample: CR = {
      url: 'https://example.com/x.jpg',
      source: 'ss',
      styleId: 1234,
      wasFallback: true,
    };
    expect(sample.url).toBeDefined();
    expect(sample.source).toBe('ss');
    expect(sample.wasFallback).toBe(true);
    // And the function exists.
    expect(typeof mod.resolveSupplierCanonical).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 17-04 prefix routing — adidas + KNOWN_SUPPLIER_PREFIXES dispatched via S&S
//
// Per RESEARCH Findings 1 + 2 + Open Question 4:
//   - adidas (/^A\d/i, /^CE\d/i) is exclusive to S&S in the promo channel.
//   - Bella+Canvas / Gildan / Next Level / Comfort Colors / American Apparel /
//     Richardson pids (the existing KNOWN_SUPPLIER_PREFIXES allowlist) are ALSO
//     carried by S&S Canada. The S&S /styles/?search=<pid> endpoint works for
//     non-S* pids — already used by scripts/fetch-ss-rest-sizes.ts.
//   - The H08* early-return MUST still fire BEFORE the new dispatcher.
//   - CSW (/^L/i) routing is unchanged.
//   - True unsupported brands (M786, NE220, anvil 9xx, QTB6000) still return null
//     with NO fetch — Plan 17-05 manual triage will handle them.
//
// Each test that exercises the network mocks /styles/?search= + /products/?style=
// using the same shape as the 17-02 tests above. The routesViaSS helper is
// imported and exercised directly for prefix-matching edge cases (Tests 15-17).
// ---------------------------------------------------------------------------

describe('17-04 prefix routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.SS_ACCOUNT_NUMBER = 'TESTACCT';
    process.env.SS_API_KEY = 'TESTKEY';
  });

  /** Shared mock setup: /styles/?search=<pid> → [{styleID, styleName}], then
   *  /products/?style=<styleID> → variants array. */
  function mockSSResolution(
    styleId: number,
    styleName: string,
    variants: Array<{ colorName?: string; colorFrontImage?: string }>,
  ) {
    return vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ styleID: styleId, styleName }]))
      .mockResolvedValueOnce(jsonResponse(variants));
  }

  // -------------------------------------------------------------------------
  // Test 1 — adidas A702 routes via S&S
  // -------------------------------------------------------------------------
  it('routes adidas A702 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(98101, 'A702', [
      { colorName: 'BLACK', colorFrontImage: 'Images/Style/A702_BLACK_fm.jpg' },
      { colorName: 'WHITE', colorFrontImage: 'Images/Style/A702_WHITE_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('A702', 'BLACK');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('A702_BLACK');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // First fetch is /styles/?search=A702 (URL-encoded ok); second is /products/.
    const firstUrl = String(fetchSpy.mock.calls[0][0]);
    expect(firstUrl).toContain('/styles/?search=A702');
    const secondUrl = String(fetchSpy.mock.calls[1][0]);
    expect(secondUrl).toContain('/products/?style=98101');
  });

  // -------------------------------------------------------------------------
  // Test 2 — adidas CE520L routes via S&S
  // -------------------------------------------------------------------------
  it('routes adidas CE520L through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(98202, 'CE520L', [
      { colorName: 'WHITE', colorFrontImage: 'Images/Style/CE520L_WHITE_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('CE520L', 'WHITE');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('CE520L_WHITE');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Bella+Canvas 6110 routes via S&S
  // -------------------------------------------------------------------------
  it('routes Bella+Canvas 6110 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(50061, '6110', [
      { colorName: 'BLACK', colorFrontImage: 'Images/Style/6110_BLACK_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('6110', 'BLACK');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('6110_BLACK');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Bella+Canvas 3001 routes via S&S
  // -------------------------------------------------------------------------
  it('routes Bella+Canvas 3001 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(30010, '3001', [
      { colorName: 'NAVY', colorFrontImage: 'Images/Style/3001_NAVY_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('3001', 'NAVY');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('3001_NAVY');
  });

  // -------------------------------------------------------------------------
  // Test 5 — Gildan 5200 routes via S&S
  // -------------------------------------------------------------------------
  it('routes Gildan 5200 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(52000, '5200', [
      { colorName: 'SPORT GREY', colorFrontImage: 'Images/Style/5200_SPORTGREY_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('5200', 'SPORT GREY');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('5200_SPORTGREY');
  });

  // -------------------------------------------------------------------------
  // Test 6 — Next Level 1510 routes via S&S
  // -------------------------------------------------------------------------
  it('routes Next Level 1510 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(15100, '1510', [
      { colorName: 'ROYAL', colorFrontImage: 'Images/Style/1510_ROYAL_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('1510', 'ROYAL');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('1510_ROYAL');
  });

  // -------------------------------------------------------------------------
  // Test 7 — Comfort Colors 1466 routes via S&S
  // -------------------------------------------------------------------------
  it('routes Comfort Colors 1466 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(14660, '1466', [
      { colorName: 'IVORY', colorFrontImage: 'Images/Style/1466_IVORY_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('1466', 'IVORY');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('1466_IVORY');
  });

  // -------------------------------------------------------------------------
  // Test 8 — American Apparel 1304 routes via S&S
  // -------------------------------------------------------------------------
  it('routes American Apparel 1304 through the S&S branch', async () => {
    const fetchSpy = mockSSResolution(13040, '1304', [
      { colorName: 'BLACK', colorFrontImage: 'Images/Style/1304_BLACK_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('1304', 'BLACK');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('1304_BLACK');
  });

  // -------------------------------------------------------------------------
  // Test 9 — Richardson 168 routes via S&S (Open Question 4: not H08-prefixed)
  // -------------------------------------------------------------------------
  it('routes Richardson 168 through the S&S branch (NOT H08-prefixed)', async () => {
    const fetchSpy = mockSSResolution(1680, '168', [
      { colorName: 'BLACK', colorFrontImage: 'Images/Style/168_BLACK_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('168', 'BLACK');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('168_BLACK');
  });

  // -------------------------------------------------------------------------
  // Test 10 — H08* invariant preserved: H08355 returns null with NO fetch
  // -------------------------------------------------------------------------
  it('preserves the H08* early-return: H08355 returns null without any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('H08355', 'BLACK');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 11 — M786 (true unsupported) returns null with NO fetch
  // -------------------------------------------------------------------------
  it('returns null with NO fetch for M786 (truly unsupported — manual triage)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('M786', 'BLACK');

    expect(result).toBeNull();
    // M786 doesn't match S*/A*/CE*/KNOWN_SUPPLIER_PREFIXES — dispatcher MUST not
    // emit any S&S request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 12 — NE220 (New Era proprietary) returns null with NO fetch
  // -------------------------------------------------------------------------
  it('returns null with NO fetch for NE220 (New Era proprietary — manual triage)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('NE220', 'BLACK');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 13 — existing S* pid behavior unchanged (regression guard)
  // -------------------------------------------------------------------------
  it('preserves existing S* behavior: S05610 still routes via S&S', async () => {
    const fetchSpy = mockSSResolution(12345, 'S05610', [
      { colorName: 'NAVY', colorFrontImage: 'Images/Style/S05610_NAVY_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('S05610', 'NAVY');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('ss');
    expect(result!.url).toContain('S05610_NAVY');
  });

  // -------------------------------------------------------------------------
  // Test 14 — existing L* CSW behavior unchanged (regression guard)
  // -------------------------------------------------------------------------
  it('preserves existing L* CSW behavior: L00660 still routes via CSW', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          resources: {
            results: {
              products: [
                { handle: 'l00660-handle', title: 'L00660 Hoodie', tags: ['L00660'] },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          product: {
            images: [{ src: 'https://cdn.shopify.com/.../L00660-Black-front.jpg' }],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('L00660');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('csw');
    // CSW endpoint, not S&S — verifies dispatcher routed CORRECTLY (not via S&S).
    const firstUrl = String(fetchSpy.mock.calls[0][0]);
    expect(firstUrl).toContain('canadasportswear.com');
  });

  // -------------------------------------------------------------------------
  // Test 15 — routesViaSS: standalone 'A' (no digit) is NOT S&S
  // -------------------------------------------------------------------------
  it('routesViaSS("A") === false (single letter, no digit — accidental BR row)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('A')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 16 — routesViaSS: adidas-style A2009 matches /^A\d/
  // -------------------------------------------------------------------------
  it('routesViaSS("A2009") === true (adidas A-digit family)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('A2009')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 17 — routesViaSS: adidas CE520L matches /^CE\d/
  // -------------------------------------------------------------------------
  it('routesViaSS("CE520L") === true (adidas CE-digit family)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('CE520L')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 18 — routesViaSS: CSW L* does NOT route via S&S (CSW branch handles it)
  // -------------------------------------------------------------------------
  it('routesViaSS("L00660") === false (CSW pid — falls through to CSW branch)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('L00660')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 19 — routesViaSS: lowercase s* still routes via S&S (case-insensitive)
  // -------------------------------------------------------------------------
  it('routesViaSS("s05610") === true (case-insensitive S* match)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('s05610')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 20 — routesViaSS: anvil 9xx (NOT in KNOWN_SUPPLIER_PREFIXES) returns false
  // -------------------------------------------------------------------------
  it('routesViaSS("980") === false (anvil pid not in KNOWN_SUPPLIER_PREFIXES — manual triage)', async () => {
    const { routesViaSS } = await import('../../src/lib/supplier-canonical.js');
    expect(routesViaSS('980')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 21 — dispatcher emits a log line surfacing which routing rule fired
  // -------------------------------------------------------------------------
  it('logs the routing rule that fired (operator observability)', async () => {
    const fetchSpy = mockSSResolution(50061, '6110', [
      { colorName: 'BLACK', colorFrontImage: 'Images/Style/6110_BLACK_fm.jpg' },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    await resolveSupplierCanonical('6110', 'BLACK');

    // At least one info log should mention the pid and a routing-rule hint.
    const calls = mockLoggerInfo.mock.calls.map((c) => String(c[0]));
    const routingLog = calls.find((m) => m.includes('6110') && m.includes('S&S'));
    expect(routingLog).toBeDefined();
    // The log should surface WHICH rule fired (S*, A*, CE*, or KNOWN_PREFIX).
    expect(String(routingLog)).toMatch(/(S\*|A\*|CE\*|KNOWN_PREFIX)/);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Rate-limit: consecutive S&S calls separated by >= RATE_LIMIT_MS
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — S&S rate-limit (T-16-05)', () => {
  it('throttles two consecutive S* resolves so the 3rd fetch is >= 1100ms after the 1st', async () => {
    // Each resolveSupplierCanonical('S*') makes 2 fetches with a throttle
    // between them. Two consecutive calls produce 4 fetches with 3 throttles
    // (1st→2nd, 2nd→3rd, 3rd→4th). We assert the gap between fetches 1 and 3
    // (across the two calls) is >= 1100ms.
    const timestamps: number[] = [];
    const fetchSpy = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return jsonResponse([{ styleID: 12345, styleName: 'S05610' }]);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');

    // First resolve: only the /styles/ call returns a hit; /products/ returns
    // an empty array so the function exits to null after 2 fetches.
    fetchSpy
      .mockImplementationOnce(async () => {
        timestamps.push(Date.now());
        return jsonResponse([{ styleID: 12345, styleName: 'S05610' }]);
      })
      .mockImplementationOnce(async () => {
        timestamps.push(Date.now());
        return jsonResponse([]); // empty products → null
      })
      .mockImplementationOnce(async () => {
        timestamps.push(Date.now());
        return jsonResponse([{ styleID: 67890, styleName: 'S05611' }]);
      })
      .mockImplementationOnce(async () => {
        timestamps.push(Date.now());
        return jsonResponse([]);
      });

    const start = Date.now();
    await resolveSupplierCanonical('S05610');
    await resolveSupplierCanonical('S05611');
    const elapsed = Date.now() - start;

    // 4 fetches total, separated by at least RATE_LIMIT_MS=1100 each (3 gaps
    // = 3300ms minimum). With small margin for vitest timer noise, assert
    // >= 3000ms total runtime.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(elapsed).toBeGreaterThanOrEqual(3000);

    // Ascending timestamps with gaps >= ~1000ms (allow ~50ms drift per step).
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  }, 15000); // generous timeout for real-time waits
});
