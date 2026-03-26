import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../src/shopify/image-standardizer.js', () => ({
  downloadImage: vi.fn(),
}));

vi.mock('../../src/shopify/image-scorer.js', () => ({
  scoreImageQuality: vi.fn(),
}));

vi.mock('../../src/lib/onesource-client.js', () => ({
  createOneSourceClient: vi.fn(),
  parseMediaContentFromXml: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  sourceImages,
  pickBest,
  type SourcedView,
} from '../../src/lib/image-sourcer.js';
import { downloadImage } from '../../src/shopify/image-standardizer.js';
import { scoreImageQuality } from '../../src/shopify/image-scorer.js';
import {
  createOneSourceClient,
  parseMediaContentFromXml,
} from '../../src/lib/onesource-client.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

const mockDownloadImage = vi.mocked(downloadImage);
const mockScoreImageQuality = vi.mocked(scoreImageQuality);
const mockCreateOneSourceClient = vi.mocked(createOneSourceClient);
const mockParseMediaContentFromXml = vi.mocked(parseMediaContentFromXml);

function makeDummyBuffer() {
  return Buffer.from('dummy-image-data');
}

function makeQualityResult(score: number, verdict: 'pass' | 'fail' = 'pass') {
  return {
    score,
    verdict,
    reasons: verdict === 'fail' ? ['test reason'] : [],
    dimensions: { blur: score, resolution: score, proportion: score, content: score },
  };
}

function makeMediaItem(
  url: string,
  classTypeIds: number[],
  color?: string,
): ReturnType<typeof parseMediaContentFromXml>[number] {
  return {
    productId: 'TEST',
    url,
    mediaType: 'Image',
    classTypes: classTypeIds.map((id) => ({ id, name: `ClassType${id}` })),
    color,
  };
}

// ---------------------------------------------------------------------------
// describe('pickBest')
// ---------------------------------------------------------------------------

describe('pickBest', () => {
  it('returns null for empty array', () => {
    expect(pickBest([])).toBeNull();
  });

  it('returns single candidate unchanged', () => {
    const view: SourcedView = { url: 'https://example.com/front.jpg', score: 75, verdict: 'pass' };
    expect(pickBest([view])).toBe(view);
  });

  it('returns highest-scoring from multiple candidates', () => {
    const views: SourcedView[] = [
      { url: 'https://example.com/a.jpg', score: 40, verdict: 'pass' },
      { url: 'https://example.com/b.jpg', score: 90, verdict: 'pass' },
      { url: 'https://example.com/c.jpg', score: 60, verdict: 'pass' },
    ];
    const best = pickBest(views);
    expect(best?.url).toBe('https://example.com/b.jpg');
    expect(best?.score).toBe(90);
  });

  it('returns highest-scoring even when all have verdict="fail" (D-03)', () => {
    const views: SourcedView[] = [
      { url: 'https://example.com/a.jpg', score: 30, verdict: 'fail' },
      { url: 'https://example.com/b.jpg', score: 60, verdict: 'fail' },
    ];
    const best = pickBest(views);
    expect(best?.score).toBe(60);
    expect(best?.verdict).toBe('fail');
  });

  it('breaks ties by returning the first candidate (stable)', () => {
    const views: SourcedView[] = [
      { url: 'https://example.com/first.jpg', score: 70, verdict: 'pass' },
      { url: 'https://example.com/second.jpg', score: 70, verdict: 'pass' },
    ];
    const best = pickBest(views);
    expect(best?.url).toBe('https://example.com/first.jpg');
  });
});

// ---------------------------------------------------------------------------
// describe('fetchOMGImages') — tested via sourceImages with controlled mocks
// ---------------------------------------------------------------------------

describe('fetchOMGImages (via sourceImages with CSW/S&S disabled)', () => {
  beforeEach(() => {
    // Disable S&S Canada credentials so only OMG and CSW compete
    delete process.env.SS_ACCOUNT_NUMBER;
    delete process.env.SS_API_KEY;

    // Set OMG credentials
    process.env.ONESOURCE_KEY_ID = 'test-key-id';
    process.env.ONESOURCE_KEY_PASSWORD = 'test-password';
    process.env.CSW_SUPPLIER_CODE = 'CANADASPORTSWEAR';

    // Default scoreImageQuality mock
    mockDownloadImage.mockResolvedValue(makeDummyBuffer());
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(75));

    // Disable CSW by mocking global fetch to return no results for search
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.ONESOURCE_KEY_ID;
    delete process.env.ONESOURCE_KEY_PASSWORD;
    delete process.env.CSW_SUPPLIER_CODE;
  });

  function setupOMGMock(
    mediaItems: ReturnType<typeof parseMediaContentFromXml>,
  ) {
    const mockGetMediaContent = vi.fn().mockResolvedValue({} as ReturnType<typeof import('cheerio').load>);
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: mockGetMediaContent,
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue(mediaItems);
    return mockGetMediaContent;
  }

  it('maps classTypeId 1007 to front view (SRC-01)', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/front.jpg', [1007]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.front).not.toBeNull();
    expect(result.front?.url).toBe('https://example.com/front.jpg');
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });

  it('maps classTypeId 1008 to back view (SRC-01)', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/back.jpg', [1008]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.back).not.toBeNull();
    expect(result.back?.url).toBe('https://example.com/back.jpg');
    expect(result.front).toBeNull();
  });

  it('maps classTypeId 1009 to side view (SRC-01)', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/side.jpg', [1009]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.side).not.toBeNull();
    expect(result.side?.url).toBe('https://example.com/side.jpg');
  });

  it('maps classTypeId 1010 to side view (SRC-01)', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/leftside.jpg', [1010]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.side).not.toBeNull();
    expect(result.side?.url).toBe('https://example.com/leftside.jpg');
  });

  it('maps classTypeId 1006 to front when 1007 absent (SRC-01)', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/primary.jpg', [1006]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.front?.url).toBe('https://example.com/primary.jpg');
  });

  it('skips media items with empty classTypes array', async () => {
    setupOMGMock([
      // Item with empty classTypes — should be skipped
      { productId: 'TEST', url: 'https://example.com/unknown.jpg', mediaType: 'Image', classTypes: [] },
      makeMediaItem('https://example.com/front.jpg', [1007]),
    ]);

    const result = await sourceImages('L00550');
    expect(result.front?.url).toBe('https://example.com/front.jpg');
  });

  it('returns {} on OneSource API error (graceful degradation)', async () => {
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockRejectedValue(new Error('SOAP error')),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([]);

    const result = await sourceImages('L00550');
    // OMG failed, but result is still returned (not thrown)
    expect(result).toHaveProperty('front');
    expect(result).toHaveProperty('back');
    expect(result).toHaveProperty('side');
  });

  it('prefers media items matching colorName when provided', async () => {
    setupOMGMock([
      makeMediaItem('https://example.com/black-front.jpg', [1007], 'Black'),
      makeMediaItem('https://example.com/navy-front.jpg', [1007], 'Navy'),
    ]);

    // Score first call as 75, second as 85
    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(75))
      .mockResolvedValueOnce(makeQualityResult(85));

    // When colorName='Black', only the Black image should be scored
    const result = await sourceImages('L00550', 'Black');
    expect(result.front?.url).toBe('https://example.com/black-front.jpg');
  });
});

