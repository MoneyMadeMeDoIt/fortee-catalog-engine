/** Shopify GraphQL Admin API input types for productSet mutation. */

export interface ProductOptionValueInput {
  name: string;
}

export interface ProductOptionInput {
  name: string;
  position: number;
  values?: ProductOptionValueInput[];
  linkedMetafield?: {
    namespace: string;
    key: string;
    values: string[];
  };
}

export interface VariantOptionValueInput {
  optionName: string;
  name: string;
  linkedMetafieldValue?: string;
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface ProductVariantSetInput {
  optionValues: VariantOptionValueInput[];
  price: number;
  sku: string;
  barcode: string;
  metafields?: MetafieldInput[];
}

export interface FileSetInput {
  originalSource: string;
  alt: string;
  contentType: 'IMAGE';
}

export interface ProductSetInput {
  id?: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  category?: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  templateSuffix?: string;
  tags: string[];
  productOptions?: ProductOptionInput[];
  variants?: ProductVariantSetInput[];
  files?: FileSetInput[];
}

/** Metaobject types for print area decoration data. */

export interface MetaobjectField {
  key: string;
  value: string;
}

export interface MetaobjectUpsertInput {
  fields: MetaobjectField[];
}

export interface MetaobjectHandleInput {
  type: string;
  handle: string;
}

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** Staged upload types for image processing pipeline. */

export interface StagedUploadInput {
  resource: string;
  filename: string;
  mimeType: string;
  fileSize: string;
  httpMethod: string;
}

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

/** Category group for print area coordinate mapping. */
export type CategoryGroup = 'tops' | 'hoodies';

/** Bounding box of the garment within its source image. */
export interface GarmentBounds {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/** Print area coordinates as percentage strings (relative to 2000x2000 canvas). */
export type PrintAreaCoords = Record<string, { x: string; y: string; width: string; height: string }>;

/** Result from processProductImages — files for Shopify + computed print coords. */
export interface ImageProcessResult {
  files: FileSetInput[];
  printAreaCoords: PrintAreaCoords | null;
}

/** Per-dimension score results from image quality analysis. */
export interface ImageQualityDimensions {
  blur: number;       // 0-100
  resolution: number; // 0-100
  proportion: number; // 0 or 100
  content: number;    // 0 or 100
}

/** Result from scoreImageQuality() — used by Phase 10 (ranking) and Phase 12 (gating). */
export interface ImageQualityResult {
  score: number;             // 0-100 composite
  verdict: 'pass' | 'fail';
  reasons: string[];         // empty array if pass
  dimensions: ImageQualityDimensions;
}
