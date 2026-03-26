# Domain Pitfalls

**Domain:** Custom apparel catalog enrichment pipeline + Shopify product automation
**Researched:** 2026-03-05 (v1.0) | Updated: 2026-03-26 (v2.0 image automation)

---

## v2.0 Image Automation Pitfalls

Pitfalls specific to adding AI image generation, quality scoring, image sourcing, and automated
Shopify image replacement to the existing catalog engine.

---

### Critical Pitfalls (Image Pipeline)

Mistakes that cause data loss, broken storefronts, or require pipeline rewrites.

---

#### Pitfall A1: productSet Files List is Destructive — Omitting Existing Images Deletes Them

**What goes wrong:** Calling `productSet` with a new `files` array containing only the replacement
images deletes every other image on the product. `files` is a list field, and Shopify's documented
behavior for list fields is: create new entries, update existing entries, **delete existing entries
not included in the call**.

**Why it happens:** Developers assume `productSet` behaves like a PATCH for images the same way it
does for scalar fields (title, description). For scalars, omitting the field preserves the value.
For list fields — files, variants, metafields — omitting an item removes it permanently.

**Consequences:** Product loses all but the replacement images. Front image replaced but back/side
deleted. Print Area metaobject media references break. Shopify storefront shows blank image slots.

**Prevention:**
1. Before calling `productSet` with new images, fetch the current product media GIDs via
   `product.media` query.
2. Include ALL existing file GIDs plus the new staged image resourceUrls in the mutation.
3. Implement a `mergeFiles(existing, incoming)` utility that prepends existing by GID.
4. In the audit phase, never run a full product re-push — use targeted `productUpdate` or
   `productCreateMedia` / `productDeleteMedia` mutations for surgical image replacement.

**Detection warning signs:**
- Products with fewer images than expected after an image replacement run.
- Shopify files library gaining new images while products show empty image slots.
- "Back Print" alt tag missing from product media after a re-run.

**Phase:** Whichever phase first does automated image replacement (image sourcing / replacement phase).

**Confidence:** HIGH — confirmed via Shopify official docs and community forum thread (March 2025).

---

#### Pitfall A2: AI-Generated Back/Side Views Exhibit Color and Proportion Drift

**What goes wrong:** Generative models produce back and side views that differ visibly from the
front view in color temperature, garment length, collar shape, and sleeve placement. A royal blue
front becomes a darker navy back. A mid-length tee becomes a cropped tee from behind.

**Why it happens:** Diffusion models generate images conditioned on a prompt and/or a reference
image, but they do not enforce physical garment consistency across generations. Each view is an
independent probabilistic sample. Minor prompt ambiguity — or different seed values — introduces
geometric and chromatic drift.

**Consequences:** Customer sees a front/back inconsistency. Returns spike because the customer
received a product consistent with the *front* image but not the *back*. Color swatches become
unreliable. Batch runs amplify: one bad generation poisons an entire colorway if auto-accepted.

**Prevention:**
1. Use an image-to-image inpainting pipeline (not text-to-image) with the front image as a seed.
   ControlNet depth/pose conditioning constrains shape drift.
2. Always verify generated images pass a color-distance check against the front image:
   compute mean HSV of the dominant garment region; reject if hue shifts >15 degrees or value
   shifts >20%.
3. Generate 3 candidates per view, score them, accept only the highest scorer — never accept
   the single first output.
4. Maintain a per-colorway "reference front buffer" and run all comparison checks against it,
   not the already-standardized 2000x2000 canvas.

**Detection warning signs:**
- Diff between front and back garment dominant hue >15 degrees.
- Generated garment height (trimmed px) differs from source by >12%.
- Human spot-check on first 20 products reveals any obvious mismatch.

**Phase:** AI generation phase — needs dedicated validation step built in before accepting any output.

**Confidence:** MEDIUM — observed pattern documented in Orbitvu 2026 comparison, CHI 2025 artifact
study, and apparel-specific forum analysis. No direct benchmark for this pipeline exists.