// ---------------------------------------------------------------------------
// describe('fetchCSWImages') — tested via sourceImages with OMG/S&S disabled
// ---------------------------------------------------------------------------

describe('fetchCSWImages (via sourceImages with OMG/S&S disabled)', () => {
  beforeEach(() => {
    delete process.env.SS_ACCOUNT_NUMBER;
    delete process.env.SS_API_KEY;
    process.env.ONESOURCE_KEY_ID = 'test-key-id';
    process.env.ONESOURCE_KEY_PASSWORD = 'test-password';
    process.env.CSW_SUPPLIER_CODE = 'CANADASPORTSWEAR';

    mockDownloadImage.mockResolvedValue(makeDummyBuffer());
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(80));

    // OMG returns nothing by default
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockResolvedValue({}),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.ONESOURCE_KEY_ID;
    delete process.env.ONESOURCE_KEY_PASSWORD;
    delete process.env.CSW_SUPPLIER_CODE;
  });

  it('returns front view from CSW product search result (SRC-03)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `<html><body>
          <a href="/products/l00550-vault-adult-pullover-hooded-sweatshirt">Product</a>
        </body></html>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          product: {
            images: [{ src: 'https://canadasportswear.com/cdn/shop/files/L00550-Black-front.jpg' }],
          },
        }),
      })
    );

    const result = await sourceImages('L00550');
    expect(result.front?.url).toBe(
      'https://canadasportswear.com/cdn/shop/files/L00550-Black-front.jpg',
    );
  });

  it('returns only front, never back or side (SRC-03)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `<html><body>
          <a href="/products/l00550-vault">Product</a>
        </body></html>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          product: {
            images: [{ src: 'https://canadasportswear.com/cdn/shop/files/L00550-front.jpg' }],
          },
        }),
      })
    );

    const result = await sourceImages('L00550');
    expect(result.front).not.toBeNull();
    // CSW never provides back or side — these come only from OMG/S&S
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });

  it('returns null front when CSW search returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body><p>No results found</p></body></html>',
      })
    );

    const result = await sourceImages('L00550');
    expect(result.front).toBeNull();
  });

  it('returns null front on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await sourceImages('L00550');
    expect(result.front).toBeNull();
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describe('fetchSSCanadaImages') — tested via sourceImages with OMG/CSW disabled
// ---------------------------------------------------------------------------

describe('fetchSSCanadaImages (via sourceImages with OMG/CSW disabled)', () => {
  const savedAccountNumber = process.env.SS_ACCOUNT_NUMBER;
  const savedApiKey = process.env.SS_API_KEY;

  beforeEach(() => {
    process.env.ONESOURCE_KEY_ID = 'test-key-id';
    process.env.ONESOURCE_KEY_PASSWORD = 'test-password';
    process.env.CSW_SUPPLIER_CODE = 'CANADASPORTSWEAR';

    mockDownloadImage.mockResolvedValue(makeDummyBuffer());
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(70));

    // OMG returns nothing
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockResolvedValue({}),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([]);

    // CSW returns no search results
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => ({}),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.ONESOURCE_KEY_ID;
    delete process.env.ONESOURCE_KEY_PASSWORD;
    delete process.env.CSW_SUPPLIER_CODE;
    // Restore S&S vars
    if (savedAccountNumber !== undefined) {
      process.env.SS_ACCOUNT_NUMBER = savedAccountNumber;
    } else {
      delete process.env.SS_ACCOUNT_NUMBER;
    }
    if (savedApiKey !== undefined) {
      process.env.SS_API_KEY = savedApiKey;
    } else {
      delete process.env.SS_API_KEY;
    }
  });

  function setupSSFetch(
    products: Array<{
      colorFrontImage?: string;
      colorBackImage?: string;
      colorSideImage?: string;
    }>,
    capturedHeaders?: { value?: string },
  ) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      // CSW search: return no results
      if (typeof url === 'string' && url.includes('canadasportswear.com')) {
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }
      // S&S API
      if (capturedHeaders) {
        capturedHeaders.value = (init?.headers as Record<string, string>)?.['Authorization'];
      }
      return {
        ok: true,
        json: async () => products,
      };
    }));
  }

  it('returns front/back/side from REST API response fields (SRC-02)', async () => {
    process.env.SS_ACCOUNT_NUMBER = 'acct123';
    process.env.SS_API_KEY = 'key456';

    setupSSFetch([{
      colorFrontImage: 'Images/Color/17130_fm.jpg',
      colorBackImage: 'Images/Color/17130_b_fm.jpg',
      colorSideImage: 'Images/Color/17130_s_fm.jpg',
    }]);

    mockScoreImageQuality
      .mockResolvedValueOnce(makeQualityResult(80))
      .mockResolvedValueOnce(makeQualityResult(65))
      .mockResolvedValueOnce(makeQualityResult(70));

    const result = await sourceImages('17130');

    expect(result.front).not.toBeNull();
    expect(result.back).not.toBeNull();
    expect(result.side).not.toBeNull();
  });

  it('constructs URL with _fl suffix replacing _fm (SRC-02)', async () => {
    process.env.SS_ACCOUNT_NUMBER = 'acct123';
    process.env.SS_API_KEY = 'key456';

    let capturedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('ssactivewear.com/v2')) {
        return {
          ok: true,
          json: async () => [{
            colorBackImage: 'Images/Color/17130_b_fm.jpg',
          }],
        };
      }
      if (typeof url === 'string' && url.includes('canadasportswear.com')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      return { ok: true, json: async () => ({}) };
    }));

    mockDownloadImage.mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      return makeDummyBuffer();
    });

    await sourceImages('17130');

    // The back image URL should have _fl not _fm
    expect(capturedUrls).toContain(
      'https://www.ssactivewear.com/Images/Color/17130_b_fl.jpg',
    );
  });

  it('returns {} when SS_ACCOUNT_NUMBER not set (SRC-02 graceful degradation)', async () => {
    delete process.env.SS_ACCOUNT_NUMBER;
    process.env.SS_API_KEY = 'key456';

    const result = await sourceImages('17130');
    // No S&S images, but no throw
    expect(result.front).toBeNull();
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });

  it('returns {} when SS_API_KEY not set (SRC-02 graceful degradation)', async () => {
    process.env.SS_ACCOUNT_NUMBER = 'acct123';
    delete process.env.SS_API_KEY;

    const result = await sourceImages('17130');
    expect(result.front).toBeNull();
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });

  it('returns {} on HTTP error response from S&S API', async () => {
    process.env.SS_ACCOUNT_NUMBER = 'acct123';
    process.env.SS_API_KEY = 'key456';

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('ssactivewear.com')) {
        return { ok: false, status: 401, json: async () => [] };
      }
      return { ok: false, status: 404, text: async () => '' };
    }));

    const result = await sourceImages('17130');
    expect(result.front).toBeNull();
  });

  it('sends correct Basic auth header', async () => {
    process.env.SS_ACCOUNT_NUMBER = 'myaccount';
    process.env.SS_API_KEY = 'mysecretkey';

    const capturedHeaders: { value?: string } = {};
    setupSSFetch([{ colorFrontImage: 'Images/Color/test_fm.jpg' }], capturedHeaders);

    await sourceImages('17130');

    const expected = `Basic ${Buffer.from('myaccount:mysecretkey').toString('base64')}`;
    expect(capturedHeaders.value).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// describe('sourceImages') — integration-level with all suppliers mocked
// ---------------------------------------------------------------------------

describe('sourceImages', () => {
  beforeEach(() => {
    process.env.SS_ACCOUNT_NUMBER = 'acct123';
    process.env.SS_API_KEY = 'key456';
    process.env.ONESOURCE_KEY_ID = 'test-key-id';
    process.env.ONESOURCE_KEY_PASSWORD = 'test-password';
    process.env.CSW_SUPPLIER_CODE = 'CANADASPORTSWEAR';

    mockDownloadImage.mockResolvedValue(makeDummyBuffer());
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(75));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.SS_ACCOUNT_NUMBER;
    delete process.env.SS_API_KEY;
    delete process.env.ONESOURCE_KEY_ID;
    delete process.env.ONESOURCE_KEY_PASSWORD;
    delete process.env.CSW_SUPPLIER_CODE;
  });

  it('merges results from all three suppliers, picking highest score per view (SRC-04)', async () => {
    // OMG returns front with score based on URL
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockResolvedValue({}),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([
      makeMediaItem('https://omg.example.com/front.jpg', [1007]),
    ]);

    // CSW returns front with highest score, S&S returns back/side
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('canadasportswear.com/search')) {
        return {
          ok: true,
          text: async () => '<html><body><a href="/products/l00550">P</a></body></html>',
        };
      }
      if (typeof url === 'string' && url.includes('canadasportswear.com/products/')) {
        return {
          ok: true,
          json: async () => ({
            product: { images: [{ src: 'https://csw.example.com/front.jpg' }] },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('ssactivewear.com')) {
        return {
          ok: true,
          json: async () => [{
            colorFrontImage: 'Images/Color/ss_front_fm.jpg',
            colorBackImage: 'Images/Color/ss_back_fm.jpg',
            colorSideImage: 'Images/Color/ss_side_fm.jpg',
          }],
        };
      }
      return { ok: false, status: 404 };
    }));

    // Score by URL so results are deterministic regardless of call order
    mockDownloadImage.mockResolvedValue(makeDummyBuffer());
    mockScoreImageQuality.mockImplementation(async () => makeQualityResult(50));

    // Override: CSW front URL gets score 90 (should win)
    // We do this by making downloadImage return a distinguishable buffer per URL
    // and scoreImageQuality check the buffer content
    let callCount = 0;
    const urlScores: Record<string, number> = {
      'https://omg.example.com/front.jpg': 50,
      'https://csw.example.com/front.jpg': 90,
      'https://www.ssactivewear.com/Images/Color/ss_front_fl.jpg': 60,
      'https://www.ssactivewear.com/Images/Color/ss_back_fl.jpg': 85,
      'https://www.ssactivewear.com/Images/Color/ss_side_fl.jpg': 70,
    };

    // Track which URL each downloadImage call corresponds to
    const downloadOrder: string[] = [];
    mockDownloadImage.mockImplementation(async (url: string) => {
      downloadOrder.push(url);
      const score = urlScores[url] ?? 50;
      return Buffer.from(`score:${score}`);
    });
    mockScoreImageQuality.mockImplementation(async (buf: Buffer) => {
      const content = buf.toString();
      const match = content.match(/score:(\d+)/);
      const score = match ? parseInt(match[1]) : 50;
      return makeQualityResult(score);
    });

    const result = await sourceImages('L00550');

    // CSW wins front (score 90 beats OMG 50 and S&S 60)
    expect(result.front?.url).toBe('https://csw.example.com/front.jpg');
    expect(result.front?.score).toBe(90);

    // S&S provides back and side (only supplier with those views)
    expect(result.back).not.toBeNull();
    expect(result.side).not.toBeNull();
  });

  it('continues when one supplier rejects — Promise.allSettled behavior (SRC-04)', async () => {
    // OMG throws
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockRejectedValue(new Error('OMG down')),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([]);

    // CSW succeeds with front
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('canadasportswear.com/search')) {
        return {
          ok: true,
          text: async () => '<html><body><a href="/products/l00550">P</a></body></html>',
        };
      }
      if (typeof url === 'string' && url.includes('canadasportswear.com/products/')) {
        return {
          ok: true,
          json: async () => ({
            product: { images: [{ src: 'https://csw.example.com/front.jpg' }] },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('ssactivewear.com')) {
        return { ok: false, status: 500 };
      }
      return { ok: false, status: 404 };
    }));

    const result = await sourceImages('L00550');

    // Even though OMG failed, CSW still contributed
    expect(result.front).not.toBeNull();
    expect(result.front?.url).toBe('https://csw.example.com/front.jpg');
  });

  it('returns null for views with no candidates (D-06)', async () => {
    // All suppliers return nothing
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockResolvedValue({}),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => [],
    }));

    const result = await sourceImages('L00550');
    expect(result.front).toBeNull();
    expect(result.back).toBeNull();
    expect(result.side).toBeNull();
  });

  it('returns failed-quality image rather than null when image exists but fails scoring (D-03)', async () => {
    // OMG returns a front image that scores poorly
    mockCreateOneSourceClient.mockReturnValue({
      getMediaContent: vi.fn().mockResolvedValue({}),
      getProduct: vi.fn(),
      getProductDateModified: vi.fn(),
      soapRequest: vi.fn(),
    });
    mockParseMediaContentFromXml.mockReturnValue([
      makeMediaItem('https://omg.example.com/bad-front.jpg', [1007]),
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
      json: async () => [],
    }));

    // Image fails quality scoring
    mockScoreImageQuality.mockResolvedValue(makeQualityResult(20, 'fail'));

    const result = await sourceImages('L00550');

    // The failed image should still be returned (for Phase 10 AI enhancement)
    expect(result.front).not.toBeNull();
    expect(result.front?.verdict).toBe('fail');
    expect(result.front?.score).toBe(20);
    expect(result.front?.url).toBe('https://omg.example.com/bad-front.jpg');
  });
});
