# Stack Research

**Domain:** TypeScript ESM catalog-automation — AI text classification + Drive→Sheets linking
**Researched:** 2026-06-09
**Confidence:** HIGH (AI pricing/model support verified via OpenAI community + third-party pricing trackers; Sheets/Drive limits verified against Google docs; Drive URL format cross-checked against Shopify community threads)

---

## No New Dependencies Required

All three v3.0 features can be built entirely with already-installed packages. Do not add anything to `package.json`.

| Already Installed | Used For |
|-------------------|----------|
| `openai@^6.33.0` | AI category inference + keyword generation (chat completions) |
| `googleapis@^171.4.0` | Drive `files.list` for the linker; Sheets `batchUpdate` for writes |
| `zod@^4.3.6` | Runtime validation of AI JSON responses |

---

## Recommended Stack Per Feature

### Feature 1 — Drive to BR Image Linker

**Approach:** Use existing `drive_v3.Drive` client (already in `src/sheets/drive.ts`) with `files.list` + `pageToken` pagination to enumerate all files under each `SUPPLIER/<pid>/` folder. Build a lookup map `pid → { role → fileId }` from filenames that match the `{Brand}-{pid}-{Color}-{Role}.png` convention, then construct `https://drive.google.com/uc?id=<fileId>` URLs and write them via the existing `writeUpdates()` in `src/sheets/writer.ts`.

**URL format:** Use `https://drive.google.com/uc?id=<fileId>` — this is already what `uploadToDrive()` returns and is already stored in BR for existing image columns. Do NOT use `webViewLink` (`/file/d/<id>/view`) for data cells; both resolve to the same file but `uc?id` is the shorter, stable form already established in this codebase.

**Shopify import note:** `uc?id` URLs are NOT directly consumable by Shopify's CSV import or `fileCreate` mutation — Google Drive serves them with a redirect and cookie wall, not a raw byte stream. The existing push pipeline downloads images via `downloadFromDrive()` (which uses the Drive API with service account auth, bypassing the public redirect) and uploads to Shopify via staged upload. That flow is unchanged. The BR cells store Drive URLs as a human-readable record and as the source for the push pipeline's download step — not as direct Shopify media URLs. This distinction is already established in v2.0 and requires no change.

**Rate limits for Drive enumeration:** Drive `files.list` quota is 12,000 requests/100 seconds. With ~291 products, one list call per pid folder = ~291 requests, trivially within quota. Use `pageSize: 1000` to minimize round trips per folder; paginate with `nextPageToken` for folders with many files. Wrap in the existing `withDriveRetry` for resilience.

### Feature 2 — AI Category Inference

**Model:** `gpt-4o-mini` (model ID: `gpt-4o-mini-2024-07-18` or the alias `gpt-4o-mini`).

**Why gpt-4o-mini and not gpt-4.1-nano or gpt-4.1-mini:**

gpt-4o-mini has confirmed, stable support for `response_format: { type: "json_schema", strict: true }` in the Chat Completions API. This is the structured outputs path.

gpt-4.1-nano ($0.05/$0.20 per 1M) and gpt-4.1-mini ($0.40/$1.60 per 1M) do NOT reliably support `response_format: json_schema` in the Chat Completions API as of June 2026. Community reports from April–May 2025 through mid-2026 show "Unsupported model" errors for `json_schema` response_format on gpt-4.1 variants, despite OpenAI's models page claiming support. The playground may work but the API does not — do not rely on it for production.

gpt-4o-mini ($0.15/$0.60 per 1M) is the cheapest model with verified, battle-tested structured output support. It is already used in the codebase in `describeGarment()` inside `src/lib/ai-image-generator.ts`.

**Structured outputs:** Use `response_format: { type: "json_schema", json_schema: { name: "categories", strict: true, schema: { ... } } }`. The `openai@6.x` package ships a `zodResponseFormat()` helper that converts a Zod schema directly to the required format — no extra package needed. This guarantees 100% schema compliance: no `JSON.parse` guessing, no repair loops.

**Do NOT use the Batch API for categories or keywords.** Reasons:

1. The Batch API has up to 24-hour latency. This is a ~291-product sync script run interactively by the operator, not a background pipeline. 24h wait is unacceptable.
2. At 291 products, the synchronous cost with gpt-4o-mini is negligible. Category inference prompt is approximately 300 tokens in and 80 tokens out per product. 291 products × 380 tokens × $0.00000038/token is roughly $0.04 total. The Batch API's 50% savings on $0.04 is $0.02 — not worth the file-based async workflow complexity.
3. The existing `CostTracker` pattern handles budget enforcement; no separate batching infrastructure needed.

**Concurrency:** Use `p-queue` — already available as a transitive dependency (used by `audit-runner`). Set concurrency to 10–15 for gpt-4o-mini; it has generous rate limits (10M TPM on Tier 1). 291 products at concurrency 15 completes in seconds.

**Validation:** Validate AI response with Zod before writing to the sheet. On schema mismatch, log and skip — do not throw. This is the same defensive pattern already used in the existing enrichment pipeline.

### Feature 3 — AI Keyword Generation

Same model and approach as category inference: `gpt-4o-mini` with structured outputs. Keywords should be generated in the same API call as categories — one combined prompt per product returns one response with both `categories` and `keywords` fields — to halve the number of API calls and halve the per-product latency.

**Input per product:** `productName`, `description`, `baseCategory`, `gender`, `fit`, `brandName` from BR — all already present. No image needed; this is pure text classification.