---

#### Pitfall A3: Quality Scorer Miscalibrated for White-Background Apparel Images

**What goes wrong:** General-purpose image quality metrics (BRISQUE, NIQE, Laplacian variance for
blur) are calibrated on natural scene statistics. White-background product photography violates
the "natural image" statistical assumption: large uniform white regions score as "blurry" or
"unnatural" even when the garment itself is sharp and correctly exposed.

**Why it happens:** BRISQUE and NIQE were trained on distorted versions of natural scene photos
(landscapes, people). Product images with 60-70% white canvas are outside the training distribution.
A perfectly sharp garment on a white background may score worse than a slightly blurry lifestyle
photo because the NSS features are dominated by the white regions.

**Consequences:** The quality gate rejects good supplier images and passes bad ones. Mass false-
positive rejects force expensive AI generation for images that were fine. Mass false-negative
passes allow blurry or off-color images into Shopify.

**Prevention:**
1. Crop to the garment bounding box (using the existing `detectGarmentBounds` / `sharp.trim()`
   pipeline) before computing quality metrics. Score only the garment pixels.
2. Use Laplacian variance on the trimmed garment region, not the full 2000x2000 canvas.
   Threshold: empirically calibrate on 30-50 manually reviewed images, not default literature values.
3. Supplement with structural checks that work on product images: resolution >= 1200px on longest
   side, aspect ratio within 0.8–1.2 (portrait/square), garment coverage >= 25% of canvas after trim.
4. Cross-validate: run scorer on 50 known-good and 50 known-bad supplier images before deploying
   to production batch.

**Detection warning signs:**
- Scorer rejects >40% of scraped supplier images (likely over-penalising white background).
- Scorer accepts known-blurry images visible to naked eye (threshold too permissive).

**Phase:** Quality scoring phase. Calibration step is mandatory before production run.

**Confidence:** MEDIUM — BRISQUE/NIQE white-background failure mode documented in Springer/IIETA
research. Threshold calibration approach is standard practice; specific numbers require empirical
tuning on this dataset.

---

#### Pitfall A4: Shopify Staged Upload File Accumulation (Orphaned Files)

**What goes wrong:** Every `stagedUploadsCreate` + PUT cycle deposits a file in the Shopify Files
library, even if the file is never attached to a product (pipeline errors mid-run) or if the
pipeline replaces an image that was already uploaded in a prior run. Over 100+ products with 3
views each and multiple retry runs, this becomes hundreds of orphaned PNG files consuming Shopify
file storage.

**Why it happens:** Shopify's staged upload flow is write-only: you create a staged target, PUT
the file, get a `resourceUrl`. Shopify processes it asynchronously into the Files library.
There is no "upload to product directly" — the file exists independently first. Errors after
upload but before `productSet` leave the file stranded.

**Consequences:** Files library bloat. Storage quota risk on lower-tier Shopify plans. Duplicate
images accumulating when re-running the pipeline (Shopify does not deduplicate by URL content —
re-uploading the same PNG creates a new file).

**Prevention:**
1. Track all uploaded `resourceUrl` values in a run log (keyed by product/color/view).
2. On successful `productSet`, mark those resourceUrls as "attached."
3. On pipeline failure mid-run, log which resourceUrls were uploaded but not attached.
4. Build a periodic cleanup utility using `fileDelete` mutation to remove unattached files older
   than 24 hours. Run as optional maintenance step, not inline with the pipeline.
5. Before re-running a product's images, check if a prior upload exists in the run log to skip
   re-upload.

**Detection warning signs:**
- Files library count grows faster than `(products * 3)`.
- Same filename appears multiple times in the Files library with slightly different suffixes
  (Shopify appends a unique hash to filenames on upload).

**Phase:** Image replacement phase (upload utility). Cleanup utility in scale/reliability phase.

