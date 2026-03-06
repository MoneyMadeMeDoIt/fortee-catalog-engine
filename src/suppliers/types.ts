import { z } from 'zod';

// --- Interfaces ---

export interface ProductImage {
  url: string;
  alt?: string;
}

export interface SupplierVariant {
  color: string;
  size: string;
  sku?: string;
  price?: number;
  colorSwatchImage?: string;
  colorFrontImage?: string;
}

export interface SizeSpec {
  sizeName: string;
  specName: string;
  value: string;
}

export interface SupplierProduct {
  styleNumber: string;
  supplier: 'canada-sportswear' | 'ss-canada';
  title: string;
  description: string;
  category: string;
  fabricComposition: string;
  sizeChartUrl: string | null;
  sizeChartData: SizeSpec[] | null;
  images: ProductImage[];
  variants: SupplierVariant[];
  isCloseout: boolean;
  rawData: unknown;
}

export interface SupplierAdapter {
  readonly supplier: 'canada-sportswear' | 'ss-canada';
  fetchProducts(): Promise<SupplierProduct[]>;
  fetchProduct(identifier: string): Promise<SupplierProduct>;
}

// --- Zod Schemas ---

export const ProductImageSchema = z.object({
  url: z.string().url(),
  alt: z.string().optional(),
});

export const SupplierVariantSchema = z.object({
  color: z.string().min(1),
  size: z.string().min(1),
  sku: z.string().optional(),
  price: z.number().optional(),
  colorSwatchImage: z.string().optional(),
  colorFrontImage: z.string().optional(),
});

export const SizeSpecSchema = z.object({
  sizeName: z.string(),
  specName: z.string(),
  value: z.string(),
});

export const SupplierProductSchema = z.object({
  styleNumber: z.string().min(1),
  supplier: z.enum(['canada-sportswear', 'ss-canada']),
  title: z.string().min(1),
  description: z.string().min(10),
  category: z.string(),
  fabricComposition: z.string().min(5),
  sizeChartUrl: z.string().url().nullable(),
  sizeChartData: z.array(SizeSpecSchema).nullable(),
  images: z.array(ProductImageSchema).min(1),
  variants: z.array(SupplierVariantSchema).min(1),
  isCloseout: z.boolean(),
  rawData: z.unknown(),
});

// --- Validation ---

export type ValidationResult =
  | { valid: true; data: SupplierProduct }
  | { valid: false; errors: string[] };

export function validateProduct(product: unknown): ValidationResult {
  const result = SupplierProductSchema.safeParse(product);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return { valid: false, errors };
  }
  return { valid: true, data: result.data as SupplierProduct };
}
