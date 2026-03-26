# Project Research Summary

**Project:** Fortee Catalog Engine — v2.0 Image Automation Milestone
**Domain:** AI-powered product image pipeline for custom apparel e-commerce
**Researched:** 2026-03-26
**Confidence:** MEDIUM-HIGH

## Executive Summary

The v2.0 milestone adds automated image quality auditing, supplier image re-fetching, and AI-generated back/side views on top of a complete and working v1.0 catalog engine. The existing codebase already contains all foundational infrastructure — `standardizeImage()`, `uploadStagedImage()`, `downloadImage()`, the OneSource SOAP client, the S&S Canada REST client, and the Google Sheets write-back pattern — so this milestone is primarily integration work, not greenfield construction. The recommended approach is to add a single new `src/images/` module containing 4 focused components (quality scorer, OMG sourcer, AI generator, audit orchestrator) plus a sheet column extension, wired together via a new `scripts/audit-images.ts` CLI. Only one new npm dependency is required: `openai`.

The highest-value build path is to work in dependency order: quality scorer first (no external API, enables all downstream validation), sheet columns second (write-back plumbing), supplier re-fetch third (cheapest source, must be exhausted before AI), and AI generation last (most expensive, most risk). This ordering ensures each component is independently testable and that AI generation is only invoked when cheaper sourcing options are exhausted. Cost control is real — AI generation runs at $0.034–$0.063 per image; gating generation behind the quality scorer and supplier re-fetch keeps costs proportionate to actual catalog gaps.

The primary risks are: (1) Shopify's `productSet` mutation deletes omitted list items — image replacement must fetch existing media GIDs and merge them before any product mutation; (2) AI-generated views exhibit color and proportion drift relative to the front image — a color-distance validation step is mandatory before accepting any generated output; (3) the quality scorer must operate on the trimmed garment region, not the full white-background canvas, or it will produce false rejects on good supplier images. All three pitfalls are well-documented with clear prevention strategies that must be built into the relevant phases.

## Key Findings

### Recommended Stack

The v2.0 stack is minimal. Only `openai` (v6.33.0) needs to be added to `package.json`. Everything else — `sharp`, `cheerio`, `googleapis`, `@shopify/admin-api-client`, `p-queue`, `winston`, `zod` — is already installed and working. AI generation uses the `images.edit()` endpoint with the front image as a reference buffer, which preserves garment identity. Image quality scoring is implemented in-process via `sharp().convolve()` with a Laplacian kernel — no Sightengine, no OpenCV, no external paid API required.

**Core technologies:**
- `openai` v6.33.0: AI back/side view generation via `images.edit()` — the only new dependency; official SDK with TypeScript support and automatic multipart form handling
- `sharp` (existing): Laplacian blur detection via `convolve()`, garment trimming via `trim()`, resolution checks via `metadata()` — zero cost, no external service
- `@shopify/admin-api-client` (existing): staged image upload via `stagedUploadsCreate` — already proven in v1.0 pipeline
- `googleapis` (existing): audit status write-back to Google Sheet via existing `EnrichmentUpdate` / `writeUpdates()` pattern
- `p-queue` (existing): concurrency control — ≤8 for OpenAI generation calls, ≤3 for supplier scraping with 500ms delay

**Do not add:** axios, node-soap, opencv4nodejs, jimp, playwright, replicate SDK, or sightengine. Each is either redundant with the existing stack or introduces complexity without benefit.

### Expected Features

See `.planning/research/FEATURES.md` for full detail and component dependency graph.

**Must have (table stakes):**
- Image quality audit across all sheet rows — establishes ground truth before sourcing or generation
- Blur and minimum-resolution detection — supplier images are frequently low quality or too small
- Missing-image detection — many products have front-only images with no back or side
- Image status write-back to Google Sheet — operator visibility into audit and pipeline results
- Supplier re-fetch for front images (Canada Sportswear + S&S Canada) — highest-quality source before AI fallback
- AI-generated back/side views via `images.edit()` with front image as reference — fills most common catalog gap
- Quality gate on generated images — same scorer as audit step, prevents bad AI outputs reaching Shopify
- Re-standardize all accepted images through existing `standardizeImage()` — 2000x2000 canvas, print area coords
- Upload replacements to Shopify — closes the loop from generation to published product

**Should have (differentiators):**
- Perceptual hash deduplication via `sharp` pHash — skip re-upload when sourced image matches existing
- Confidence score on generated images written to sheet — enables operator spot-check without blocking the pipeline
- Category-aware generation prompts (`tops`, `hoodies`, etc.) — materially improves AI output quality
- Dry-run mode (`--dry-run` flag) — score and log without writing to Shopify or Sheets
- Incremental processing — skip rows already marked `OK`, saves time on 100+ product batch runs