**Confidence:** HIGH — productSet duplication behavior confirmed via Shopify developer community forum.

---

#### Pitfall A5: Supplier Image URL Instability and Hotlink Blocking

**What goes wrong:** Canada Sportswear and OrderMyGear CDN URLs scraped today may return 403 or
redirect tomorrow. CDN providers (Cloudflare) can enable hotlink protection that blocks
programmatic image fetches using a non-browser User-Agent or missing Referer header.

**Why it happens:** Supplier sites use CDN-level hotlink protection as a default anti-scraping
measure. Image URLs often include signed parameters, expiry tokens, or are served from origin
domains that require session cookies.

**Consequences:** Image download step silently returns a 403 HTML error page, which `sharp` then
tries to parse as an image, throwing a cryptic "Input buffer contains unsupported image format"
error instead of a clear "Image not found" message.

**Prevention:**
1. Always validate downloaded buffers before passing to `sharp`: check magic bytes for PNG/JPEG
   signature. Fail fast with a clear error message if the buffer starts with `<!DOCTYPE`.
2. Set `User-Agent` and `Referer` headers on image download requests to mimic a browser.
3. For Canada Sportswear: prefer the `/products.json` endpoint image URLs (already done in v1.0)
   over scraping the rendered product page. JSON endpoint URLs are more stable.
4. For OrderMyGear API: per their Terms of Use, only download images for products the account
   has licensed. Confirm image download rights before bulk fetch.
5. Cache downloaded images locally (keyed by URL hash) so a re-run does not re-fetch if the
   buffer was already validated.

**Detection warning signs:**
- `sharp` throws "Input buffer contains unsupported image format" in image pipeline.
- Downloaded buffer size < 500 bytes (HTML error pages are small; PNG images are not).
- HTTP 403 or 301 redirect responses from image fetch.

**Phase:** Image sourcing phase.

**Confidence:** MEDIUM — hotlink protection mechanics are well-documented; Canada Sportswear-specific
behavior based on known CDN patterns from v1.0 scraping experience.

---

### Moderate Pitfalls (Image Pipeline)

---

#### Pitfall B1: AI Generation API Rate Limits Break Batch Runs Mid-Catalog

**What goes wrong:** Running AI generation for 100 products × 3 color variants × 2 views (back,
side) = 600 generation requests. fal.ai and Replicate default to 10 concurrent tasks per account.
Submitting all 600 at once causes 429 errors mid-batch. Some products get generated images,
others do not. The run log has no checkpoint, so a restart regenerates already-completed work.

**Prevention:**
1. Use p-queue (already in the project) with concurrency `<= 8` for generation API calls.
2. Write a checkpoint file after each successful generation (product ID + view type + output URL).
3. On restart, skip products/views already in the checkpoint.
4. Implement exponential backoff with jitter on 429 responses (start 2s, max 60s).
5. Prefer async/webhook mode over polling for long-running generation models.

**Phase:** AI generation phase.

**Confidence:** HIGH — fal.ai rate limits (10 concurrent tasks default) confirmed in official FAQ.

---

#### Pitfall B2: Google Sheets Write-Back Race Condition on Image Status

**What goes wrong:** The image pipeline writes `image_status` and `image_source` columns back to
the Google Sheet per-product as each product completes. Running multiple pipeline workers
concurrently causes write collisions — one worker's `batchUpdate` overwrites another's changes
because both workers read the sheet state at the same time.

**Why it happens:** Google Sheets has no row-level locking. Concurrent `batchUpdate` calls for
different rows succeed, but sequential reads + writes introduce a TOCTOU window.

**Prevention:**
1. Use a single-threaded write-back worker: collect all status updates in memory during the run,
   flush to Sheets as one `batchUpdate` at the end (already how v1.0 handles enrichment).
2. Never interleave parallel read-modify-write cycles on the same sheet.
3. Limit Google Sheets write calls to 1 per second per spreadsheet (Sheets API quota).

