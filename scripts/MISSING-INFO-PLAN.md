# Missing-Info Fill Plan

Status: research complete, awaiting approval to implement.
Date: 2026-04-17
Source tab: `Bestsellers-Ready` / `Missing-Info` in main sheet `1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs`.

## Gaps to fill (197 products)

| Gap | Count | Strategy |
|---|---|---|
| Back images | 105 | AI generate from front |
| Side images | 44 | AI generate from front |
| Model images | 170 | AI generate from front (gender-aware), skip caps/bags |
| Size charts | 165 | CSW Shopify scrape |
| Categories | 45 | CSW Shopify scrape |
| Descriptions | 12 | CSW scrape, fall back to OpenAI rewrite |
| Cost prices | — | **Deferred — out of scope** |

## Research findings

### CSW scraping — plain `fetch`, no Playwright
- Site is public Shopify, no bot blocking, no captcha.
- **Search by style code:** `GET https://www.canadasportswear.com/search/suggest.json?q={STYLE}&resources[type]=product&resources[limit]=5` → returns `handle`, `title`, `tags`, `image`.
- **Product JSON (description, category):** `GET https://www.canadasportswear.com/products/{handle}.json` → has `body_html`, `product_type`, `tags`, `variants`. Does NOT contain size-chart PDF URL.
- **Size chart PDF URL:** must be parsed from the HTML page `https://www.canadasportswear.com/products/{handle}` — regex `href="(https://cdn\.shopify\.com/[^"]+SIZE_CHART[^"]+\.pdf[^"]*)"`.
- Verified live with style L00550 → handle `l0550-vault-adult-pullover-hooded-sweatshirt`, full description + product_type "Pullover Hoodie" + size chart PDF all retrieved.

### Gender inference (no extra column needed)
- `L`-prefix style → women (Ladies series)
- `Y`-suffix style → youth (skip model gen)
- All others → unisex/men (default to male model)
- Override via tags: if Shopify `tags` array contains `"Ladies"` → women, `"Mens"` → men, `"Youth"` → youth.

### AI generation — reuse what's built
- `src/lib/ai-image-generator.ts::generateGarmentView()` already does back/side from front with hue verification, retry, budget. **Reuse as-is.**
- **Model image generation is new.** Garment-on-model is a different output domain than garment-on-white — needs its own function `generateModelImage(frontBuffer, gender, garmentDescription)` with prompt:
  > "Generate a photorealistic product photoshoot on a {man|woman} model wearing this garment, plain white seamless studio background, garment as the main subject, neutral pose, full body or 3/4 framing, no props, no text, no watermark."
- Reuses Vision-based `describeGarment()` for the `{garmentDescription}` slot.
- Reuses cost tracker, candidate selection (n=3), retry-once pattern.

### Cost estimate
- Back/side: 149 generations × 3 candidates × $0.04 = **$18**
- Model: ~50 generations (170 minus caps/bags ~120) × 3 × $0.04 = **$6**
- Total: **~$24** — well under the $70 ceiling.

## Plan: 3 scripts + 1 orchestrator

### S1. `scripts/scrape-csw-product.ts`
Pure CSW scraping module (also exports a CLI for testing one style).
- `findHandle(styleCode)` → calls suggest.json, returns first matching handle (or null)
- `fetchProductJson(handle)` → returns `{ description, productType, tags }`
- `fetchSizeChartUrl(handle)` → fetches HTML, regex-extracts SIZE_CHART PDF URL
- `scrapeCSW(styleCode)` → composite: returns `{ handle, description, productType, tags, gender, sizeChartUrl }`
- Rate limit: 1 req/sec to be polite.

### S2. `src/lib/ai-model-image.ts` + tiny CLI wrapper
- New `generateModelImage(frontBuffer, gender, costTracker)` in src/lib/.
- Reuses `describeGarment()`, cost tracker, candidate selection from existing generator.
- Returns `{ imageBuffer, candidatesGenerated, costUsd } | null`.

### S3. `scripts/fill-missing-info.ts` — orchestrator
- Read Missing-Info tab.
- For each row, classify gaps:
  - Image gaps → dispatch to AI gen (skip model for caps/bags/youth)
  - Description/category/sizechart gaps → dispatch to CSW scrape
- Batch sheet writes (one update per 100 rows).
- Flags: `--dry-run`, `--style-id <code>` (single product), `--limit <n>`, `--only images|csw`.
- Logs to `scripts/.logs/fill-missing-info-{timestamp}.json` for replay/debug.

### Done = Missing-Info gaps drop from 197 → ~30 (residual: products with no CSW handle match, AI-rejected images).

## Open questions
- None — ready to implement S1.

## Order of work
1. **S1 first** (CSW scrape) — no AI cost, fail-fast on real product set. Run dry against 10 sample styles, eyeball output.
2. **S2** (model image gen) — small additive change to AI module.
3. **S3** orchestrator — wires both into the Missing-Info loop.
4. Run end-to-end with `--dry-run` then `--limit 5` then full.
