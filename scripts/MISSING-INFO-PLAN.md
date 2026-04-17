# Missing-Info Fill Plan

**Status:** S1+S2+S3 shipped — paused before any real AI spend pending budget decision.
**Last updated:** 2026-04-17
**Source tab:** `Bestsellers-Ready` / `Missing-Info` in main sheet `1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs`.

---

## Where we are

### Shipped (committed)

| Component | Commit | What it does |
|---|---|---|
| **S1** `scripts/scrape-csw-product.ts` | `3140b6d` | CSW Shopify scraper (handle, description, productType, tags, gender, sizeChartUrl). Plain `fetch`, no Playwright. Validated 6/6 on real missing-info styles. |
| **S2** `src/lib/ai-model-image.ts` | `147bd4d` | `generateModelImage(front, gender)` using gpt-image-1 images.edit + Vision-described garment. Smoke-tested on real CSW polo: $0.126/gen, photorealistic output. |
| **S3** `scripts/fill-missing-info.ts` | `3a61ace` | Orchestrator. Reads both tabs, dedupes by (productId, colorName), dispatches CSW scrape + AI gen. Persists generated images to `tmp/generated/`. Flags: `--dry-run --style-id --limit --only csw\|images --no-model --budget`. |

### Not yet built

- **S4 — Drive upload pass.** S3 saves AI images to `tmp/generated/{pid}__{color}__{view}.png` but does **not** upload them to Drive or write the resulting URL into Bestsellers-Ready. A small follow-up script needs to:
  1. Walk `tmp/generated/`, parse filenames into `(pid, color, view)`.
  2. Upload each PNG to the per-product Drive folder (use `product drive link` from Missing-Info, or create one).
  3. Write the public Drive URL to all matching size rows in Bestsellers-Ready (BackImage / DirectSideImage / ModelFrontImage).
  4. Recount Missing-Info per-product gaps and update the "MISSING (N)" markers.
- **S5 — Standardize generated images.** After Drive upload, run `scripts/standardize-bestsellers.ts` (existing) to normalize generated images to 2000x2000 white canvas.

---

## Cost reality check (full dry-run, 2026-04-17)

Original estimate was ~$24. Actual is **~$141** — model gen blew it up because there are far more colors per product than the Missing-Info aggregate suggested.

| Pipeline | Count | Cost ($0.126 / gen) |
|---|---|---|
| CSW scrapes | 159 | $0 (free) |
| Back gen | 51 colors | $6.43 |
| Side gen | 295 colors | $37.17 |
| Model gen | 773 colors | **$97.40** |
| Skipped (no front image) | 80 colors | — |
| **Total** | | **~$141** |

The agreed-on ceiling was $70. **Default `--budget` in S3 is $50.**

### Recommended phased rollout

1. **`--only csw`** — $0, fills description/category/sizechart for ~159 products. Risk-free.
2. **`--no-model --budget 50`** — fills back+side ($44 estimated). Stays under default budget.
3. **Model gen separately** — needs explicit budget bump (e.g. `--only images --budget 100`) AND a decision: do we generate model images for *every* color, or only the primary one per product?
4. **Build S4 Drive upload** before any of the above actually moves the needle on the sheet — otherwise generated images sit on disk and the Missing-Info markers don't change.

---

## Research findings (kept for future-me)

### CSW scraping — plain fetch, no Playwright
- Site is public Shopify, no bot blocking, no captcha.
- Search: `GET /search/suggest.json?q={STYLE}&resources[type]=product&resources[limit]=10` → returns `handle`, `title`, `tags`.
- Product JSON: `GET /products/{handle}.json` → `body_html`, `product_type`, `tags`. **Does NOT contain size-chart PDF URL.**
- Size chart PDF: parse from HTML page `/products/{handle}` with regex `href="(https://cdn\.shopify\.com/[^"]+SIZE_CHART[^"]+\.pdf[^"]*)"`.

### Gender inference — handle keywords are the truth source
- **L-prefix is NOT Ladies** — it's CSW's "Lightweight" line. E.g., `L07240` → `cadet-mens-lightweight-softshell`. Validated: my initial L-prefix-→women rule was wrong on 2/5 sample styles.
- Priority: tags array > handle keywords (`-ladies-`, `-mens-`, `-womens-`, `-youth-`, `-unisex-`) > Y-suffix → youth > default unisex.

### AI generation — already-built `generateGarmentView` reused as-is
- `src/lib/ai-image-generator.ts::generateGarmentView()` does back/side from front with hue verification, retry, candidate selection. Reused unchanged in S3.
- Model gen needed its own function (`src/lib/ai-model-image.ts`) — on-model selection skips the hue check and the garment-on-white quality scorer (which would misjudge a photo with skin tones and varied background detail).

### Schema gotchas
- Missing-Info tab is **per-product** (192 rows), with "MISSING (N)" markers showing missing-color *count* per view.
- Bestsellers-Ready is **per (product, color, size)** — 24,313 rows. Back/side/model images are color-level, so dedup by `(productId, colorName)` before generation. Without dedup, we'd burn ~6× per color (one gen per size).
- Many missing-info products are zero-data stubs (1 BR row, no colorName, no front image) — they need *initial sourcing*, not AI gen. S3 logs and skips them.

---

## Pickup checklist

When resuming:
1. Decide budget posture (CSW-only first? back+side? model gen?).
2. Build **S4 Drive upload pass** — without it, generations don't reach the sheet.
3. Run `--only csw` end-to-end — closest to a real production run, $0 risk.
4. Then `--no-model --limit 10` to validate the AI+upload chain on 10 products before scaling.
