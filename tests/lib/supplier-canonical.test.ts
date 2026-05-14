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
// Test 6 — Allowlist but no scraper: logs D-12 expansion hint
// ---------------------------------------------------------------------------

describe('resolveSupplierCanonical — allowlist-but-no-scraper', () => {
  it('returns null and logs a Phase 16 D-12 expansion-candidate info for KNOWN_SUPPLIER_PREFIXES pids', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveSupplierCanonical } = await import('../../src/lib/supplier-canonical.js');
    const result = await resolveSupplierCanonical('6110');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalled();
    const msg = String(mockLoggerInfo.mock.calls[0][0]);
    expect(msg).toContain('[supplier-canonical]');
    expect(msg).toContain('6110');
    expect(msg).toContain('Phase 16 D-12 expansion');
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