---

## Sheets Write Strategy at 24k-Row Scale

The existing `writeUpdates()` in `src/sheets/writer.ts` already handles this correctly:

- Chunks at `BATCH_SIZE = 50,000` cells per `batchUpdate` call. Google recommends staying under 2 MB payload per request; 50k cells of short URL strings comfortably fits.
- Each `batchUpdate` call counts as one API request regardless of how many `data` ranges are included — this is the key advantage of batching.
- Write quota is 300 write requests per minute per project. At ~291 products with all image URL writes in a single `batchUpdate`, this is 1–2 API calls total for the Drive linker — well within quota.
- For AI writes (categories + keywords), also collect all `EnrichmentUpdate` objects in memory after all AI calls complete, then call `writeUpdates()` once.

Do NOT write row-by-row. The existing writer already enforces batching. New scripts only need to build the `EnrichmentUpdate[]` array and pass it to `writeUpdates()`.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| AI model | `gpt-4o-mini` | `gpt-4.1-nano` ($0.05/$0.20/1M) | Cheaper but `response_format: json_schema` broken in Chat Completions API as of mid-2026; adds unreliable workaround complexity |
| AI model | `gpt-4o-mini` | `gpt-4.1-mini` ($0.40/$1.60/1M) | More expensive than gpt-4o-mini AND same json_schema support issues |
| AI model | `gpt-4o-mini` | `gpt-4o` ($2.50/$10.00/1M) | 16x more expensive for classification tasks gpt-4o-mini handles equally well |
| AI response parsing | Structured outputs + Zod | `json_object` mode + manual parse | `json_object` mode does not guarantee field presence or types; `strict: true` gives 100% schema compliance |
| AI throughput | Sync + p-queue | Batch API (50% cost discount) | 24h latency; negligible cost savings at 291 products ($0.02 saved) |
| Drive URL in BR | `uc?id=<fileId>` | `webViewLink` (`/file/d/<id>/view`) | `webViewLink` requires sign-in for some viewers; `uc?id` is the established convention already in this codebase |
| Sheets write | Single batched `batchUpdate` | Row-by-row `values.update` | Row-by-row hits 300 req/min quota instantly at 24k rows; batching is already implemented |

---

## What NOT to Add

| Do Not Add | Why |
|------------|-----|
| `zod-to-json-schema` | `openai@6.x` ships `zodResponseFormat()` helper that converts Zod schemas directly; no extra package needed |
| `p-queue` (explicit install) | Already available as a transitive dependency; import directly, do not add to package.json unless `tsc` cannot resolve it |
| Anthropic SDK | OpenAI is already integrated, CostTracker is wired to it, and gpt-4o-mini is cheaper than Claude Haiku for this volume |
| `axios` or `node-fetch` | Drive downloads handled by `downloadFromDrive()` in `src/sheets/drive.ts` using googleapis SDK + service account auth |
| Any spreadsheet parsing library | All Sheets I/O goes through the googleapis Sheets client, not file exports |
| OpenAI Assistants API or Threads | Stateful infrastructure for a stateless batch classification task; adds complexity with no benefit |
| Fine-tuned model | Not warranted at 291 products; gpt-4o-mini + well-crafted prompt outperforms a fine-tune that would cost more to train than the total inference cost |
| OpenAI Batch API | 24h latency for an interactive operator script; total cost savings at this volume is under $0.05 |

---

## Cost Estimate (For Budget Cap Configuration)

| Task | Model | Approx tokens/product | Products | Total tokens | Estimated cost |
|------|-------|----------------------|----------|--------------|----------------|
| Category + keyword combined | gpt-4o-mini | ~500 in / ~150 out | 291 | ~190K total | ~$0.12 |
| Drive linker | no AI | — | 291 | — | $0.00 |

Raise the `CostTracker` budget cap to $5 for the v3.0 AI script. Actual spend will be approximately $0.12 but $5 gives headroom for retries and prompt iteration during development without hitting a budget wall.

---

## Sources

- [OpenAI structured outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) — confirmed gpt-4o-mini support for `response_format: json_schema`
- [OpenAI community: gpt-4.1 structured output support clarity](https://community.openai.com/t/clarity-on-gpt-4-1-and-o4-mini-structured-output-support/1230973) — json_schema broken on gpt-4.1 variants in Chat Completions API
- [OpenAI community: gpt-4.1-mini json_schema bug report](https://community.openai.com/t/structured-output-via-json-schema-response-format-for-gpt4-1-mini/1284907) — independent confirmation of gpt-4.1-mini issue
- [pricepertoken.com OpenAI models](https://pricepertoken.com/pricing-page/provider/openai) — gpt-4.1-nano $0.05/$0.20, gpt-4.1-mini $0.40/$1.60, gpt-4o-mini $0.15/$0.60 per 1M tokens (verified June 2026)
- [OpenAI Batch API guide](https://developers.openai.com/api/docs/guides/batch) — 50% cost discount, up to 24h SLA
- [Google Sheets API limits](https://developers.google.com/workspace/sheets/api/limits) — 300 read + write req/min/project, 2 MB recommended max payload
- [Shopify community: Google Drive URL CSV import](https://community.shopify.com/c/technical-q-a/uploading-product-images-via-csv-with-google-drive-url-s/td-p/1566884) — confirmed uc?id redirect limitation for direct Shopify import

---
*Stack research for: Fortee Catalog Engine v3.0 — Catalog Data Completion*
*Researched: 2026-06-09*