**Defer to v2.1+:**
- Parallel batch processing optimization (start sequential, add p-queue concurrency once pipeline is proven)
- Custom LoRA fine-tuning (requires hundreds of images per style, weeks of iteration, $200-400+/run)
- On-model AI visualization (inconsistent across SKUs, high cost, not Fortee's use case)
- Background replacement / lifestyle scenes (breaks white-background canvas pipeline for print area overlay)
- Human review UI (sheet-based review is sufficient for a single operator)

### Architecture Approach

The audit pipeline is a standalone module that runs independently of `pushProduct`. It reads from the existing Google Sheet, calls quality scorer / OMG sourcer / AI generator in a fallback sequence, and writes back status using the existing `EnrichmentUpdate` pattern. The only modification to existing files is appending 6 optional fields to `SheetRow` in `src/sheets/types.ts` — a zero-impact change because `readAllRows()` maps by header name, not column index. `pushProduct` is not touched and continues to work without the new environment variables.

See `.planning/research/ARCHITECTURE.md` for full component specifications, interface definitions, and per-image data flow diagram.

**Major components:**
1. `src/images/quality-scorer.ts` — Laplacian variance blur detection + resolution check on trimmed garment region; returns `QualityResult { score, verdict, reasons, width, height }`
2. `src/sheets/image-columns.ts` — 6 new sheet columns (`imageAuditStatus`, `frontImageSource`, `backImageSource`, `sideImageSource`, `imageAuditDate`, `frontQualityScore`); delegates to existing `writeUpdates()`
3. `src/images/omg-sourcer.ts` — PromoStandards OneSource media endpoint for supplier re-fetch; returns URL array or empty array (never throws)
4. `src/images/ai-generator.ts` — OpenAI `images.edit()` with front image as reference; returns generated Buffer; caller verifies with quality scorer before accepting
5. `src/images/audit-runner.ts` — per-product orchestrator: score → source (if poor/missing) → generate (if source fails) → standardize → upload → write-back
6. `scripts/audit-images.ts` — CLI entry point with `--style-id`, `--all`, `--dry-run` flags

### Critical Pitfalls

See `.planning/research/PITFALLS.md` for full detail on all 5 critical and 5 moderate pitfalls.

1. **`productSet` files list is destructive** — Omitting existing images from a `productSet` call permanently deletes them. Before any image replacement, fetch current media GIDs, merge with new `resourceUrl` values. Prefer `productCreateMedia` / `productDeleteMedia` for surgical replacement over a full product re-push. Confirmed via Shopify official docs and community forum (HIGH confidence).

2. **AI-generated views exhibit color and proportion drift** — Generated back/side views frequently differ from the front in hue, garment length, and collar shape. Compute mean HSV of the trimmed garment region; reject if hue drift exceeds 15 degrees. Generate 3 candidates per view and accept only the highest-scoring one — never auto-accept the single first output. (MEDIUM confidence — observed pattern, requires empirical threshold tuning.)

3. **Quality scorer miscalibrated for white-background images** — Laplacian variance on a full canvas with 60–70% white area produces false rejects on clean supplier images. Crop to garment bounding box via `sharp.trim()` before scoring. Calibrate thresholds against 30–50 known-good and known-bad samples — mandatory task in Phase 1 before any production run. (MEDIUM confidence — white-background failure mode documented in research literature.)

4. **Shopify staged upload orphaned files** — Every `stagedUploadsCreate` + PUT creates a file in the Files library even if the pipeline fails mid-run. Track `resourceUrl` values per run; build a periodic `fileDelete` cleanup step; check run log before re-uploading. (HIGH confidence — confirmed via Shopify developer community.)

5. **Supplier CDN hotlink blocking** — Image download returns a 403 HTML error page; `sharp` throws a cryptic format error rather than a clear "image not found." Validate buffer magic bytes (PNG/JPEG signature) before passing to sharp. Set browser-like `User-Agent` and `Referer` headers on all image fetch calls. (MEDIUM confidence — based on known CDN patterns from v1.0 scraping experience.)

## Implications for Roadmap

Based on combined research, the architecture's build-order section directly maps to a 6-phase roadmap. Dependencies are clear and each phase produces a verifiable deliverable before the next begins.

### Phase 1: Quality Scorer
**Rationale:** Zero external API dependencies. Enables all downstream validation — the AI generator, OMG sourcer fallback logic, and audit runner all depend on it. Building this first is the critical path unblock.
**Delivers:** `scoreImageQuality(buffer, options): Promise<QualityResult>` with Laplacian variance on trimmed garment region; threshold calibrated against 30–50 real supplier images
**Addresses:** Blur/resolution detection (table stakes), quality gate on generated images (table stakes)
**Avoids:** Pitfall A3 (miscalibration on white-background images) — must operate on trimmed garment region only; threshold calibration is mandatory before production use

### Phase 2: Sheet Image Columns
**Rationale:** No external API dependencies. Write-back plumbing needed by every subsequent phase. Non-breaking change to `SheetRow` (appends optional fields only).
**Delivers:** 6 new sheet columns, `writeImageStatus()`, updated `SheetRow` type with 6 optional fields
**Addresses:** Image status write-back (table stakes), incremental processing (differentiator)
**Avoids:** Pitfall B2 (Sheets write race condition) — collect all updates in memory, flush as single `batchUpdate` at end of run, never per-product interleaved writes

### Phase 3: OMG Sourcer
**Rationale:** Isolated HTTP call, no Shopify or sharp dependency. Supplier re-fetch is cheaper than AI generation and must be exhausted first. Failure mode is graceful — returns empty array and never throws.
**Delivers:** `sourceImagesFromOMG(supplierCode, styleID): Promise<string[]>` in a fallback chain: OMG → CSW scrape → existing sheet URL
**Addresses:** Source front images from supplier sites (table stakes)
**Avoids:** Pitfall B4 (OMG API scope misunderstood) — treat as one optional source in fallback chain; verify catalog access against 10 known styles before building out; never assume full catalog coverage

### Phase 4: AI Generator
**Rationale:** Most expensive per-call. Depends on Phase 1 (quality scorer) for post-generation verification. Build after scorer so the accept/reject loop is fully operational before spending API budget on iteration.
**Delivers:** `generateGarmentView(frontBuffer, view, description): Promise<Buffer>` using `images.edit()` with front as reference
**Uses:** `openai` v6.33.0 (only new npm install required for all of v2.0)
**Avoids:** Pitfall A2 (color/proportion drift) — run color-distance check and `detectGarmentBounds` on all outputs; generate 3 candidates per view; accept only highest scorer; Pitfall B3 (generated image breaks sharp.trim) — verify trim result covers 20–85% of canvas before accepting

### Phase 5: Audit Runner
**Rationale:** Integration layer that wires all prior components. Single-product end-to-end verification must work before batch mode. Deliberately isolated from `pushProduct` — new env vars (`OPENAI_API_KEY`, `OMG_API_KEY`) are not required for basic product push.
**Delivers:** `auditProductImages(styleID, options): Promise<AuditResult>` — score → source/generate → re-score → standardize → upload → write-back
**Implements:** Full audit runner component (`src/images/audit-runner.ts`)
**Avoids:** Pitfall A1 (productSet deletes existing images) — use `productCreateMedia` for additions, not `productSet` re-push; fetch existing GIDs before any replacement. Pitfall B5 (Print Area metaobject GID broken) — update metaobject `media` field immediately after replacing front image

### Phase 6: CLI and Batch Mode
**Rationale:** Built last because it exposes the full pipeline to external rate limits and real API costs. Validating single-product mode in Phase 5 first reduces the blast radius of early batch bugs.
**Delivers:** `scripts/audit-images.ts` with `--style-id`, `--all`, `--dry-run` flags; p-queue concurrency limits (OpenAI ≤8, supplier scraping ≤3); checkpoint file for resumable batch runs
**Avoids:** Pitfall B1 (API rate limits break batch runs mid-catalog) — p-queue with backpressure, checkpoint after each success, exponential backoff on 429; Pitfall C3 (concurrent scraping triggers IP block) — 500ms delay between same-domain requests

### Phase Ordering Rationale

- Phases 1 and 2 have zero external dependencies and establish the stable base that all other phases build on
- Phase 3 (OMG sourcer) is isolated and inexpensive to verify with a single API call against a known product — confirms catalog access scope before committing to the full sourcing architecture
- Phase 4 (AI generator) must follow Phase 1 because the quality scorer is the accept/reject mechanism for generated outputs — building them out of order requires manual review of every AI output during development
- Phase 5 (audit runner) is last among `src/` components because it integrates everything; single-product testing at this stage catches integration bugs before they compound across a batch
- Phase 6 (CLI + batch) is last because it introduces concurrency, rate limits, and costs at scale; the single-product path must be solid before batch mode is added

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (OMG Sourcer):** OrderMyGear API endpoint path and response schema require authenticated access to verify. Catalog access scope is unknown until a sample request is made against the actual account. Recommend a 30-minute API exploration session before writing the component spec.
- **Phase 4 (AI Generator):** Prompt engineering for garment back/side views requires empirical iteration. First outputs for hoodies, polos, and jackets may need category-specific prompt tuning. Plan for 1–2 prompt refinement cycles before locking prompt templates.
- **Phase 5 (Audit Runner):** Print Area metaobject `media` field population status is unconfirmed in the current implementation. Verify whether the field is currently populated before building the GID update logic.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Quality Scorer):** Sharp Laplacian convolution is well-documented; technique is established. Threshold calibration is empirical work, not research-dependent.
- **Phase 2 (Sheet Image Columns):** Identical pattern to existing v1.0 `EnrichmentUpdate` write-back. No new patterns required.
- **Phase 6 (CLI + Batch):** Mirrors `scripts/push-product.ts` structure; p-queue concurrency pattern is already in use in the codebase.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | OpenAI SDK v6.33.0 confirmed on GitHub. Sharp Laplacian approach verified against official docs. S&S API image fields verified directly from API docs. Only one new package needed. |
| Features | MEDIUM-HIGH | Table stakes features are well-defined from v1.0 patterns. AI generation output quality is empirically uncertain — prompt tuning will be required in Phase 4. |
| Architecture | HIGH | Build order is dependency-driven with clear verification points per phase. Interface definitions are concrete and match the existing codebase patterns. Only OMG API response shape needs live verification. |
| Pitfalls | HIGH | Critical pitfalls A1 and A4 confirmed via Shopify official docs and community. B1 confirmed via fal.ai FAQ. A2 and A3 rated MEDIUM — documented pattern, threshold calibration values require empirical tuning. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **OMG API catalog access scope:** Confirm which CSW/S&S styles are accessible under the account before designing the sourcing fallback chain. Do not assume full catalog coverage — Pitfall B4 documents why this assumption fails.
- **`gpt-image-1.5` availability:** STACK.md references `gpt-image-1.5` as a newer variant at 20% lower cost. Verify availability via the OpenAI API at implementation time; fall back to `gpt-image-1` if unavailable.
- **Quality threshold calibration:** Laplacian variance thresholds for garment images must be calibrated against 30–50 real supplier samples before production use. This is a mandatory task in Phase 1, not optional.
- **Print Area metaobject `media` field:** Confirm whether the current v1.0 implementation populates the `media` field on Print Area metaobjects. If it does not, Pitfall B5 is lower risk than assessed; if it does, the Phase 5 GID update step is non-negotiable.
- **`p-queue` package.json entry:** STACK.md notes `p-queue` is used in the codebase but may not be listed in `package.json`. Verify before building Phase 6 against it.