**Phase:** Status tracking / sheet write-back in the image audit or replacement phase.

**Confidence:** HIGH — Google Sheets API docs explicitly document 1 write/sec limit and known TOCTOU
race condition.

---

#### Pitfall B3: Generated Image Passes Quality Check but Fails Garment Detection

**What goes wrong:** A generated back-view image passes the blur/resolution quality scorer but
contains artifacts that confuse `sharp.trim()` — for example, a faint garment shadow on a
near-white background, or a seam highlight pixel that extends to the canvas edge. `detectGarmentBounds`
either trims too aggressively (90%+ of pixels removed, fallback triggered) or not at all (garment
treated as full 2000×2000).

**Why it happens:** Supplier photographs are captured under controlled studio lighting, producing
predictable trim behavior. AI-generated images use random lighting — subtle gradients and shadow
edges break the white-background assumption that `sharp.trim({ background: '#ffffff', threshold: 10 })`
depends on.

**Prevention:**
1. After generating an image, run `detectGarmentBounds` before accepting it. Check: trimmed area
   is 20–85% of original (garment exists, but background is not the whole image).
2. If trim fallback triggers, reject the generation as unusable and request a new candidate.
3. Consider widening the trim threshold for generated images: test `threshold: 20` on generated
   output vs `threshold: 10` for supplier originals.
4. In the generation prompt, explicitly request "pure white background, no shadows, no gradient."

**Phase:** AI generation phase — post-generation validation step, before standardize-and-upload.

**Confidence:** MEDIUM — sharp.trim behavior on AI-generated images is extrapolated from known
trim fallback logic in the existing codebase. Requires empirical testing.

---

#### Pitfall B4: OrderMyGear API Scope and Terms Misunderstood

**What goes wrong:** The OrderMyGear API is a distributor-to-platform B2B interface, not a public
product image catalog. It is scoped to products the account has transacted with or has active
catalog access for. Attempting to use it as a general supplier image source for all Canada
Sportswear styles will return sparse results or unauthorized errors for styles not in the account's
catalog access.

**Why it happens:** OrderMyGear positions as a supply chain integration platform. Their API Terms
of Use explicitly state the license is "solely for creating a software interface between an
authorized client's systems and OrderMyGear's systems" — not for bulk image harvesting.

**Consequences:** Build an image sourcing step against OrderMyGear assuming full catalog coverage,
discover in production that 70% of products return 404 or empty results, fall back to scraping
which then hits the hotlink problems in Pitfall A5.

**Prevention:**
1. Before building the OrderMyGear sourcing step, confirm which specific product styles the account
   has API access to. Get a sample response for 10 known CSW styles.
2. Design the sourcing step to treat OrderMyGear as one optional source in a fallback chain:
   OrderMyGear → Canada Sportswear scrape → existing sheet URL → AI generation.
3. Never assume OrderMyGear is the primary source.

**Phase:** Image sourcing phase — sourcing strategy design.

**Confidence:** MEDIUM — OrderMyGear API Terms of Use read directly. Catalog access scope is
inference based on B2B API norms; needs verification against actual account access.

---

#### Pitfall B5: Batch Image Replacement Breaks Print Area Metaobject Media References

**What goes wrong:** Print Area metaobjects store a `media` field that references the product's
front image GID (the Shopify file GID assigned after staged upload). When the front image is
replaced, the old GID is invalidated. The metaobject still holds the old GID — the builder
wizard shows a broken image in the print area overlay.

**Why it happens:** In v1.0, `derivePrintAreaCoords` computes coordinates from the front image's
garment placement, and `productSet` sets the Print Area metaobject's `coords` fields. But the
`media` reference (if used) is a file GID, not a stable URL.

**Prevention:**
1. After replacing a product's front image, immediately update the Print Area metaobject's
   `media` field with the new file GID via `metaobjectUpdate`.
