/**
 * Unit tests for gen-categories-keywords.ts pure-core functions.
 *
 * These tests make NO network calls and do NOT require ANTHROPIC_API_KEY.
 * The Anthropic client is dependency-injected (DI'd) everywhere.
 *
 * Coverage:
 *   - groupRowsByProductId: correct grouping, empty-pid skipping
 *   - buildUpdatesForProduct: fan-out identical values across all rows,
 *     idempotent skip-if-filled, null-resolving baseCategory leave-unchanged (D-07),
 *     row-1 guard (P5), KW-02 dirty-keyword drop
 *   - classifyProduct: DI'd client, quota vs rate-limit error distinction
 */

import { describe, it, expect, vi } from 'vitest';
import {
  groupRowsByProductId,
  buildUpdatesForProduct,
  classifyProduct,
} from './gen-categories-keywords.js';
import type { BuildUpdatesInput, CategoryOutput } from './gen-categories-keywords.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal valid CategoryOutput matching the schema. */
const VALID_RESULT: CategoryOutput = {
  baseCategory: 'T-Shirts',
  categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > T-Shirts',
  keywords: [
    'cotton-tee',
    'crew-neck',
    'short-sleeve',
    'casual',
    'everyday',
    'lightweight',
    'unisex',
    'custom-shirt',
  ],
};

/** Column names in test order (matches SheetRow field order loosely). */
const HEADERS = [
  'productId',     // 0
  'colorName',     // 1
  'productName',   // 2
  'baseCategory',  // 3
  'categories',    // 4
  'keywords',      // 5
  'gender',        // 6
  'description',   // 7
  'brandName',     // 8
  'fit',           // 9
  'weightGSM',     // 10
];

const IDX = {
  id: 0,
  color: 1,
  productName: 2,
  baseCat: 3,
  cat: 4,
  kw: 5,
  gender: 6,
};

/** Build a minimal data row aligned to HEADERS. */
function makeRow(
  pid: string,
  color: string,
  baseCat = '',
  cat = '',
  kw = '',
): string[] {
  const row = new Array<string>(HEADERS.length).fill('');
  row[IDX.id] = pid;
  row[IDX.color] = color;
  row[IDX.baseCat] = baseCat;
  row[IDX.cat] = cat;
  row[IDX.kw] = kw;
  return row;
}

/** Build a BuildUpdatesInput for 3 rows of the same product. */
function makeInput(
  rows: string[][],
  result: CategoryOutput = VALID_RESULT,
  overrides?: Partial<BuildUpdatesInput>,
): BuildUpdatesInput {
  const rowsForPid = rows.map((row, i) => ({ rowIndex: i, row }));
  return {
    productResult: result,
    rowsForPid,
    headers: HEADERS,
    idColIdx: IDX.id,
    colorColIdx: IDX.color,
    catColIdx: IDX.cat,
    keywordsColIdx: IDX.kw,
    baseCatColIdx: IDX.baseCat,
    tab: 'Bestsellers-Ready',
    ...overrides,
  };
}

// ─── groupRowsByProductId ─────────────────────────────────────────────────────

describe('groupRowsByProductId', () => {
  it('groups rows by productId (trimmed+uppercased)', () => {
    const dataRows = [
      makeRow('G18500', 'Black'),
      makeRow('G18500', 'Navy'),
      makeRow('G18500', 'Red'),
      makeRow('PC61', 'White'),
      makeRow('PC61', 'Royal'),
    ];

    const { groups, skipped_no_pid } = groupRowsByProductId(dataRows, IDX.id);

    expect(groups.size).toBe(2);
    expect(groups.get('G18500')?.length).toBe(3);
    expect(groups.get('PC61')?.length).toBe(2);
    expect(skipped_no_pid).toBe(0);
  });

  it('normalises pid to trimmed uppercase', () => {
    const dataRows = [
      makeRow('  g18500  ', 'Black'),
      makeRow('G18500', 'Navy'),
    ];

    const { groups } = groupRowsByProductId(dataRows, IDX.id);
    expect(groups.size).toBe(1);
    expect(groups.get('G18500')?.length).toBe(2);
  });

  it('skips rows with empty productId', () => {
    const dataRows = [
      makeRow('', 'Black'),
      makeRow('G18500', 'Navy'),
      makeRow('   ', 'Red'),
    ];

    const { groups, skipped_no_pid } = groupRowsByProductId(dataRows, IDX.id);
    expect(groups.size).toBe(1);
    expect(skipped_no_pid).toBe(2);
  });

  it('preserves correct rowIndex (0-based) for sheetRow math', () => {
    const dataRows = [
      makeRow('G18500', 'Black'),  // rowIndex 0 → sheetRow 2
      makeRow('G18500', 'Navy'),   // rowIndex 1 → sheetRow 3
    ];

    const { groups } = groupRowsByProductId(dataRows, IDX.id);
    const entries = groups.get('G18500')!;
    expect(entries[0].rowIndex).toBe(0);
    expect(entries[1].rowIndex).toBe(1);
  });
});

