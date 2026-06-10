# Phase 19: AI Category & Keyword Generation - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning
**Source:** Operator decisions (this session) + v3.0 research + codebase inspection

<domain>
## Phase Boundary

Generate consumer-facing categories and keywords for every product in Bestsellers-Ready (BR) using Claude, in ONE structured call per product (~291 unique productIds, fanned out to all 24,175 variant rows).

In scope:
- Refine `baseCategory` to a decoration-SAFE controlled value (per product).
- Fill the display-only `categories` column with a consumer-friendly Shopify Standard Product Taxonomy leaf path (per product).
- Generate `keywords` (consumer-style tags) per product.
- Per-product checkpoint/resume; idempotent; dry-run-first then --apply.

Out of scope:
- Pushing anything to Shopify (categories/tags wiring into product-push is deferred v2/PUSH).
- Per-variant (color/size) AI calls — categories/keywords are product-level.
- Touching image columns (Phase 18 owns those).
</domain>

<decisions>
## Implementation Decisions

### Model + SDK
- **D-01** Model: `claude-haiku-4-5` via `@anthropic-ai/sdk`. (NOT OpenAI — chosen to bypass the recurring OpenAI monthly usage-cap blocker; different provider/billing.)
- **D-02** Structured output via `client.messages.parse()` with `output_config: { format: zodOutputFormat(schema) }` (Haiku 4.5 supports structured outputs). Do NOT set `effort` (Haiku errors on it). No thinking budget.
- **D-03** One combined call per product returns `{ baseCategory, categoriesPath, keywords[] }`. ~291 calls. Synchronous with bounded concurrency is fine (cheap); Batches API NOT used (adds latency, negligible savings on ~291 calls).
- **D-04** Prefix all SDK-invoking commands with `NODE_OPTIONS=--use-system-ca` (AV TLS interception on this machine).

### baseCategory (decoration-CRITICAL — must not break product push)
- **D-05** `baseCategory` feeds `getCategoryGroup()` (src/shopify/variants.ts) → print-area placement, Shopify taxonomy, template. If `getCategoryGroup()` returns null, `product-push.ts:104` THROWS. Therefore the AI's `baseCategory` output MUST be schema-constrained to a closed enum of values that `getCategoryGroup()` resolves to non-null.
- **D-06** Build the enum from the existing recognized set: the 8 `SUPPORTED_CATEGORIES` strings (T-Shirts - Premium/Core/Long Sleeve, T-shirts/Shorts/Polos, Fleece - Premium/Core - Hood/Crew) PLUS substring-valid garment values for the other groups (e.g. a value containing "Polo" → polos, "Jacket"/"Vest"/"Wind"/"Outerwear" → jackets, "Hood" → hoodies, "Crew"+"Fleece" → crewnecks, "Tee"/"Tank"/"Long Sleeve" → tops). The planner must verify every enum member against `getCategoryGroup()` and include a unit test asserting non-null for each.
- **D-07** NEVER write a baseCategory that resolves to null. If the model can't confidently pick a safe value for a product, LEAVE the existing baseCategory unchanged and log it (never blank, never guess).

### categories (display-only — safe)
- **D-08** `categories` (BR col 31) is written by suppliers and read by NOTHING downstream (confirmed). Safe to fill with a consumer-friendly Shopify Standard Product Taxonomy LEAF path (e.g. `Apparel & Accessories > Clothing > Shirts & Tops > T-Shirts`). Always resolve to a leaf, never a free-form string.

### keywords (read by title-builder)
- **D-09** `keywords` (BR col 30) IS read by `src/lib/title-builder.ts` `isYouth()` for audience detection. Generated keywords MUST preserve the audience signal (include the audience term for youth/kids/toddler/women/men products) so titles don't regress.
- **D-10** Keyword rules: lowercase-hyphenated, ≤15 per product, consumer-style search terms drawn from audience/garment-type/material/fit/use-case. EXCLUDE color names, size names, style numbers, GSM values, and wholesale/B2B jargon. Customers are small businesses that shop like consumers ([[feedback_customers_smb_as_consumers]]).

### Write mechanics + safety
- **D-11** Join + fan-out on `productId` (NOT styleID). Read once per productId, write the same 3 values to ALL of that product's variant rows.
- **D-12** Use raw `values.get` header-index maps + `src/sheets/writer.ts` `writeUpdates` (chunked). Do NOT use `readAllRows` (drops columns not in SHEET_COLUMNS).
- **D-13** Per-product checkpoint file so an interrupt/crash resumes without re-calling Claude or re-writing completed products (OPS-01). Idempotent: skip products whose target cells are already filled (OPS-02).
- **D-14** Dry-run-first (default): emit a per-product preview (proposed baseCategory/categories/keywords + a flag when baseCategory would change) and write nothing. `--apply` writes; back up the affected columns first.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Category system (decoration contract)
- `src/shopify/variants.ts` — `getCategoryGroup()`, `SUPPORTED_CATEGORIES` (the decoration-safe baseCategory gate).
- `src/shopify/product-push.ts` (~line 104) — throws on unsupported category (why D-05/D-06/D-07 matter).
- `src/decoration/category-map.ts` — `CATEGORY_ALIASES`/`resolveCategory` (NOTE: dead path in current push — informational only).

### Keyword consumer
- `src/lib/title-builder.ts` (~line 57) — `isYouth()` reads `keywords` (why D-09 matters).

### Write plumbing (reuse)
- `src/sheets/client.ts`, `src/sheets/writer.ts` (`writeUpdates` chunking), `scripts/write-model-urls.ts` (productId join + header-reread pattern), `scripts/link-br-images.ts` (Phase 18 — checkpoint/dry-run/backup patterns to mirror).

### Claude integration
- `@anthropic-ai/sdk` (NOT yet installed — add it). Model `claude-haiku-4-5`. Structured output: `client.messages.parse()` + `zodOutputFormat` (`@anthropic-ai/sdk/helpers/zod`). zod already in deps.

### Research
- `.planning/research/SUMMARY.md`, `FEATURES.md` (taxonomy + tag rules), `PITFALLS.md` (schema-constrain to enum, keyword stuffing, checkpoint).
</canonical_refs>

<specifics>
## Prerequisites (BLOCK execution, not planning)
- **P-1** `npm install @anthropic-ai/sdk` (zod already present).
- **P-2** Add `ANTHROPIC_API_KEY` to `.env` — OPERATOR-PROVIDED secret. Execution cannot run without it. (This replaces the OpenAI-cap blocker; OpenAI is not used in this phase.)
</specifics>

<deferred>
## Deferred Ideas
- Wiring the taxonomy categoryId + tags into the Shopify push (v2/PUSH-01, PUSH-02).
- Re-pulling categories from supplier APIs (not chosen; AI inference chosen instead).
</deferred>

---

*Phase: 19-ai-category-keyword-generation*
*Context gathered: 2026-06-10*
