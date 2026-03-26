# Architecture Patterns: AI Image Pipeline Integration

**Domain:** Automated image pipeline for apparel product catalog engine
**Researched:** 2026-03-26
**Question:** How do AI image generation, quality scoring, and image sourcing integrate with the existing architecture? What new components are needed? What is the suggested build order?

---

## Existing Architecture Recap

The v1.0 architecture has a clear execution spine:

```
pushProduct(styleID)
  → readAllRows()              [sheets/reader.ts]
  → processProductImages()     [shopify/image-standardizer.ts]
      → downloadImage()
      → standardizeImage()     [sharp trim-place-composite]
      → uploadStagedImage()    [Shopify staged uploads]
  → buildProductSetInput()     [shopify/product-push.ts]
  → productSet mutation        [Shopify GraphQL]
  → color swatches, variants, metafields, size guide
```

Image URLs come from sheet columns `FrontImage`, `BackImage`, `DirectSideImage`. The sheet is the source of truth. Write-back uses `writeUpdates()` in `sheets/writer.ts` via `EnrichmentUpdate[]` (range + values[][]).

Key constraints for new work:
- `SheetRow` has exactly 38 typed columns — adding image pipeline status requires new columns appended to the schema
- `processProductImages()` accepts `{ front?, back?, side? }` URLs — the new pipeline must produce standardized images that feed this interface, OR it bypasses `processProductImages()` and calls the lower-level functions directly
- `standardizeImage()` is the garment-detection pipeline (trim → extract → place-on-canvas) — reusable without modification
- `uploadStagedImage()` is the Shopify upload primitive — reusable without modification
- `readAllRows()` is header-name-based, not positional — new columns appended to the sheet will be read as empty string on rows that predate them; this is the correct zero-impact fallback

---

## New Components Required

### Component 1: `src/images/quality-scorer.ts`

**Responsibility:** Compute a quality score for an existing image buffer. Flag images as acceptable, degraded, or unusable.

**What it does:**
- Applies a 3x3 Laplacian kernel via `sharp().convolve()` then reads raw pixel stats to compute variance (higher variance = sharper image)
- Checks minimum resolution (rejects below 800x800 for supplier images)
- Checks aspect ratio deviation from expected square ratio
- Returns `QualityResult: { score: number; verdict: 'pass' | 'flag' | 'reject'; reasons: string[] }`

**Why this approach:** Sharp's `convolve()` accepts an arbitrary kernel and returns a buffer that can be statted for variance. This is the standard Node.js-compatible Laplacian variance blur detection technique. No additional Python subprocess, OpenCV binding, or native addon is needed. The `@bstrickl/blurriness` npm package wraps the same Sobel/Laplacian approach but adds an unnecessary dependency; building it directly on sharp keeps the stack consistent. (MEDIUM confidence — sharp `convolve()` API verified via official docs; threshold values for garment images require empirical calibration.)

**Integration point:** Called from `audit-runner.ts` per image buffer. Does NOT touch Shopify or Google Sheets directly.

**Communicates with:** `src/images/audit-runner.ts` (caller), `src/images/ai-generator.ts` (calls it to verify generated output before accepting)

---

### Component 2: `src/sheets/image-columns.ts`

**Responsibility:** Define new sheet columns for image pipeline status and provide a typed write-back function.

**New columns required (appended after column 38, not replacing existing):**

| Column Name | Type | Purpose |
|-------------|------|---------|
| `imageAuditStatus` | string | `pending | pass | flagged | replaced | generation-failed | manual-review` |
| `frontImageSource` | string | `supplier | omg | ai-generated | manual` |
| `backImageSource` | string | same enum |
| `sideImageSource` | string | same enum |
| `imageAuditDate` | string | ISO date of last audit run |
| `frontQualityScore` | string | numeric Laplacian variance score (stored as string) |

**What it does:**
- Exports `IMAGE_STATUS_COLUMNS` array (column names in order)
- Exports `writeImageStatus(sheets, spreadsheetId, styleID, rowIndex, result)` which calls existing `writeUpdates()` in `writer.ts`
- Uses `spreadsheets.values.batchUpdate` with `valueInputOption: 'RAW'` (same pattern as existing enrichment write-back)

