/**
 * Audit Runner — Phase 12 integration orchestrator.
 *
 * Wires Phase 08-11 modules into a single per-product pipeline:
 *   Score → Source → Generate/Enhance → Standardize → Write to Sheets
 *
 * Entry point: auditProductImages()
 * Called by: Phase 13 CLI
 *
 * Key design decisions:
 * - D-01: Linear pipeline (score → source → generate → standardize → write)
 * - D-02: Always re-standardize to 85% uniform scale, even if existing images pass
 * - D-03: No sourcing/generation for views that pass quality scoring
 * - D-04: Write to Google Sheets only; no Shopify product mutations
 */

import type { sheets_v4, drive_v3 } from 'googleapis';
import { scoreImageQuality } from '../shopify/image-scorer.js';
import { sourceImages } from '../lib/image-sourcer.js';
import { generateGarmentView, enhanceFrontImage } from '../lib/ai-image-generator.js';
import {
  standardizeImage,
  buildStandardizationUpdates,
  downloadImage,
} from '../shopify/image-standardizer.js';
import { uploadToDrive } from '../sheets/drive.js';
import { writeUpdates } from '../sheets/writer.js';
import { getCategoryGroup } from '../shopify/variants.js';
import { type CostTracker } from '../lib/cost-tracker.js';
import { logger } from '../lib/logger.js';
import type { SheetRow } from '../sheets/types.js';
import type { CategoryGroup } from '../shopify/types.js';
import type { SourcedImages } from '../lib/image-sourcer.js';

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