// ─── buildUpdatesForProduct ───────────────────────────────────────────────────

describe('buildUpdatesForProduct', () => {
  it('fans identical values to ALL rows of a product (D-11)', () => {
    const rows = [
      makeRow('G18500', 'Black'),
      makeRow('G18500', 'Navy'),
      makeRow('G18500', 'Red'),
    ];

    const { updates } = buildUpdatesForProduct(makeInput(rows));

    // 3 columns × 3 rows = 9 updates (all cells empty so all get written).
    expect(updates.length).toBe(9);

    // All baseCategory updates have the same new value.
    const baseCatUpdates = updates.filter(u => u.values[0][0] === 'T-Shirts');
    expect(baseCatUpdates.length).toBe(3);

    // All categoriesPath updates have the same value.
    const catUpdates = updates.filter(u =>
      u.values[0][0] === VALID_RESULT.categoriesPath,
    );
    expect(catUpdates.length).toBe(3);

    // All keyword updates have the same value.
    const kwValue = VALID_RESULT.keywords.join(', ');
    const kwUpdates = updates.filter(u => u.values[0][0] === kwValue);
    expect(kwUpdates.length).toBe(3);
  });

  it('writes to correct sheetRow ranges (rowIndex 0 → row 2, etc.)', () => {
    const rows = [
      makeRow('G18500', 'Black'),   // rowIndex 0 → sheetRow 2
      makeRow('G18500', 'Navy'),    // rowIndex 1 → sheetRow 3
    ];

    const { updates } = buildUpdatesForProduct(makeInput(rows));

    // Each update range must reference row >= 2.
    for (const u of updates) {
      const match = u.range.match(/(\d+)$/);
      const rowNum = parseInt(match?.[1] ?? '0', 10);
      expect(rowNum).toBeGreaterThanOrEqual(2);
    }

    // First data row should map to row 2.
    const row2Updates = updates.filter(u => u.range.endsWith('2'));
    expect(row2Updates.length).toBe(3); // one per column
  });

  it('OPS-02: skips cells that already hold the target value (idempotent)', () => {
    const kwValue = VALID_RESULT.keywords.join(', ');

    const rows = [
      // Row 0: all 3 columns already filled with the exact target values.
      makeRow('G18500', 'Black', 'T-Shirts', VALID_RESULT.categoriesPath, kwValue),
    ];

    const { updates, stats } = buildUpdatesForProduct(makeInput(rows));

    expect(updates.length).toBe(0);
    expect(stats.skipped_already_current).toBe(3);
    expect(stats.written_new).toBe(0);
    expect(stats.overwritten_changed).toBe(0);
  });

  it('OPS-02: partial idempotency — only writes the cells that differ', () => {
    const kwValue = VALID_RESULT.keywords.join(', ');

    const rows = [
      // keywords already current; baseCategory and categories are empty.
      makeRow('G18500', 'Black', '', '', kwValue),
    ];

    const { updates, stats } = buildUpdatesForProduct(makeInput(rows));

    // Should write baseCat + cat (2 updates), skip kw (1 skipped).
    expect(updates.length).toBe(2);
    expect(stats.skipped_already_current).toBe(1);
    expect(stats.written_new).toBe(2);
  });

  it('D-07: leaves baseCategory unchanged when getCategoryGroup returns null', () => {
    // 'Caps' is NOT in SAFE_BASE_CATEGORIES — getCategoryGroup returns null.
    // This simulates the model somehow returning an unsafe value.
    // We inject it directly (bypassing the Zod schema) to test the post-validation gate.
    const unsafeResult: CategoryOutput = {
      ...(VALID_RESULT as any),
      baseCategory: 'T-Shirts', // still uses a valid schema value
    };

    // But we can't easily inject a truly null-resolving value via the typed interface
    // because the schema constrains it. Test the gate via direct manipulation:
    const unsafeResultManual = {
      baseCategory: 'Caps' as any, // getCategoryGroup('Caps') returns null
      categoriesPath: VALID_RESULT.categoriesPath,
      keywords: VALID_RESULT.keywords,
    } as CategoryOutput;

    const rows = [
      makeRow('H08050', 'Black', 'Caps'), // existing value is 'Caps'
    ];

    const { updates, stats, preview } = buildUpdatesForProduct(
      makeInput(rows, unsafeResultManual),
    );

    // No baseCategory update should be emitted — leave existing 'Caps'.
    const baseCatUpdates = updates.filter(u => u.range.includes(`D`)); // col D = baseCat idx 3
    // More precisely: no update value should equal 'Caps' (the unsafe value).
    const capUpdates = updates.filter(u => u.values[0][0] === 'Caps');
    expect(capUpdates.length).toBe(0);

    // Flag counter must be incremented.
    expect(stats.flagged_unsafe_basecat).toBe(1);

    // Preview should reflect old value unchanged.
    expect(preview.baseCategory_changed).toBe(false);
    expect(preview.baseCategory_new).toBe('Caps'); // stays as existing
  });

  it('P5: row-1 guard — rowIndex -1 throws (defensive assertion)', () => {
    const rows = [makeRow('G18500', 'Black')];
    const rowsForPid = [{ rowIndex: -1, row: rows[0] }]; // invalid: sheetRow would be 1

    expect(() =>
      buildUpdatesForProduct(makeInput(rows, VALID_RESULT, { rowsForPid })),
    ).toThrow(/Row-1 guard violated/);
  });

  it('D-14: flags baseCategory change in preview when decoration-affecting', () => {
    const rows = [
      makeRow('G18500', 'Black', 'Hoodies'), // old value is Hoodies
    ];

    // New baseCategory is T-Shirts — different from existing 'Hoodies'.
    const { preview } = buildUpdatesForProduct(makeInput(rows));

    expect(preview.baseCategory_old).toBe('Hoodies');
    expect(preview.baseCategory_new).toBe('T-Shirts');
    expect(preview.baseCategory_changed).toBe(true);
  });

  it('D-14: no change flag when baseCategory is unchanged', () => {
    const rows = [
      makeRow('G18500', 'Black', 'T-Shirts'), // already the target value
    ];

    const { preview } = buildUpdatesForProduct(makeInput(rows));

    expect(preview.baseCategory_changed).toBe(false);
  });

  it('KW-02: dirty keywords from model are dropped before fan-out', () => {
    // Inject a result where the model returned dirty keywords that passed schema
    // (e.g. via type casting). The belt-and-suspenders pass should drop them.
    const dirtyResult: CategoryOutput = {
      ...VALID_RESULT,
      keywords: [
        'cotton-tee',      // clean
        'black',           // BLOCKED_COLORS — should be dropped
        'xl',              // BLOCKED_SIZES — should be dropped
        'casual',          // clean
        'everyday',        // clean
        'lightweight',     // clean
        'unisex',          // clean
        'custom-shirt',    // clean
      ],
    };

    const rows = [makeRow('G18500', 'Black')];
    const { updates } = buildUpdatesForProduct(makeInput(rows, dirtyResult));

    // Find the keywords update.
    const kwUpdate = updates.find(u => {
      const val = u.values[0][0];
      return val.includes('cotton-tee');
    });

    expect(kwUpdate).toBeDefined();
    const kwValue = kwUpdate!.values[0][0];

    // Dirty keywords must not appear.
    expect(kwValue).not.toContain('black');
    expect(kwValue).not.toContain(', xl,');
    expect(kwValue).not.toMatch(/\bxl\b/);

    // Clean keywords must be present.
    expect(kwValue).toContain('cotton-tee');
    expect(kwValue).toContain('casual');
  });

  it('correctly counts written_new vs overwritten_changed', () => {
    const rows = [
      makeRow('G18500', 'Black', '', 'old-cat-path', ''), // cat is non-empty and different
    ];

    const { stats } = buildUpdatesForProduct(makeInput(rows));

    // baseCat: empty → written_new
    // cat: non-empty + different → overwritten_changed
    // kw: empty → written_new
    expect(stats.written_new).toBe(2);
    expect(stats.overwritten_changed).toBe(1);
  });

  it('emits correct column letter in range for each column', () => {
    // With HEADERS: productId=0, colorName=1, productName=2, baseCategory=3,
    //               categories=4, keywords=5
    // Column indices 3,4,5 → letters D,E,F
    const rows = [makeRow('G18500', 'Black')];
    const { updates } = buildUpdatesForProduct(makeInput(rows));

    const ranges = updates.map(u => u.range);

    // baseCatColIdx=3 → D
    expect(ranges.some(r => r.includes('!D'))).toBe(true);
    // catColIdx=4 → E
    expect(ranges.some(r => r.includes('!E'))).toBe(true);
    // keywordsColIdx=5 → F
    expect(ranges.some(r => r.includes('!F'))).toBe(true);
  });
});