**`SheetRow` type change:** Append 6 optional fields to the interface. Append 6 entries to `SHEET_COLUMNS`. Because `readAllRows()` maps by header name, existing rows without these columns will return empty string — no existing code path is affected.

**Communicates with:** `audit-runner.ts` (calls `writeImageStatus` after each product), `sheets/writer.ts` (delegates to `writeUpdates`)

---

### Component 3: `src/images/omg-sourcer.ts`

**Responsibility:** Source higher-quality front images from the OrderMyGear OneSource API (PromoStandards media endpoint).

**What it does:**
- Accepts `supplierCode: string` (e.g., `CANADASPORTSWEAR`) and `styleID: string`
- Calls the OneSource PromoStandards Media Content endpoint
- Returns an array of image URLs ranked by resolution (largest first)
- Returns empty array on 404/not-found or authentication failure — never throws

**Why OneSource:** OMG's OneSource API is the PromoStandards-compliant channel for supplier product data including images. The existing codebase already maps supplier codes (`SUPPLIER_CODE_MAP` in `column-map.ts`). Authentication uses `OMG_API_KEY` environment variable. (MEDIUM confidence — OneSource API existence confirmed via official OMG docs; exact endpoint path and response schema require authenticated API access to verify.)

**Integration point:** Called from `audit-runner.ts` when a front image scores below threshold or is missing. Does NOT write to Shopify or Sheets.

**Communicates with:** `src/images/audit-runner.ts`

---

### Component 4: `src/images/ai-generator.ts`

**Responsibility:** Generate missing or replacement back/side views via the OpenAI image API, using the front-view image as a reference.

**What it does:**
- Accepts `frontBuffer: Buffer`, `view: 'back' | 'side'`, `description: string` (garment name + category)
- Calls `openai.images.edit()` with the front image as reference, model `gpt-image-1`
- Decodes the base64 response to a Buffer
- Returns the generated buffer (caller is responsible for quality verification before accepting)

**API shape (HIGH confidence — verified against OpenAI cookbook):**
```typescript
const result = await openai.images.edit({
  model: 'gpt-image-1',
  image: [new File([frontBuffer], 'front.png', { type: 'image/png' })],
  prompt: `Generate the ${view} view of this ${description} garment on a plain white background, product photography style, no model`,
  size: '1024x1024',
  quality: 'high',
});
const generated = Buffer.from(result.data[0].b64_json!, 'base64');
```

**Why `images.edit` not `images.generate`:** The edit endpoint accepts a reference image array (up to 10 images), enabling identity-preserving generation. Pure `images.generate` from a text prompt has no identity preservation — the garment would look invented, not like the real product.

**Why `gpt-image-1` not DALL-E 3:** DALL-E 3 does not accept image inputs. DALL-E 2 supports edits but has weak instruction following and is being deprecated May 2026. `gpt-image-1` is the correct choice. `gpt-image-1.5` (mentioned in some sources as a newer variant) should be substituted if confirmed available at implementation time. (HIGH confidence on model selection; MEDIUM on `gpt-image-1.5` availability — verify before using it.)

**New dependency:** `openai` npm package (not currently installed). Add to `package.json`.

**Integration point:** Called from `audit-runner.ts` when back/side view is missing or rejected. Output buffer goes to `quality-scorer.ts` before being committed. Does NOT call Shopify directly.

**Communicates with:** `src/images/audit-runner.ts`, `src/images/quality-scorer.ts` (verify before accepting)

---

### Component 5: `src/images/audit-runner.ts`

**Responsibility:** Orchestrate the per-product image audit pipeline. The main entry point for all v2.0 image work.

**Per-product flow:**
1. Load image URLs from sheet rows (`FrontImage`, `BackImage`, `DirectSideImage`)
2. Download each image → `quality-scorer.ts`
3. Front fails score: → `omg-sourcer.ts` for replacement URL → if found, download + re-score → if OMG returns nothing, mark `manual-review`
4. Back/side missing or rejected: → `ai-generator.ts` → `quality-scorer.ts` on generated image → retry once on fail → if still fails, mark `generation-failed`
5. Accepted images (original or replacement) → `standardizeImage()` (existing) → `uploadStagedImage()` (existing)
6. Write `AuditResult` back to sheet via `image-columns.ts`