2. Include the metaobject update in the same pipeline transaction as the image replacement —
   never let the two get out of sync.
3. In the image audit step, verify Print Area metaobject `media` GIDs resolve to existing files.

**Phase:** Image replacement phase and Print Area integration.

**Confidence:** MEDIUM — follows directly from v1.0 metaobject implementation patterns and Shopify
GID lifecycle behavior. Needs explicit confirmation that the `media` field is populated in the
current implementation.

---

### Minor Pitfalls (Image Pipeline)

---

#### Pitfall C1: PNG Size Blowout from AI-Generated Images

**What goes wrong:** AI-generated images at 2000×2000 in PNG format can be 8–15 MB each.
Shopify's `stagedUploadsCreate` supports up to 20 MB, but uploading 15 MB files for hundreds of
products is slow and uses significant Shopify file storage quota.

**Prevention:** Convert generated images to PNG with sharp's `compressionLevel: 9` or use JPEG
at quality 92 for non-background views (back, side). Check Shopify's file storage quota before
running large batches.

---

#### Pitfall C2: Aspect Ratio Mismatch Between Generated and Supplier Images

**What goes wrong:** Supplier front images may be portrait (3:4) while the AI generation API
defaults to square (1:1). After standardization to 2000×2000, the proportions diverge. Side-by-
side color swatches on the storefront look inconsistent.

**Prevention:** Always set the AI generation target dimensions to 2000×2000 explicitly. In the
generation prompt, specify "square format, garment centered" to reinforce this constraint.

---

#### Pitfall C3: Concurrent Supplier Scraping Triggers IP Block

**What goes wrong:** Fetching images for 100+ products in parallel from Canada Sportswear's CDN
within seconds triggers rate limiting or temporary IP block.

**Prevention:** Add a minimum 500ms delay between image fetches from the same domain. Use p-queue
with concurrency 3 for the scraping/download step.

---

## Original v1.0 Pitfalls (Preserved)

---

### Critical Pitfalls

#### Pitfall 1: Scraping S&S Canada Website Instead of Using Their API
**What goes wrong:** S&S Activewear filed a lawsuit in September 2025 under the Computer Fraud and
Abuse Act against PromoHunt for scraping their website. They actively protect against unauthorized
data access.
**Why it happens:** Developers default to scraping without checking for official APIs. S&S's website
requires login, tempting automated login flows.
**Consequences:** Legal action. Account termination. Loss of supplier relationship.
**Prevention:** Use the official S&S Activewear REST API at `api.ssactivewear.com/V2/`. Requires
account number + API key (available in account settings). Returns JSON with products, pricing,
inventory, images.
**Detection:** Any code that fetches `ssactivewear.com` or `en-ca.ssactivewear.com` HTML pages
is wrong.

#### Pitfall 2: `productSet` Mutation Silently Deletes Omitted Variants
**What goes wrong:** The `productSet` GraphQL mutation treats list fields (variants, metafields) as
**replace-not-merge**. Send 3 of 98 variants, and the other 95 are deleted. Same for metafields.
**Why it happens:** Developers assume `productSet` works like a PATCH. It does for scalar fields
(title, description), but for lists it replaces the entire set.
**Consequences:** Products lose variants and metafields on re-run. Print Area references vanish.
Store products become broken.
**Prevention:** Always fetch current product state before calling `productSet`. Include ALL existing
variants and metafields in the mutation, plus any changes.
**Detection:** Products losing variants after script re-runs. Metafields disappearing.

#### Pitfall 3: Using REST API for Products (Deprecated)
**What goes wrong:** Building on Shopify REST Admin API for product operations. REST is deprecated
for products (API 2024-04+) and limited to 100 variants per product.
**Why it happens:** Most tutorials still reference REST.
**Consequences:** Hit 100-variant hard cap. Must rewrite entire push pipeline to GraphQL.
**Prevention:** Use GraphQL Admin API exclusively.
**Detection:** Imports of REST product endpoint URLs. 100-variant limit errors.

