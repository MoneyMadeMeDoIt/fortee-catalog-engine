/** Shopify GraphQL Admin API input types for productSet mutation. */

export interface ProductOptionValueInput {
  name: string;
}

export interface ProductOptionInput {
  name: string;
  position: number;
  values: ProductOptionValueInput[];
}

export interface VariantOptionValueInput {
  optionName: string;
  name: string;
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
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  templateSuffix?: string;
  tags: string[];
  productOptions: ProductOptionInput[];
  variants: ProductVariantSetInput[];
  files: FileSetInput[];
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