// ─── classifyProduct (DI'd — no live API calls) ───────────────────────────────

describe('classifyProduct', () => {
  const PROMPT_INPUT = {
    productName: 'Gildan 18500 Heavy Blend Hooded Sweatshirt',
    description: 'Classic pullover hoodie in cotton-polyester blend.',
    brandName: 'Gildan',
    gender: 'Unisex',
    fit: 'Regular',
    weightGSM: '271',
    currentBaseCategory: 'Hoodies',
  };

  it('returns the parsed result from a DI client (no network call)', async () => {
    const mockResult = {
      parsed: {
        baseCategory: 'Hoodies',
        categoriesPath: 'Apparel & Accessories > Clothing > Clothing Tops > Hoodies & Sweatshirts',
        keywords: [
          'pullover-hoodie',
          'fleece-hoodie',
          'heavyweight',
          'cotton-poly',
          'casual-wear',
          'crew-neck',
          'warm-hoodie',
          'unisex-hoodie',
        ],
      },
    };

    const mockClient = {
      messages: {
        parse: vi.fn().mockResolvedValue(mockResult),
      },
    } as any;

    const result = await classifyProduct(PROMPT_INPUT, mockClient);

    expect(result.baseCategory).toBe('Hoodies');
    expect(result.keywords.length).toBeGreaterThanOrEqual(8);
    expect(mockClient.messages.parse).toHaveBeenCalledTimes(1);

    // Verify the call used the correct model and no effort param.
    const callArgs = mockClient.messages.parse.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5');
    expect(callArgs.effort).toBeUndefined();
    expect(callArgs.output_config).toBeDefined();
    expect(callArgs.output_config.format).toBeDefined();
  });

  it('retries on transient rate-limit (429 non-quota) then succeeds', async () => {
    const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
    const mockResult = { parsed: VALID_RESULT };

    const mockClient = {
      messages: {
        parse: vi
          .fn()
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValue(mockResult),
      },
    } as any;

    const result = await classifyProduct(PROMPT_INPUT, mockClient);

    expect(result.baseCategory).toBe(VALID_RESULT.baseCategory);
    expect(mockClient.messages.parse).toHaveBeenCalledTimes(2);
  });

  it('throws quota error immediately (no retry) and sets isQuotaExhausted=true', async () => {
    const quotaError = Object.assign(
      new Error('You have exceeded your usage quota'),
      { status: 429 },
    );

    const mockClient = {
      messages: {
        parse: vi.fn().mockRejectedValue(quotaError),
      },
    } as any;

    try {
      await classifyProduct(PROMPT_INPUT, mockClient);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.isQuotaExhausted).toBe(true);
      // Should not retry on quota error — only 1 call.
      expect(mockClient.messages.parse).toHaveBeenCalledTimes(1);
    }
  });

  it('rethrows non-429 errors immediately', async () => {
    const networkError = new Error('ECONNRESET');

    const mockClient = {
      messages: {
        parse: vi.fn().mockRejectedValue(networkError),
      },
    } as any;

    await expect(classifyProduct(PROMPT_INPUT, mockClient)).rejects.toThrow('ECONNRESET');
    // Non-rate-limit error: no retry.
    expect(mockClient.messages.parse).toHaveBeenCalledTimes(1);
  });

  it('throws if result.parsed is empty', async () => {
    const mockResult = { parsed: null };

    const mockClient = {
      messages: {
        parse: vi.fn().mockResolvedValue(mockResult),
      },
    } as any;

    await expect(classifyProduct(PROMPT_INPUT, mockClient)).rejects.toThrow(
      /result\.parsed is empty/,
    );
  });
});