**Why a separate orchestrator rather than modifying `pushProduct`:**
- The audit pipeline must run on already-published products (no product creation needed)
- `pushProduct` should continue to work without new env vars (`OPENAI_API_KEY`, `OMG_API_KEY`) — adding them as requirements would break the existing single-product push for operators without the new credentials
- Separation keeps each component testable in isolation

**Communicates with:** `quality-scorer.ts`, `omg-sourcer.ts`, `ai-generator.ts`, existing `image-standardizer.ts` (standardizeImage, downloadImage, uploadStagedImage), `image-columns.ts`, `sheets/reader.ts` (existing)

---

### Component 6: `scripts/audit-images.ts`

**Responsibility:** CLI entry point for the image audit pipeline. Mirrors `scripts/push-product.ts` structure.

**Flags:**
- `--style-id PC61` — audit single product
- `--all` — batch audit all products in sheet
- `--dry-run` — score and log, do not upload or write back

**Communicates with:** `src/images/audit-runner.ts`

---

## Component Boundaries and Data Flow

```
scripts/audit-images.ts          (CLI entry point)
  |
  v
src/images/audit-runner.ts       (orchestrator — one product at a time)
  |
  +-- [reads] src/sheets/reader.ts            (existing, unchanged)
  |
  +-- src/images/quality-scorer.ts            (NEW)
  |     depends on: sharp (existing)
  |     input:  Buffer
  |     output: QualityResult
  |
  +-- src/images/omg-sourcer.ts               (NEW)
  |     depends on: fetch, OMG_API_KEY
  |     input:  supplierCode, styleID
  |     output: string[] (image URLs, may be empty)
  |
  +-- src/images/ai-generator.ts              (NEW)
  |     depends on: openai SDK (new dep)
  |     input:  Buffer (front), view type, description
  |     output: Buffer (generated image)
  |     --> calls: quality-scorer.ts to verify output
  |
  +-- src/shopify/image-standardizer.ts       (EXISTING, unchanged)
  |     standardizeImage(), downloadImage(), uploadStagedImage()
  |
  +-- src/sheets/image-columns.ts             (NEW)
        depends on: sheets/writer.ts (existing writeUpdates)
        writes: imageAuditStatus + source + score columns
```

**Per-image data flow:**
```
Sheet URL
  → downloadImage()
  → quality-scorer
       |
       +-- pass → standardizeImage() → uploadStagedImage() → status=pass
       |
       +-- fail (front) → omg-sourcer
       |                      |
       |                      +-- URL found → download → quality-scorer → [pass path above]
       |                      |
       |                      +-- no URL → status=manual-review
       |
       +-- fail (back/side) → ai-generator
                                  |
                                  +-- quality-scorer passes → standardizeImage() → upload → status=generated
                                  |
                                  +-- quality-scorer fails → retry once → status=generation-failed
```

---

## Modified Components (Existing, Non-Breaking Changes)

### `src/sheets/types.ts`

**Change:** Append 6 optional fields to `SheetRow` interface. Append 6 entries to `SHEET_COLUMNS` array.

```typescript
// Appended to SheetRow interface:
imageAuditStatus?: string;
frontImageSource?: string;
backImageSource?: string;
sideImageSource?: string;
imageAuditDate?: string;
frontQualityScore?: string;
```

Because `readAllRows()` maps by header name (not index), this is a zero-impact change for existing rows and for any code that does not reference the new fields.

### `src/shopify/image-standardizer.ts`

**Change:** None. `standardizeImage()`, `downloadImage()`, and `uploadStagedImage()` are standalone functions already. The audit runner calls them directly. `processProductImages()` (the higher-level function used by `pushProduct`) is not called or modified.

### `src/shopify/product-push.ts`

