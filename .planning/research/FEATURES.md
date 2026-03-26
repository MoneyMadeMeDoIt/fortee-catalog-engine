# Feature Landscape

**Domain:** Automated product image pipeline for custom apparel e-commerce
**Researched:** 2026-03-26
**Milestone:** v2.0 Image Automation (subsequent milestone — v1.0 catalog engine is complete)
**Confidence:** MEDIUM-HIGH

---

## Context: What Already Exists

The v1.0 pipeline (complete) provides:
- `standardizeImage()` — sharp.trim() garment detection, 2000x2000 canvas placement
- `processProductImages()` — download → standardize → staged upload → `FileSetInput[]`
- `derivePrintAreaCoords()` — garment-placement-relative print area coordinates
- `uploadStagedImage()` — Shopify GraphQL `stagedUploadsCreate` + PUT
- `SheetRow` — fields `FrontImage`, `BackImage`, `DirectSideImage` already exist
- `downloadImage()` — URL fetch with 30s timeout

v2.0 builds on top of these. New features must integrate cleanly with `processProductImages()` and the sheet write-back pattern already established in `enrich.ts`.

---

## Table Stakes

Features the operator requires for v2.0 to deliver value. Missing any of these = the milestone goal is unmet.

| Feature | Why Expected | Complexity | Dependency on Existing Code |
|---------|--------------|------------|----------------------------|
| Image quality audit across all sheet rows | Must know which products have bad/missing images before sourcing or generating | Med | Reads `FrontImage`, `BackImage`, `DirectSideImage` from sheet. Calls `downloadImage()` + quality scoring |
| Blur / low-resolution detection | White-background garment photos from suppliers are often blurry or too small | Med | Uses `sharp` metadata (width, height). Laplacian variance or `@bstrickl/blurriness` for blur score |
| Missing-image detection | Many products lack back or side views entirely | Low | `SheetRow` fields are empty strings when missing. Already handled as skip in `processProductImages()` |
| Image status write-back to Google Sheet | Operator must track audit results, sourcing status, and generation status in the sheet | Med | Uses existing `writer.ts` / `EnrichmentUpdate` pattern. Needs new status columns |
| Source front images from supplier sites | Canada Sportswear and S&S Canada have hi-res images; scraping/API is more reliable than stored URLs | Med | Canada Sportswear: existing cheerio scraper. S&S Canada: existing REST API (`/V2/Products` returns `ColorArray[].colorFrontImage`) |
| AI-generate missing back/side views | Many products have front-only images; back and side needed for e-commerce completeness | High | Calls fal.ai FLUX.1 Kontext or similar. Input: front image buffer. Output: back/side buffer fed into existing `standardizeImage()` |
| Quality gate on generated images | AI-generated views must pass the same blur/resolution checks before acceptance | Med | Same quality scoring as audit step. Reject and log if below threshold |
| Re-standardize all accepted images | All sourced or generated images must go through the existing 2000x2000 pipeline | Low | Already exists: `standardizeImage()`. Just needs to be called on sourced/generated buffers |
| Upload replacements to Shopify | Accepted images must replace or supplement the existing product images in Shopify | Med | Uses existing `uploadStagedImage()`. Needs `productMedia` update or re-push via `productSet` |

---

## Differentiators

Features that make the pipeline meaningfully better than manually handling images.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Perceptual hash deduplication | Detect when a "new" sourced image is identical to what's already in the sheet — skip re-upload | Low | `sharp` exposes pHash. Hamming distance comparison in nanoseconds. Saves Shopify API calls and CDN storage |
| Confidence score on AI-generated images | Don't silently accept low-quality AI outputs. Log confidence so operator can spot-check | Med | Quality score (blur + white-area ratio + edge density) on generated output. Write score to sheet alongside status |
| Category-aware generation prompts | Prompt the AI with category context ("back view of a hoodie with front zipper, white background") rather than generic instructions — dramatically better results | Med | Uses existing `CategoryGroup` type (`tops` / `hoodies`). Prompt templates per category |
| Dry-run mode for audit | Show what would be flagged/replaced without writing to sheet or Shopify | Low | `--dry-run` flag pattern already implicit in the existing codebase ethos. JSON output of planned actions |
| Incremental processing | Skip rows where image status column is already "OK" — don't re-audit or re-generate on every run | Low | Check status column before downloading. Saves time on 100+ product runs |
| Parallel processing with rate limiting | Process multiple products concurrently without hammering supplier sites or fal.ai rate limits | Med | `p-queue` already in the stack. Add concurrency limits for each external service separately |

