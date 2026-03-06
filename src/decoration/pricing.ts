import type { PricingInput, PricingResult } from './types.js';

/**
 * Calculates the full sell price for a product based on garment cost,
 * decoration areas, and volume discount.
 *
 * Formula (from Calculateur pour IA.xlsx):
 * - MSRP = garmentCost * 2
 * - Print: first area $10, each additional $6
 * - Embroidery: <= 8000 stitches = $20/area, > 8000 = ($10 + $0.80/1000 stitches)/area
 * - sellPrice = (MSRP + decorationCost) * (1 - discount)
 */
export function calculateSellPrice(input: PricingInput): PricingResult {
  const msrp = input.garmentCost * 2;

  // Print cost: first area $10, each additional $6
  let printCost = 0;
  if (input.printAreas > 0) {
    printCost = 10 + Math.max(0, input.printAreas - 1) * 6;
  }

  // Embroidery cost: depends on stitch count threshold
  let embroideryCost = 0;
  if (input.embroideryAreas > 0) {
    if (input.stitchCount <= 8000) {
      embroideryCost = 20 * input.embroideryAreas;
    } else {
      embroideryCost = (10 + 0.80 * (input.stitchCount / 1000)) * input.embroideryAreas;
    }
  }

  const totalDecorationCost = printCost + embroideryCost;
  const priceBeforeDiscount = msrp + totalDecorationCost;
  const discount = priceBeforeDiscount * input.discountPercent;
  const sellPrice = Math.round((priceBeforeDiscount - discount) * 100) / 100;
  const grossMargin = sellPrice > 0
    ? Math.round(((sellPrice - input.garmentCost) / sellPrice) * 10000) / 10000
    : 0;

  return {
    msrp,
    printCost,
    embroideryCost,
    totalDecorationCost,
    priceBeforeDiscount,
    discount,
    sellPrice,
    grossMargin,
  };
}

/**
 * Estimates stitch count from logo dimensions.
 * Formula: length * width * coverage * 1200 stitches per square inch.
 */
export function estimateStitchCount(
  lengthInches: number,
  widthInches: number,
  coveragePercent: number = 0.40,
): number {
  return Math.round(lengthInches * widthInches * coveragePercent * 1200);
}