## Sources

### Primary (HIGH confidence)
- OpenAI Node.js SDK GitHub releases — v6.33.0 confirmed, `images.edit()` API verified
- OpenAI Image Generation docs — `gpt-image-1` model, `images.edit()` with reference image inputs
- S&S Activewear REST API (`api.ssactivewear.com/V2/Products.aspx`) — `colorFrontImage`, `colorBackImage`, `colorSideImage` field names
- Sharp API docs (`sharp.pixelplumbing.com`) — `convolve()`, `stats()`, `trim()`, `metadata()`
- Shopify productSet mutation docs — list field destructive replace behavior
- Shopify developer community forum — image deletion on productSet re-run (March 2025)
- Google Sheets API docs — 1 write/sec limit, TOCTOU race condition documentation
- fal.ai official FAQ — rate limits (10 concurrent tasks default)
- OrderMyGear API Terms of Use — catalog access scope constraints

### Secondary (MEDIUM confidence)
- OpenAI gpt-image-1.5 pricing sources (March 2026) — $0.034–$0.063 at medium quality, 1024x1024
- OneSource API documentation — SOAP format confirmed; REST not yet available as of March 2026
- Orbitvu 2026 comparison report — AI-generated apparel color/proportion drift observed in practice
- CHI 2025 artifact study — diffusion model artifact characterization
- Springer Multimedia Systems — BRISQUE/NIQE limitations on non-natural (white-background) images
- LinkedIn: Pinpointing Blurry Images in Node.js — Laplacian approach via sharp confirmed

### Tertiary (LOW confidence)
- OrderMyGear REST API timeline — "REST/JSON coming" with no confirmed release date; do not build against it

---
*Research completed: 2026-03-26*
*Ready for roadmap: yes*