---

## Anti-Features

Features to explicitly NOT build in v2.0.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| On-model AI visualization | Requires training or carefully prompting for consistent model appearance across dozens of SKUs. Cost is high ($0.04+/image × many SKUs × retries). Not what Fortee sells — they sell blank garments for decoration | Flat lay / ghost mannequin style (pure garment on white) matches supplier photography standard and decoration builder UX |
| Background replacement / lifestyle scenes | Fortee's Dawn builder requires clean white-background images for print area overlay to work. Background scenes break the canvas pipeline entirely | Keep white background. The print area metaobject system depends on garment-on-white |
| Custom LoRA fine-tuning | Training a custom model on Fortee garments requires hundreds of images per style, weeks of iteration, and $200-400+/run. Overkill for a sourcing fallback | Use FLUX.1 Kontext image-to-image (front image as reference) — good enough for back/side view generation without training |
| Automated Shopify product image reorder | Image position in Shopify matters for variant-image association. Reordering programmatically is fragile and undocumented in GraphQL | Push images in the correct order at creation time (front first). Don't reorder post-hoc |
| Human review UI / approval queue | Single operator. CLI with quality scores and a CSV/sheet summary is faster to build and sufficient | Write scores + status to sheet. Operator reviews the sheet and triggers re-runs manually |
| Video generation | Video product demos are a differentiator for fashion, but Fortee's use case is decoration ordering. No video needed in v2 | Static images only |
| Multi-view consistency enforcement via ControlNet | Ensuring the AI-generated back view has the exact same collar rib, hemline, and pocket position as the front requires ControlNet + custom setup. Complex and brittle | Accept "plausible same garment" quality. If AI back view is clearly wrong, flag for manual replacement |

---

## Feature Dependencies

```
Existing v1.0 pipeline
  └── downloadImage()
  └── standardizeImage()
  └── uploadStagedImage()
  └── SheetRow (FrontImage / BackImage / DirectSideImage columns)
  └── writer.ts (EnrichmentUpdate pattern)
  └── p-queue (rate limiting)

New v2.0 features:

[1] Quality Scorer
    Inputs:  image buffer (from downloadImage)
    Outputs: { blur: number, resolution: {w,h}, white_ratio: number, score: 'OK'|'POOR'|'MISSING' }
    Depends: sharp (metadata + stats), @bstrickl/blurriness OR Laplacian impl

[2] Audit Runner
    Inputs:  SheetRow[] (FrontImage, BackImage, DirectSideImage)
    Outputs: AuditReport[] written to sheet via EnrichmentUpdate
    Depends: [1] Quality Scorer, downloadImage(), writer.ts

[3] Image Sourcer (supplier re-fetch)
    Inputs:  SheetRow (supplierCode, partNumber, colorName)
    Outputs: { front?: Buffer, back?: Buffer, side?: Buffer }
    Depends: canada-sportswear.ts (existing cheerio scraper)
             ss-canada.ts (existing REST client, colorFrontImage/colorBackImage fields)

[4] AI View Generator
    Inputs:  front image Buffer, CategoryGroup, target view ('back'|'side')
    Outputs: generated image Buffer
    Depends: fal.ai FLUX.1 Kontext API (@fal-ai/client npm package)
             CategoryGroup type (existing in shopify/types.ts)
             Prompt template per CategoryGroup + view

[5] Quality Gate
    Inputs:  generated Buffer from [4]
    Outputs: accepted Buffer OR rejection with reason
    Depends: [1] Quality Scorer (same thresholds)

[6] Image Replace/Supplement Pipeline
    Inputs:  accepted Buffer (from [3] or [5])
    Outputs: Shopify media GID, updated SheetRow image URL
    Depends: standardizeImage() (existing)
             uploadStagedImage() (existing)
             Shopify productMediaUpdate OR productSet re-push

[7] Status Write-back
    Inputs:  AuditReport + sourcing/generation outcomes
    Outputs: Sheet columns updated (imageStatus, imageSource, imageScore)
    Depends: writer.ts (existing EnrichmentUpdate)

Execution order:
  [2] Audit → [3] Source (if POOR/MISSING) → [4] Generate (if source fails) → [5] Gate → [6] Upload → [7] Write-back
```

