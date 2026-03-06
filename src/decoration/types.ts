import { z } from 'zod';

export type DecorationMethod = 'Print' | 'Embroidery';

export type GarmentCategory =
  | 'T-Shirt'
  | 'Hoodie'
  | 'Cap'
  | 'Beanie'
  | 'Pants'
  | 'Long Sleeve'
  | 'Jacket';

export interface DecorationPlacement {
  method: DecorationMethod;
  bodyCategory: string;
  placementName: string;
  commonSizes: string;
  maxSize: string;
  verticalRef: string;
  horizontalRef: string;
  notes: string;
}

export interface PricingInput {
  garmentCost: number;
  printAreas: number;
  embroideryAreas: number;
  stitchCount: number;
  discountPercent: number;
}

export interface PricingResult {
  msrp: number;
  printCost: number;
  embroideryCost: number;
  totalDecorationCost: number;
  priceBeforeDiscount: number;
  discount: number;
  sellPrice: number;
  grossMargin: number;
}

export const PricingInputSchema = z.object({
  garmentCost: z.number().positive('garmentCost must be positive'),
  printAreas: z.number().int().min(0, 'printAreas must be >= 0'),
  embroideryAreas: z.number().int().min(0, 'embroideryAreas must be >= 0'),
  stitchCount: z.number().min(0, 'stitchCount must be >= 0'),
  discountPercent: z.number().min(0).max(1, 'discountPercent must be between 0 and 1'),
});