#### Pitfall 4: Shopify Rate Limit Exhaustion (429 Errors)
**What goes wrong:** Creating 100+ products without throttling. Each `productSet` costs ~10 points.
50 pts/sec budget = ~5 products/sec max.
**Prevention:** Use p-queue with concurrency limits (2-3 concurrent mutations max). Retry with backoff on 429.

---

### Moderate Pitfalls (v1.0)

#### Pitfall 1: Google Sheets API Quota Exhaustion
**Prevention:** Batch reads/writes. Load all rows at start, process in memory, write in batches.

#### Pitfall 2: Canada Sportswear JSON Endpoint Missing Data
**Prevention:** Two-step extraction: JSON first, HTML scraping second. Validate required fields.

#### Pitfall 3: Metaobject Reference Integrity
**Prevention:** Use metaobject `handle` fields for stable identification. Never delete and recreate
in production — update in place.

#### Pitfall 4: Flat Sheet to Hierarchical Product Mismatch
**Prevention:** Build explicit grouping logic by style number → color → size.

#### Pitfall 5: Image URL Instability
**Prevention:** Download images and upload to Shopify CDN. Never reference external URLs in final
products.

#### Pitfall 6: Daily Variant Creation Throttle (Post-50K)
**Prevention:** Calculate total variant count before bulk import. Build resumable pipeline.

---

### Minor Pitfalls (v1.0)

#### Pitfall 1: Character Encoding (French Content)
**Prevention:** Ensure UTF-8 throughout. Test with French product names early.

#### Pitfall 2: Price Rounding
**Prevention:** All pricing math in cents (integers). Round at final step.

#### Pitfall 3: Shopify API Version Deprecation
**Prevention:** Use recent stable version (2025-01+). Set reminder to update annually.

#### Pitfall 4: Sheet Schema Drift
**Prevention:** Validate sheet schema at script start (check column headers).

---

## Phase-Specific Warnings

### v2.0 Image Automation Phases

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Image audit / quality scoring | BRISQUE/NIQE false rejects on white-background images | Crop to garment before scoring; calibrate thresholds on 50 known-good/bad samples |
| Image audit / quality scoring | Blurry images passing scorer | Use Laplacian variance on trimmed garment region, not full canvas |
| Image sourcing (OMG API) | OrderMyGear doesn't cover full catalog | Treat as optional source; design fallback chain to CSW scrape → sheet URL → AI gen |
| Image sourcing (scraping) | CDN hotlink blocks / signed URL expiry | Validate buffer magic bytes; set browser-like headers; cache downloads |
| Image sourcing (scraping) | Concurrent fetches triggering IP rate limit | p-queue concurrency 3 with 500ms delay between same-domain requests |
| AI generation | Color/proportion drift between views | Color distance check against front image; reject if hue drift >15 degrees |
| AI generation | Generated image breaks sharp.trim() | Run detectGarmentBounds on output before accepting; reject if trim fallback triggers |
| AI generation | API rate limits killing batch run | p-queue concurrency <=8; checkpoint after each success; exponential backoff on 429 |
| AI generation | Single bad candidate auto-accepted | Generate 3 candidates per view; score all three; accept highest scorer |
| Image replacement (Shopify) | productSet deletes existing images | Fetch existing GIDs; merge with new resourceUrls before productSet call |
| Image replacement (Shopify) | Orphaned staged upload files | Track resourceUrl per run; cleanup unattached files with fileDelete |
| Image replacement (Shopify) | Print Area metaobject media GID broken | Update metaobject media field immediately after replacing front image |
| Status write-back | Google Sheets write race condition | Single write-back at end of run, not per-product; 1 write/sec limit |
| Status write-back | Sheet schema drift | Validate image_status and image_source column headers before writing |