interface ResolvedBuffer {
  buffer: Buffer;
  score: number;
  verdict: 'pass' | 'fail';
  status: 'pass-existing' | 'sourced' | 'generated' | 'enhanced' | 'failed' | 'skipped';
  reason?: string;
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
 * @param driveClient - Google Drive API client for image uploads
 * @param sheetsClient - Google Sheets API client for writing CDN URLs
 * @param spreadsheetId - Target Google Spreadsheet ID
 * @param sheetName - Target sheet tab name
 * @param costTracker - Shared budget tracker; injected by caller (never created here)
 */
export async function auditProductImages(
  row: SheetRow,
  rowIndex: number,
  driveClient: drive_v3.Drive,
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  costTracker: CostTracker,
): Promise<AuditResult> {
  const styleId = row.styleID;
  const colorName = row.colorName;

  // -------------------------------------------------------------------------
  // Step 1 — Resolve category (per D-03 and Pitfall 4)
  // -------------------------------------------------------------------------
  const rawCategory = row.baseCategory;
  const categoryGroup: CategoryGroup = getCategoryGroup(rawCategory) ?? 'tops';
  if (!getCategoryGroup(rawCategory)) {
    logger.warn(
      `[audit-runner] Unknown category '${rawCategory}' for ${styleId} — defaulting to tops`,
    );
  }

  let aiCostIncurred = 0;

  try {
    // -----------------------------------------------------------------------
    // Step 2 — Score existing images from sheet URLs
    // -----------------------------------------------------------------------

    // Map: view → scored buffer (null if missing or download failed)
    const scoredExisting: Record<ViewKey, { buffer: Buffer; verdict: 'pass' | 'fail'; score: number } | null> = {
      front: null,
      back: null,
      side: null,
    };

    const existingUrls: Record<ViewKey, string | null> = {
      front: row.FrontImage || null,
      back: row.BackImage || null,
      side: row.DirectSideImage || null,
    };

    for (const view of ['front', 'back', 'side'] as const) {
      const url = existingUrls[view];
      if (!url) continue;

      try {
        const buffer = await downloadImage(url);
        const result = await scoreImageQuality(buffer, categoryGroup);
        scoredExisting[view] = { buffer, verdict: result.verdict, score: result.score };
      } catch (err) {
        // Non-fatal — treat as missing (proceed to sourcing)
        logger.warn(`[audit-runner] Failed to download/score ${view} for ${styleId}: ${err}`);
      }
    }

    // -----------------------------------------------------------------------
    // Step 3 — Source missing/failed views (once, if any need sourcing)
    // -----------------------------------------------------------------------

    const needsSourcing = (['front', 'back', 'side'] as const).some(
      v => !scoredExisting[v] || scoredExisting[v]!.verdict === 'fail',
    );

    let sourced: SourcedImages = { front: null, back: null, side: null };
    if (needsSourcing) {
      sourced = await sourceImages(styleId, colorName);
    }

    // -----------------------------------------------------------------------
    // Step 4 — Resolve best buffer per view (decision tree from plan)
    // -----------------------------------------------------------------------
    // Priority: pass-existing > sourced-pass > ai-generate/enhance > sourced-fail > skipped
    //
    // For front: enhance if failing, cannot generate from scratch
    // For back/side: generate from front buffer if missing/failing

    // We need the front buffer for AI generation of back/side
    let resolvedFrontBuffer: Buffer | null = null;

    const resolvedBuffers: Record<ViewKey, ResolvedBuffer | null> = {
      front: null,
      back: null,
      side: null,
    };

    // --- Resolve front first (needed for back/side AI generation) ---
    {
      const existing = scoredExisting.front;

      if (existing?.verdict === 'pass') {
        // D-03: existing passes → no sourcing/generation, just standardize
        resolvedFrontBuffer = existing.buffer;
        resolvedBuffers.front = {
          buffer: existing.buffer,
          score: existing.score,
          verdict: 'pass',
          status: 'pass-existing',
        };
      } else {
        // Failing or missing — try sourcing
        const sourcedFront = sourced.front;
        let gotFrontBuffer: Buffer | null = existing?.buffer ?? null;  // failing existing buffer as fallback

        if (sourcedFront) {
          try {
            const sourcedBuf = await downloadImage(sourcedFront.url);
            if (sourcedFront.verdict === 'pass') {
              resolvedFrontBuffer = sourcedBuf;
              resolvedBuffers.front = {
                buffer: sourcedBuf,
                score: sourcedFront.score,
                verdict: 'pass',
                status: 'sourced',
              };
            } else {
              // Sourced but failing — try enhancement
              gotFrontBuffer = sourcedBuf;
            }
          } catch (err) {
            logger.warn(`[audit-runner] Failed to download sourced front for ${styleId}: ${err}`);
          }
        }

        // Try enhancement if front is available but failing
        if (!resolvedBuffers.front) {
          const frontBufForEnhance = gotFrontBuffer ?? existing?.buffer ?? null;
          if (frontBufForEnhance) {
            const enhanced = await enhanceFrontImage(frontBufForEnhance, costTracker, categoryGroup);
            if (enhanced) {
              aiCostIncurred += enhanced.cost;
              resolvedFrontBuffer = enhanced.buffer;
              resolvedBuffers.front = {
                buffer: enhanced.buffer,
                score: enhanced.score,
                verdict: enhanced.verdict,
                status: 'enhanced',
              };
            } else {
              // Budget exhausted — use whatever buffer we have
              const fallbackBuf = gotFrontBuffer ?? existing?.buffer;
              if (fallbackBuf) {
                resolvedFrontBuffer = fallbackBuf;
                resolvedBuffers.front = {
                  buffer: fallbackBuf,
                  score: sourcedFront?.score ?? existing?.score ?? 0,
                  verdict: 'fail',
                  status: 'skipped',
                  reason: 'budget exhausted',
                };
              } else {
                resolvedBuffers.front = {
                  buffer: Buffer.alloc(0),
                  score: 0,
                  verdict: 'fail',
                  status: 'failed',
                  reason: 'no front image available',
                };
              }
            }
          } else if (sourcedFront) {
            // Had a sourced view with failing verdict but download failed
            resolvedBuffers.front = {
              buffer: Buffer.alloc(0),
              score: sourcedFront.score,
              verdict: 'fail',
              status: 'failed',
              reason: 'sourced image download failed',
            };
          } else {
            // No front image at all
            resolvedBuffers.front = {
              buffer: Buffer.alloc(0),
              score: 0,
              verdict: 'fail',
              status: 'failed',
              reason: 'no front image available',
            };
          }
        }
      }
    }

    // --- Resolve back and side (may use front buffer for AI generation) ---
    for (const view of ['back', 'side'] as const) {
      const existing = scoredExisting[view];

      if (existing?.verdict === 'pass') {
        // D-03: existing passes — standardize only
        resolvedBuffers[view] = {
          buffer: existing.buffer,
          score: existing.score,
          verdict: 'pass',
          status: 'pass-existing',
        };
        continue;
      }

      // Failing or missing — try sourcing
      const sourcedView = sourced[view];
      if (sourcedView) {
        try {
          const sourcedBuf = await downloadImage(sourcedView.url);
          if (sourcedView.verdict === 'pass') {
            resolvedBuffers[view] = {
              buffer: sourcedBuf,
              score: sourcedView.score,
              verdict: 'pass',
              status: 'sourced',
            };
            continue;
          }
          // Sourced but failing — try AI generation if front available
          if (resolvedFrontBuffer) {
            const generated = await generateGarmentView(
              resolvedFrontBuffer, view, categoryGroup, colorName, costTracker,
            );
            if (generated) {
              aiCostIncurred += generated.totalCost;
              resolvedBuffers[view] = {
                buffer: generated.buffer,
                score: generated.score,
                verdict: generated.verdict,
                status: 'generated',
              };
            } else {
              // Budget exhausted — fall back to failing sourced image
              resolvedBuffers[view] = {
                buffer: sourcedBuf,
                score: sourcedView.score,
                verdict: 'fail',
                status: 'skipped',
                reason: 'budget exhausted',
              };
            }
          } else {
            // No front buffer — use failing sourced image as best option
            resolvedBuffers[view] = {
              buffer: sourcedBuf,
              score: sourcedView.score,
              verdict: 'fail',
              status: 'sourced',
            };
          }
        } catch (err) {
          logger.warn(`[audit-runner] Failed to download sourced ${view} for ${styleId}: ${err}`);
          // Fall through to AI generation
        }
      }

      // No sourced image (or sourced download failed) — try AI generation
      if (!resolvedBuffers[view]) {
        if (resolvedFrontBuffer) {
          const generated = await generateGarmentView(
            resolvedFrontBuffer, view, categoryGroup, colorName, costTracker,
          );
          if (generated) {
            aiCostIncurred += generated.totalCost;
            resolvedBuffers[view] = {
              buffer: generated.buffer,
              score: generated.score,
              verdict: generated.verdict,
              status: 'generated',
            };
          } else {
            // Budget exhausted or content policy
            resolvedBuffers[view] = {
              buffer: Buffer.alloc(0),
              score: null as unknown as number,
              verdict: 'fail',
              status: 'skipped',
              reason: 'budget exhausted',
            };
          }
        } else {
          // No front buffer — cannot generate back/side
          resolvedBuffers[view] = {
            buffer: Buffer.alloc(0),
            score: null as unknown as number,
            verdict: 'fail',
            status: 'failed',
            reason: 'no front image available for AI generation',
          };
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 5 — Standardize ALL views with non-empty buffers and collect CDN URLs
    // -----------------------------------------------------------------------
    const cdnUrls: { front?: string; back?: string; side?: string } = {};
    const viewResults: ViewAuditResult[] = [];

    for (const view of ['front', 'back', 'side'] as const) {
      const resolved = resolvedBuffers[view];

      if (!resolved || resolved.buffer.length === 0) {
        // View failed completely — no buffer to standardize
        viewResults.push({
          view,
          status: resolved?.status ?? 'failed',
          score: resolved?.score ?? null,
          cdnUrl: null,
          reason: resolved?.reason,
        });
        continue;
      }

      try {
        const { buffer: stdBuffer } = await standardizeImage(resolved.buffer, categoryGroup);
        const filename = `${row.productName}-${colorName}-${view}-std.png`
          .replace(/\s+/g, '-')
          .toLowerCase();
        const cdnUrl = await uploadToDrive(driveClient, stdBuffer, filename, row.supplierCode, styleId);
        cdnUrls[view] = cdnUrl;

        viewResults.push({
          view,
          status: resolved.status,
          score: resolved.score,
          cdnUrl,
          reason: resolved.reason,
        });
      } catch (err) {
        logger.warn(`[audit-runner] Failed to standardize/upload ${view} for ${styleId}: ${err}`);
        viewResults.push({
          view,
          status: 'failed',
          score: resolved.score,
          cdnUrl: null,
          reason: `standardization failed: ${(err as Error).message}`,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 6 — Write CDN URLs to Google Sheets (per D-04)
    // -----------------------------------------------------------------------
    const updates = buildStandardizationUpdates(sheetName, rowIndex, cdnUrls);
    const cellsWritten = await writeUpdates(sheetsClient, spreadsheetId, updates);

    return {
      styleId,
      colorName,
      views: viewResults,
      cellsWritten,
      aiCostIncurred,
    };

  } catch (err) {
    // Catastrophic error — return partial result with error flag
    logger.error(`[audit-runner] Catastrophic error for ${styleId}: ${err}`);
    return {
      styleId,
      colorName,
      views: [],
      cellsWritten: 0,
      aiCostIncurred,
      error: (err as Error).message,
    };
  }
}
