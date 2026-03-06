// Stub - to be implemented
import type { PricingInput, PricingResult } from './types.js';

export function calculateSellPrice(_input: PricingInput): PricingResult {
  return { msrp: 0, printCost: 0, embroideryCost: 0, totalDecorationCost: 0, priceBeforeDiscount: 0, discount: 0, sellPrice: 0, grossMargin: 0 };
}

export function estimateStitchCount(_l: number, _w: number, _c: number = 0.40): number {
  return 0;
}
