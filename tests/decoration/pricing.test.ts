import { describe, it, expect } from 'vitest';
import { calculateSellPrice, estimateStitchCount } from '../../src/decoration/pricing.js';
import { PricingInputSchema } from '../../src/decoration/types.js';

describe('calculateSellPrice', () => {
  it('reference case: $7.80 garment, 1 print, 45% discount = $14.08', () => {
    const result = calculateSellPrice({
      garmentCost: 7.80,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.sellPrice).toBe(14.08);
  });

  it('reference case gross margin is ~44.6%', () => {
    const result = calculateSellPrice({
      garmentCost: 7.80,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.grossMargin).toBe(0.4460);
  });

  it('0 decorations returns msrp * (1 - discount) as sell price', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 0,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.msrp).toBe(20);
    expect(result.printCost).toBe(0);
    expect(result.embroideryCost).toBe(0);
    expect(result.sellPrice).toBe(11);
  });

  it('2 print areas: printCost = 10 + 6 = 16', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 2,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0,
    });
    expect(result.printCost).toBe(16);
  });

  it('3 print areas: printCost = 10 + 6 + 6 = 22', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 3,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0,
    });
    expect(result.printCost).toBe(22);
  });

  it('1 embroidery area, 5000 stitches: embroideryCost = 20', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 0,
      embroideryAreas: 1,
      stitchCount: 5000,
      discountPercent: 0,
    });
    expect(result.embroideryCost).toBe(20);
  });

  it('1 embroidery area, 8000 stitches (boundary): embroideryCost = 20', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 0,
      embroideryAreas: 1,
      stitchCount: 8000,
      discountPercent: 0,
    });
    expect(result.embroideryCost).toBe(20);
  });

  it('1 embroidery area, 10000 stitches: embroideryCost = 10 + 0.80 * 10 = 18', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 0,
      embroideryAreas: 1,
      stitchCount: 10000,
      discountPercent: 0,
    });
    expect(result.embroideryCost).toBe(18);
  });

  it('1 embroidery area, 21120 stitches (stitch estimator example)', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 0,
      embroideryAreas: 1,
      stitchCount: 21120,
      discountPercent: 0,
    });
    // 10 + 0.80 * 21.12 = 10 + 16.896 = 26.896
    expect(result.embroideryCost).toBeCloseTo(26.896, 2);
  });

  it('grossMargin = (sellPrice - garmentCost) / sellPrice', () => {
    const result = calculateSellPrice({
      garmentCost: 10,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0,
    });
    // msrp=20, printCost=10, total=30, discount=0, sellPrice=30
    // margin = (30 - 10) / 30 = 0.6667
    expect(result.grossMargin).toBe(0.6667);
  });

  it('sellPrice is rounded to 2 decimal places', () => {
    const result = calculateSellPrice({
      garmentCost: 7.33,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.33,
    });
    // msrp=14.66, printCost=10, total=24.66, discount=24.66*0.33=8.1378, sell=16.5222
    const sellStr = result.sellPrice.toString();
    const decimals = sellStr.split('.')[1];
    expect(!decimals || decimals.length <= 2).toBe(true);
  });
});

describe('estimateStitchCount', () => {
  it('estimates 21120 stitches for 11x4 at 40% coverage', () => {
    expect(estimateStitchCount(11, 4, 0.40)).toBe(21120);
  });

  it('uses 40% coverage as default', () => {
    expect(estimateStitchCount(11, 4)).toBe(21120);
  });
});

describe('PricingInputSchema validation', () => {
  it('rejects negative garmentCost', () => {
    const result = PricingInputSchema.safeParse({
      garmentCost: -5,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative printAreas', () => {
    const result = PricingInputSchema.safeParse({
      garmentCost: 10,
      printAreas: -1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.success).toBe(false);
  });

  it('rejects discountPercent > 1', () => {
    const result = PricingInputSchema.safeParse({
      garmentCost: 10,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid input', () => {
    const result = PricingInputSchema.safeParse({
      garmentCost: 7.80,
      printAreas: 1,
      embroideryAreas: 0,
      stitchCount: 0,
      discountPercent: 0.45,
    });
    expect(result.success).toBe(true);
  });
});
