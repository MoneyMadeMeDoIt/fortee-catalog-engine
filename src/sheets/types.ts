/**
 * Typed representation of a single row in the master product sheet.
 * Each property corresponds to one of the 38 columns in order.
 */
export interface SheetRow {
  supplierCode: string;
  PartID: string;
  styleID: string;
  partNumber: string;
  brandName: string;
  productId: string;
  colorName: string;
  colorFamily: string;
  productName: string;
  description: string;
  FrontImage: string;
  BackImage: string;
  DirectSideImage: string;
  col14Empty: string;
  color1: string;
  color2: string;
  sizeName: string;
  sizePriceCodeName: string;
  costPrice: string;
  CaseQty: string;
  unitWeight: string;
  Qty: string;
  CaseWeight: string;
  BoxHeight: string;
  BoxLength: string;
  BoxWidth: string;
  baseCategory: string;
  weightGSM: string;
  gender: string;
  fit: string;
  keywords: string;
  categories: string;
  careInstructions: string;
  sizeChart: string;
  embroideryAvailable: string;
  dtfAvailable: string;
  sellPrice1Area: string;
  sellPrice2Area: string;
  decorationPlacements: string;
}

/**
 * Column header names in the master sheet, in exact order (0-indexed).
 * Must match the actual spreadsheet headers.
 */
export const SHEET_COLUMNS = [
  'supplierCode',
  'PartID',
  'styleID',
  'partNumber',
  'brandName',
  'productId',
  'colorName',
  'colorFamily',
  'productName',
  'description',
  'FrontImage',
  'BackImage',
  'DirectSideImage',
  'col14Empty',
  'color1',
  'color2',
  'sizeName',
  'sizePriceCodeName',
  'costPrice',
  'CaseQty',
  'unitWeight',
  'Qty',
  'CaseWeight',
  'BoxHeight',
  'BoxLength',
  'BoxWidth',
  'baseCategory',
  'weightGSM',
  'gender',
  'fit',
  'keywords',
  'categories',
  'careInstructions',
  'sizeChart',
  'embroideryAvailable',
  'dtfAvailable',
  'sellPrice1Area',
  'sellPrice2Area',
  'decorationPlacements',
] as const;

/** A cell-level update targeting a specific range in the sheet. */
export interface EnrichmentUpdate {
  range: string;
  values: string[][];
}

/** Summary report of an enrichment run. */
export interface EnrichmentReport {
  rowsScanned: number;
  rowsEnriched: number;
  cellsWritten: number;
  skippedNoMatch: number;
  errors: Array<{ partId: string; error: string }>;
}