**Change:** None required for v2.0. Future optimization (deferred): `pushProduct` could read already-standardized image URLs from the sheet instead of re-downloading and re-standardizing supplier URLs on every push. That optimization is deferred to avoid scope creep.

---

## Key Interface Definitions

```typescript
// src/images/quality-scorer.ts
interface QualityResult {
  score: number;           // Laplacian variance (higher = sharper)
  verdict: 'pass' | 'flag' | 'reject';
  reasons: string[];       // ['low-sharpness', 'below-min-resolution', 'wrong-aspect-ratio']
  width: number;
  height: number;
}

// src/images/audit-runner.ts
interface ImageAuditOptions {
  dryRun?: boolean;
  qualityThreshold?: number;   // Laplacian variance minimum; default TBD via empirical calibration
  skipGeneration?: boolean;    // skip AI generation step, mark missing as manual-review
}

interface AuditResult {
  styleID: string;
  front: ImageOutcome;
  back: ImageOutcome;
  side: ImageOutcome;
  writtenToSheet: boolean;
}

interface ImageOutcome {
  status: 'pass' | 'replaced' | 'generated' | 'generation-failed' | 'missing' | 'manual-review';
  source: 'supplier' | 'omg' | 'ai-generated' | 'manual' | 'none';
  qualityScore?: number;
  shopifyUrl?: string;   // set if uploaded to Shopify
}
```

---

## Architecture Decisions

### Decision 1: New `src/images/` module

New components go in `src/images/`, not `src/shopify/`. Quality scoring, AI generation, and OMG sourcing have no Shopify dependency. Placing them in `src/shopify/` would be misleading about their scope. `image-standardizer.ts` stays in `src/shopify/` because it calls `uploadStagedImage()` and is Shopify-bound.

The dependency direction is correct: `src/images/audit-runner.ts` calls down into `src/shopify/image-standardizer.ts`.

### Decision 2: Audit pipeline is standalone, not injected into `pushProduct`

The audit pipeline runs independently. `pushProduct` retains its own image flow unchanged. This preserves two guarantees:
1. `pushProduct` works with zero new env vars — no `OPENAI_API_KEY` or `OMG_API_KEY` required for basic product push
2. The audit pipeline can be run on already-published products without triggering a product push

### Decision 3: `images.edit` over `images.generate` for AI view generation

Using the OpenAI edit endpoint with the front image as a reference maintains garment identity. Pure text-prompt generation would produce a plausible-looking but incorrect garment that does not match the actual product. The edit endpoint accepts up to 10 input images, making it suitable for reference-based generation.

### Decision 4: Quality scorer runs on generated images before acceptance

AI-generated images must pass the same quality scorer as supplier images before being committed. A single rejection triggers one retry with a revised prompt. Two consecutive failures mark the image as `generation-failed` and flag for manual review. This prevents silently publishing low-quality AI artifacts.

---

## Suggested Build Order

Dependencies drive this order. Each phase can be verified in isolation.

### Phase 1: Quality Scorer

**Why first:** No external API dependencies. Only needs sharp (already installed). Required by both the audit runner and the AI generation verification step. Cannot build Phase 4 without Phase 1.

**Deliverable:** `scoreImageQuality(buffer: Buffer, options?: ScorerOptions): Promise<QualityResult>`

**Verification:** Unit tests with known-sharp (high-res supplier image) and known-blurry (downscaled then upscaled) inputs. Calibrate threshold against 10-20 real supplier images before hardcoding a default.

### Phase 2: Sheet Image Columns

**Why second:** No external API dependencies. Needed by the audit runner to write results back. Can be built and verified independently of all image logic. Run existing reader after extending `SHEET_COLUMNS` to confirm no regressions.

**Deliverable:** `writeImageStatus()`, updated `SheetRow`, `IMAGE_STATUS_COLUMNS`

**Verification:** Write a test row to a staging sheet, confirm correct column positions.

### Phase 3: OMG Sourcer

**Why third:** Isolated HTTP call, no Shopify or sharp dependency. Can be tested independently with a known supplier product before wiring to the audit runner. Failure mode is graceful (returns empty array).