---

## MVP Recommendation

Prioritize (in order):

1. **Quality audit + status write-back** ([1] + [2] + [7]) — establishes ground truth. Operator sees exactly what the catalog looks like before any generation runs. Low risk, high immediate value.

2. **Supplier re-fetch for front images** ([3]) — Canada Sportswear and S&S Canada are the most reliable source for high-quality front images. Should be attempted before AI generation. Reuses existing scrapers.

3. **AI back/side generation with quality gate** ([4] + [5]) — fills the most common gap (missing back/side views). Use FLUX.1 Kontext with the front image as reference input. Gate on blur + white-background ratio.

4. **Upload + sheet write-back** ([6] + [7] combined) — closes the loop. Replaces or adds images in Shopify and records the final status.

Defer to v2.1 or later:
- Perceptual hash deduplication (nice to have, not blocking)
- Category-aware prompt tuning (start with generic prompts, refine based on real output quality)
- Parallel processing optimization (start sequential, add p-queue concurrency once pipeline is proven)

---

## Complexity Assessment for Phase Planning

| Feature Group | Effort | Risk | Notes |
|---------------|--------|------|-------|
| Quality scorer (blur + resolution) | 1-2 days | LOW | Sharp metadata is straightforward. Laplacian requires a small custom impl or `@bstrickl/blurriness` |
| Audit runner + sheet write-back | 1 day | LOW | Pattern is identical to existing `enrich.ts`. New status columns needed |
| Supplier re-fetch (CSW + S&S) | 1-2 days | LOW | Scrapers exist. May need adjustment for image-specific endpoints |
| fal.ai API integration | 1 day | MEDIUM | API is simple. Risk is prompt quality: first outputs for back/side may need prompt iteration |
| AI quality gate | 0.5 days | LOW | Reuse scorer from audit step |
| Shopify image replacement | 1-2 days | MEDIUM | `productMediaUpdate` mutation needs testing. Ordering matters. Consider re-push via `productSet` instead |
| End-to-end pipeline orchestration | 1 day | MEDIUM | Error handling across 5 steps with partial success / retry logic |

Total estimate: 7-10 days for full v2.0 feature set.

---

## Sources

- [PROJECT.md](../../.planning/PROJECT.md) — project requirements and v2.0 goal definition (HIGH confidence)
- [FLUX.1 Kontext fal.ai API](https://fal.ai/models/fal-ai/flux-pro/kontext) — $0.04/image, image-to-image editing with context preservation (HIGH confidence)
- [fal.ai FLUX API overview](https://fal.ai/flux) — full model lineup (HIGH confidence)
- [sharp image operations](https://sharp.pixelplumbing.com/api-operation/) — trim, metadata, stats for quality scoring (HIGH confidence)
- [@bstrickl/blurriness npm](https://www.npmjs.com/package/@bstrickl/blurriness) — blur score 0-1 for Node.js (MEDIUM confidence — small package, needs threshold calibration)
- [Shopify stagedUploadsCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/stageduploadscreate) — existing upload mechanism, already in use (HIGH confidence)
- [Shopify manage media for products](https://shopify.dev/docs/apps/build/online-store/product-media) — how to add/replace product media (HIGH confidence)
- [S&S Activewear REST API](https://api.ssactivewear.com/V2/Products.aspx) — colorFrontImage / colorBackImage fields (HIGH confidence)
- [Perceptual hashing in Node.js with sharp](https://www.brand.dev/blog/perceptual-hashing-in-node-js-with-sharp-phash-for-developers) — pHash deduplication (MEDIUM confidence)
- [AI product photography tools 2026](https://claid.ai/blog/article/ai-product-photo-tools) — ecosystem overview (MEDIUM confidence — WebSearch)
- [Scenario Turnaround Studio](https://www.scenario.com/apps/turnaround-studio) — multi-view generation reference (MEDIUM confidence — WebSearch)
- [PromoStandards media service](https://promostandards.org/) — supplier image API standard for promotional products (MEDIUM confidence)

---
*Feature research for: Fortee Catalog Engine v2.0 Image Automation*
*Researched: 2026-03-26*
