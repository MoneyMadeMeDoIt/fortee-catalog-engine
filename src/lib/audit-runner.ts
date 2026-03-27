/**
 * Audit Runner — Phase 12 integration orchestrator.
 *
 * Wires Phase 08-11 modules into a single per-product pipeline:
 *   Score → Source → Generate/Enhance → Standardize → Write to Sheets
 *
 * Entry point: auditProductImages()
 * Called by: Phase 13 CLI
 */

import type { sheets_v4 } from 'googleapis';
import { scoreImageQuality } from '../shopify/image-scorer.js';
import { sourceImages } from '../lib/image-sourcer.js';
import { generateGarmentView, enhanceFrontImage } from '../lib/ai-image-generator.js';
import {
  standardizeImage,
  uploadStagedImage,
  buildStandardizationUpdates,
  downloadImage,
  type ShopifyClient,
} from '../shopify/image-standardizer.js';
import { writeUpdates } from '../sheets/writer.js';
import { getCategoryGroup } from '../shopify/variants.js';
import { type CostTracker } from '../lib/cost-tracker.js';
import { logger } from '../lib/logger.js';
import type { SheetRow } from '../sheets/types.js';
import type { CategoryGroup } from '../shopify/types.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ViewAuditResult {
  view: 'front' | 'back' | 'side';
  status: 'pass-existing' | 'sourced' | 'generated' | 'enhanced' | 'failed' | 'skipped';
  score: number | null;
  cdnUrl: string | null;
  reason?: string;
}

export interface AuditResult {
  styleId: string;
  colorName: string;
  views: ViewAuditResult[];
  cellsWritten: number;
  aiCostIncurred: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ViewKey = 'front' | 'back' | 'side';

interface ScoredBuffer {
  buffer: Buffer;
  verdict: 'pass' | 'fail';
  score: number;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Audit product images for a single sheet row.
 * Implements the D-01 linear pipeline: Score → Source → Generate/Enhance → Standardize → Write.
 *
 * @param row - Sheet row with existing image URLs and product metadata
 * @param rowIndex - 0-based data row index (row 0 = sheet row 2, header is row 1)
 * @param shopifyClient - Shopify Admin API client for staged image uploads
 * @param sheetsClient - Google Sheets API client for writing CDN URLs
 * @param spreadsheetId - Target Google Spreadsheet ID
 * @param sheetName - Target sheet tab name
 * @param costTracker - Shared budget tracker; injected by caller (never created here)
 */
export async function auditProductImages(
  row: SheetRow,
  rowIndex: number,
  shopifyClient: ShopifyClient,
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  costTracker: CostTracker,
): Promise<AuditResult> {
  const styleId = row.styleID;
  const colorName = row.colorName;

  // Return a minimal stub result — implementation added in Task 2 (GREEN phase)
  return {
    styleId,
    colorName,
    views: [],
    cellsWritten: 0,
    aiCostIncurred: 0,
  };
}