**Deliverable:** `sourceImagesFromOMG(supplierCode: string, styleID: string): Promise<string[]>`

**Verification:** Manual test with one known CSW or SS product. Confirm URL array is returned and images are downloadable.

**Prerequisite:** `OMG_API_KEY` environment variable. Add to `.env.example`.

### Phase 4: AI Generator

**Why fourth:** Depends on Phase 1 (quality scorer) for post-generation verification. More expensive to iterate (API cost per call). Build after scorer so the verification loop can be tested without manual inspection.

**Deliverable:** `generateGarmentView(frontBuffer: Buffer, view: 'back' | 'side', description: string): Promise<Buffer>`

**Verification:** Generate one back view for a known product. Pass through quality scorer. Inspect result visually. Tune prompt.

**Prerequisite:** `OPENAI_API_KEY` environment variable. Add to `.env.example`. Install `openai` npm package.

### Phase 5: Audit Runner

**Why fifth:** Integrates all prior components. Single-product audit must work end-to-end (score → source/generate → re-score → standardize → upload → write-back) before batch mode.

**Deliverable:** `auditProductImages(styleID: string, options?: ImageAuditOptions): Promise<AuditResult>`

**Verification:** Full end-to-end run on one product with each scenario: pass, front-replaced-via-OMG, back-generated-via-AI.

### Phase 6: CLI Script and Batch Mode

**Why sixth:** Built last because it depends on Phase 5 working correctly. Batch mode adds `p-queue` concurrency control (already installed). `--dry-run` flag verifies scoring logic without API side effects.

**Deliverable:** `scripts/audit-images.ts` with `--style-id`, `--all`, `--dry-run` flags.

---

## Scalability Considerations

| Concern | Single product | Batch (100+ products) |
|---------|---------------|----------------------|
| OpenAI rate limits | Not an issue | `p-queue` concurrency=2, exponential backoff on 429 |
| OMG API rate limits | Not an issue | `p-queue` concurrency=5 |
| Sheets write-back | One `batchUpdate` per product | Same — one call per product, no batching needed |
| AI generation cost | ~$0.04-0.12 per image | Gate: only generate when view is missing or scored below threshold; do not regenerate already-passing images |
| Memory | One 2-8MB buffer at a time | Process products serially in batch mode (not in parallel) to avoid multiple large buffers in memory |
| Quality threshold calibration | Manual on a sample set | Document the threshold + sample images used in `src/images/THRESHOLDS.md` for future reference |

---

## Sources

- OpenAI `images.edit` API with reference image input: [OpenAI Cookbook — Generate images with GPT Image](https://developers.openai.com/cookbook/examples/generate_images_with_gpt_image) — HIGH confidence (official source, verified 2026-03-26)
- `gpt-image-1` model capabilities and edit endpoint signature: [OpenAI API Reference — Images createEdit](https://platform.openai.com/docs/api-reference/images/createEdit) — HIGH confidence
- DALL-E 2 deprecation May 2026: [OpenAI Image Generation API Pricing 2026](https://www.aifreeapi.com/en/posts/openai-image-generation-api-pricing) — MEDIUM confidence (third-party, consistent with known OpenAI announcements)
- Sharp `convolve()` for Laplacian blur detection: [Sharp API Operations](https://sharp.pixelplumbing.com/api-operation/) + [Pinpointing Blurry Images in Node.js](https://www.linkedin.com/pulse/pinpointing-blurry-images-simple-nodejs-way-pablo-schaffner-bofill) — HIGH confidence (sharp docs confirm convolve API; technique is well-established)
- OrderMyGear OneSource API for PromoStandards product images: [OrderMyGear OneSource API](https://www.ordermygear.com/onesource-api/) — MEDIUM confidence (public docs confirm existence; exact media endpoint path and response format require authenticated access to verify at implementation time)
- Google Sheets `batchUpdate` write-back pattern: existing `src/sheets/writer.ts` in production codebase — HIGH confidence

---

*Architecture research for: Fortee Catalog Engine v2.0 Image Automation*
*Researched: 2026-03-26*