### v1.0 Phases (Preserved)

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Project setup | API token in source code | `.env` file + `.gitignore`. Minimum scopes: `write_products`, `read_products`, `write_files` |
| Supplier extraction | S&S scraping legal risk | Use official API, never scrape website |
| Supplier extraction | Canada Sportswear JSON data gaps | Two-step: JSON + HTML parsing |
| Supplier extraction | Scraper breaks on HTML changes | Validation gate on scraped data, reject empty required fields |
| Sheet enrichment | Google Sheets quota exhaustion | Batch reads/writes, not per-cell saves |
| Sheet enrichment | Schema drift from manual edits | Validate headers at script start |
| Decoration rules | Rule complexity explosion | Start category-based, add per-product overrides later |
| Pricing | Floating point errors | Integer math in cents |
| Shopify push | Rate limit exhaustion | p-queue with concurrency limits |
| Shopify push | `productSet` deletes omitted variants | Always send complete variant+metafield list |
| Shopify push | Metaobject ordering | Create metaobjects BEFORE products reference them |
| Shopify push | Duplicate creation on re-run | Idempotent push via handle matching |
| Scale (100+) | Variant daily creation limit | Check store variant count, plan multi-day if >50K |

---

## Sources

### v2.0 Research Sources

- [Shopify productSet mutation — list field replace behavior](https://shopify.dev/docs/api/admin-graphql/2025-01/mutations/productSet) — HIGH confidence
- [productSet and files — community forum thread confirming image deletion on re-run](https://community.shopify.dev/t/question-productset-and-files-to-create-update-products/10334) — HIGH confidence
- [BRISQUE/NIQE limitations on non-natural images — Springer Multimedia Systems](https://link.springer.com/article/10.1007/s00530-025-02009-8) — MEDIUM confidence
- [AI-generated apparel color/proportion drift across views — Orbitvu 2026](https://orbitvu.com/blog/generative-ai-vs-reality-how-do-virtual-try-ons-compare-real-model-content/) — MEDIUM confidence
- [AI artifact characterization in diffusion models — CHI 2025](https://dl.acm.org/doi/full/10.1145/3706598.3713962) — MEDIUM confidence
- [Fashion industry AI image problems — Medium/Nitin Kumar Jan 2026](https://medium.com/fashion-tek-geek/fashion-industry-the-ai-generated-image-problem-2b5047bb1ed9) — MEDIUM confidence
- [fal.ai rate limits and batch processing — official FAQ and guide](https://docs.fal.ai/model-apis/faq) — HIGH confidence
- [Google Sheets API rate limits and TOCTOU](https://developers.google.com/workspace/sheets/api/troubleshoot-api-errors) — HIGH confidence
- [Hotlink protection and CDN image scraping challenges](https://developers.cloudflare.com/waf/tools/scrape-shield/hotlink-protection/) — HIGH confidence
- [OrderMyGear API Terms of Use](https://www.ordermygear.com/api-license-and-terms-of-use/) — HIGH confidence

### v1.0 Sources (Preserved)

- [S&S Activewear lawsuit](https://members.asicentral.com/news/industry-news/september-2025/ss-activewear-files-lawsuit-accuses-promohunt-of-illegally-accessing-data/) — HIGH confidence
- [Shopify productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet) — HIGH confidence
- [Shopify API rate limits](https://shopify.dev/docs/api/usage/limits) — HIGH confidence
- [Shopify REST deprecation](https://shopify.dev/changelog/deprecation-timelines-related-to-new-graphql-product-apis) — HIGH confidence
- [Google Sheets API limits](https://developers.google.com/workspace/sheets/api/limits) — HIGH confidence
- [Shopify metaobject docs](https://shopify.dev/docs/apps/build/custom-data/metaobjects/manage-metaobjects) — HIGH confidence
- Canada Sportswear site analysis — confirmed Shopify platform (HIGH confidence)

---
*Pitfalls research for: Fortee Catalog Engine*
*v1.0 researched: 2026-03-05 | v2.0 image automation added: 2026-03-26*
