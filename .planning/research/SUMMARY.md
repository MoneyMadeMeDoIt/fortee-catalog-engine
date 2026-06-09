# Project Research Summary

**Project:** Fortee Catalog Engine v3.0 Catalog Data Completion
**Domain:** TypeScript ESM catalog automation - Drive to Sheets image linking + AI text classification
**Researched:** 2026-06-09
**Confidence:** HIGH

## Executive Summary

v3.0 is a three-feature data completion milestone with a clear build order dictated by dependencies. The Drive-to-BR image linker is deterministic, requires no AI, and is unblocked today - the v2.0 finalize run completed all 452 pid folders at canonical {Brand}-{pid}-{Color}-{Role}.png naming. It ships first. The AI category/keyword pass requires the OpenAI monthly usage cap to be raised before running; it is the only external dependency. All three features reuse existing infrastructure entirely - no new dependencies, no new shared modules, only three new scripts entry points.

The recommended approach is one combined structured-output gpt-4o-mini call per unique productId (~291 calls total) returning baseCategory + taxonomyPath + keywords[] in a single round-trip. This halves API calls compared to separate scripts, normalizes baseCategory to a 15-value controlled vocabulary, fills categories with the Shopify Standard Taxonomy leaf-node path, and generates 10-15 consumer-voice tag tokens for keywords. Everything fans out to all BR rows sharing that productId - never per-row. Total AI cost is approximately 12 cents; raise the CostTracker cap to 5 dollars for headroom.

The top risks are on the image linker: wrong-color image assignment via loose color normalization, hyphenated brand names leaking into extracted color tokens (the exact Q-Tees bug from the finalize parser), and silently overwriting existing valid links when Drive has no file for a given color. Mitigate with a mandatory dry-run TSV review before --apply, a pre-overwrite BR backup, and a strict Drive-absent = no-op rule. For AI: schema-constrain outputs to the taxonomy enum, run at temperature 0, and write a per-product checkpoint so a monthly-cap 429 mid-batch does not re-spend tokens on already-complete products.

---

## Key Findings

### Recommended Stack

No new packages required. All three features run on already-installed dependencies: openai@^6.33.0 for structured-output chat completions, googleapis@^171.4.0 for Drive files.list and Sheets batchUpdate, and zod@^4.3.6 for AI response validation. The openai SDK ships zodResponseFormat() which converts Zod schemas directly to response_format: json_schema format - no extra package needed.

**Core technologies:**
- gpt-4o-mini: AI category + keyword inference - only cheap model with verified response_format: json_schema support as of mid-2026; gpt-4.1-nano and gpt-4.1-mini have broken json_schema in Chat Completions API despite docs claiming otherwise
- googleapis Drive v3 files.list: Drive folder enumeration - reused as-is; wrap in existing withDriveRetry; 291 list calls trivially within quota
- src/sheets/writer.ts writeUpdates(): all Sheets writes - 50k-cell chunked batchUpdate already implemented; do not write row-by-row
- src/lib/cost-tracker.ts CostTracker: AI budget enforcement - reused as-is; set cap to 5 dollars (actual spend ~12 cents)
- p-queue (transitive dep): AI call concurrency - set to 10-15 for gpt-4o-mini; no explicit install needed

### Expected Features

**Must have (table stakes):**
- Drive-to-BR image linker: overwrite FrontImage/BackImage/DirectSideImage + add 5 new columns (RightSideImage, ModelFrontImage, ModelSideImage, ModelBackImage; LeftSide maps to DirectSideImage); canonical filenames exist for all 452 pids
- AI baseCategory refinement: normalize supplier-scrape generic values (Tops, Sport Shirts) to 15-value controlled vocabulary; gates both taxonomy path and keyword garment-type bucket
- AI categories fill: Shopify Standard Taxonomy leaf-node path e.g. Apparel and Accessories > Clothing > Clothing Tops > T-Shirts; required for Shopify tax rules, Google/Meta feed exports, category metafields
- AI keywords fill: 10-15 lowercase-hyphen consumer tag tokens per product; consumed as Shopify product tags for automated collections and faceted filtering
- Style-level deduplication: group 24,175 BR rows by productId, run one AI call per group (~291 calls), fan output to all rows; per-row would be ~83x more expensive

**Should have (differentiators):**
- Consumer-voice keyword framing: explicit blocklist of wholesale jargon (GSM, bulk, PartID, style number) in system prompt; persona framed as consumer storefront not wholesale distributor
- Audience-aware taxonomy paths: use gender BR column as authoritative signal; Shopify taxonomy captures gender via target gender attribute, not separate category branch
- Occasion/use-case tags: AI-inferred from garment type + fit (corporate-gift, team-uniform, gym-wear) to match B-to-small-B buyer intent
- Idempotent re-run: skip-if-filled default for AI outputs; --force flag for re-processing; temperature 0 for deterministic re-runs

**Defer (v3.x / v4+):**
- target gender attribute propagation to Shopify category metafield - requires push script update
- Automated collection scaffold from tags - separate push concern
- Seasonal/trend tags - requires calendar logic; low ROI for B2B buyer

### Architecture Approach

Three new scripts/*.ts entry points, zero new src/ modules. Each script follows the pattern from rewrite-descriptions-bestsellers.ts: read all BR rows once via raw sheets.spreadsheets.values.get (NOT readAllRows - that filters to SHEET_COLUMNS only), build a header-index map at runtime, group by productId, process one group at a time, accumulate EnrichmentUpdate[], flush to writeUpdates() every 25 products.

**Major components:**
1. scripts/link-br-images.ts (NEW): lists all Drive supplier/pid folders, parses canonical filenames, joins to BR rows by (productId, normalizeColor), overwrites 8 image columns; dry-run emits tmp/link-br-images-plan-timestamp.tsv
2. scripts/infer-categories.ts (NEW): per-product gpt-4o-mini call with structured output returning baseCategory and taxonomyPath, writes both columns to all rows for that pid; checkpoint in tmp/infer-categories-checkpoint.json
3. scripts/gen-keywords.ts (NEW): same pipeline shape; runs after categories are filled; outputs comma-separated tag tokens to keywords column
4. Shared infrastructure (ALL REUSED UNCHANGED): src/sheets/client.ts, src/sheets/drive.ts, src/sheets/writer.ts, src/sheets/column-map.ts, src/lib/cost-tracker.ts

**Key data decisions:**
- Join key: productId not styleID - styleID is empty on ~21% of rows; Drive folder names correspond to productId
- Color normalization: c.toLowerCase().replace non-alphanumeric chars with empty string - exact match only; spelling variants (Grey/Gray) are logged misses, never fallbacks
- Column index: read header row at runtime; re-read after appendDimension before writing data; never hard-code column letters
- Row index: sheetRow = dataRowIndex + 2; assert sheetRow >= 2 before every write

### Critical Pitfalls

1. **Wrong-color image overwrite via loose color join** - Forest Green and Forest Gray can both collapse after stripping non-alphanumeric; the wrong file silently overwrites a cell. Dry-run required before --apply; validate 10 products with 5+ colors manually. Drive-absent = no-op, never write empty on overwrite.

2. **Hyphenated brand name leaks into color token** - Q-Tees-H08050-Forest-Green-Front.png naively split on hyphen gives brand suffix in color. This was the exact finalize parser bug from 2026-05-29. Parse by extracting known pid and role enum first; derive color as middle segment; validate extracted color exists in BR known colors for that pid.

3. **Overwriting existing valid links when Drive file is absent** - the linker overwrites all image cells per spec; if a Drive file is missing the correct behavior is no-op, not write-empty. Write pre-overwrite backup to tmp/br-image-backup-date.tsv. Drive-absent = preserve existing.

4. **OpenAI monthly usage cap mid-batch without checkpoint** - this project has previously hit the ~10-15 dollar/session cap. Distinguish rate_limit_exceeded (backoff and retry) from insufficient_quota (checkpoint + exit cleanly). Write tmp/ai-categories-checkpoint.json after each successful product.

5. **AI taxonomy mismatch / schema not constrained** - without response_format: json_schema the model outputs natural language that fails resolveCategory(). Constrain baseCategory to the 15-value enum. Post-validate with resolveCategory(); null result = hallucination, fall back to existing BR value.

6. **Header drift on new column append** - re-read header row after appendDimension before writing data. Check by name not position; idempotent on headers so second run does not append duplicates.

---

## Implications for Roadmap

### Phase 1: Drive to BR Image Linker

**Rationale:** Deterministic, unblocked, no AI dependency. v2.0 finalize confirmed 452/452 pid folders at canonical naming with plan=0. Ships independently of the OpenAI cap situation.

**Delivers:** All 8 image columns in BR populated with canonical Drive URLs for every (pid, color) pair that has a file; 5 new columns added safely; pre-overwrite backup written; dry-run TSV reviewed before apply.

**Addresses:** Drive image linker (table stakes); 5 new image columns (table stakes).

**Must avoid:** Wrong-color join (P1), hyphenated brand color leak (P3), overwrite of good links when Drive file absent (P2), header drift on new columns (P4), off-by-one row index (P5).

**Research flag:** Standard patterns - write-model-urls.ts and link-drive-images.ts are direct prior art; all patterns documented.

---

### Phase 2: AI Category Inference

**Rationale:** Requires OpenAI cap raised (external gate). Must run before keyword generation so categories is available as prompt context. baseCategory refinement is bundled here - it feeds the taxonomy path selection and the keyword garment-type bucket.

**Delivers:** categories column filled with Shopify Standard Taxonomy leaf-node paths; baseCategory normalized to 15-value controlled vocabulary across all 291 products.

**Addresses:** AI baseCategory refinement (table stakes), AI categories fill (table stakes), audience-aware taxonomy paths (differentiator).

**Uses:** gpt-4o-mini with zodResponseFormat(); CostTracker at 5 dollar cap; p-queue concurrency 15; writeUpdates flush every 25 products; tmp/infer-categories-checkpoint.json for resume.

**Must avoid:** AI taxonomy mismatch (P8) - schema-constrain baseCategory to 15-value enum; inconsistent labels (P9) - temperature 0; monthly cap without checkpoint (P12) - catch insufficient_quota separately; prompt injection (P11) - sanitize inputs with XML delimiters; re-run drift (P13) - skip-if-filled default.

**Research flag:** One open question must be answered before implementation (see Gaps). Pipeline pattern is standard - rewrite-descriptions-bestsellers.ts prior art.

---

### Phase 3: AI Keyword Generation

**Rationale:** Depends on Phase 2 completing so categories is available as keyword prompt context. Can be collapsed with Phase 2 into a single combined call returning baseCategory, taxonomyPath, and keywords[] - recommended to halve API calls from ~582 to ~291.

**Delivers:** keywords column filled with 10-15 lowercase-hyphen consumer tag tokens per product, fanned to all BR rows for that productId.

**Addresses:** AI keyword/tag generation (table stakes), consumer-voice framing (differentiator), occasion/use-case tags (differentiator).

**Must avoid:** Keyword stuffing and wholesale jargon (P10); over-tagging - hard cap 15; synonym explosion - one canonical form per concept; re-run drift (P13) - skip-if-filled + checkpoint pattern.

**Research flag:** Standard patterns - identical pipeline to Phase 2.

---

### Phase 4 (v3.x): Shopify Push Wiring

**Rationale:** Push script does not currently write categories or keywords to Shopify. Separate concern from data population; should not gate Phases 1-3.

**Delivers:** categories as Shopify product category (taxonomy categoryId); keywords as Shopify product tags; target gender as category attribute.

**Research flag:** Needs research - open question on whether push script writes taxonomy categoryId (numeric, required by Admin API) or free-text path string. Resolve before planning.

---

### Phase Ordering Rationale

- Phase 1 first: no dependencies, unblocked today, delivers immediate value to the push pipeline regardless of OpenAI cap status.
- Phase 2 before Phase 3: refined baseCategory is the primary garment-type signal for keyword generation; categories is taxonomy context. Phase 3 is blocked on Phase 2 output.
- Phases 2 and 3 can be collapsed into one script emitting combined structured output - recommended as it halves API calls from ~582 to ~291.
- Phase 4 deferred: populating BR first lets the team validate content quality before writing to Shopify.

### Research Flags

Phases needing deeper research during planning:
- **Phase 4 (Shopify push wiring):** Admin API requires numeric categoryId, not path string. Needs API research before planning.

Phases with standard patterns (skip research-phase):
- **Phase 1:** write-model-urls.ts and link-drive-images.ts are direct prior art.
- **Phase 2:** rewrite-descriptions-bestsellers.ts is AI pipeline prior art.
- **Phase 3:** Identical pipeline to Phase 2.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Direct codebase inspection + verified OpenAI community reports on gpt-4.1 json_schema failures; gpt-4o-mini structured output already used in this codebase |
| Features | HIGH | Shopify taxonomy and tag behavior verified against official docs; Fortee feature set derived from PROJECT.md constraints |
| Architecture | HIGH | Derived from direct codebase inspection of 8+ existing scripts; all patterns have prior art in this repo |
| Pitfalls | HIGH | Pitfalls 1-3 are known failures from this project own history (finalize brand-leak bug, Drive gotcha, color join issues); Pitfall 12 from project memory |

**Overall confidence:** HIGH

### Gaps to Address

- **Taxonomy allowed-values list must be defined before AI prompt is written:** Convert the FEATURES.md garment-type table to a z.enum([...]) before writing the prompt. Do not leave taxonomy path open-ended.

- **DirectSideImage = LeftSide assumption needs verification:** Verify the existing DirectSideImage cells contain left-side (not right-side) URLs before overwriting; if BR has RightSide images stored there, the mapping is inverted.

- **Drive public permission state for existing files:** Files moved to Drive via UI may lack reader/anyone permission. Phase 1 should include a permission check-and-set step or at minimum a post-link sample validation (10 random HTTP HEAD requests).

- **Shopify push taxonomy categoryId vs. path string:** Admin API productUpdate mutation accepts a numeric categoryId, not path string. Resolve before planning Phase 4.

---

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: src/sheets/client.ts, src/sheets/drive.ts, src/sheets/writer.ts, src/sheets/reader.ts, src/sheets/types.ts, src/lib/cost-tracker.ts, scripts/write-model-urls.ts, scripts/link-drive-images.ts, scripts/rewrite-descriptions-bestsellers.ts, scripts/finalize-bestsellers-drive.ts
- OpenAI structured outputs guide - confirmed gpt-4o-mini support for response_format: json_schema
- OpenAI community threads - json_schema broken on gpt-4.1 variants in Chat Completions API as of mid-2026
- Google Sheets API limits docs - 300 req/min/project write quota
- Shopify Standard Product Taxonomy 2025-09 - taxonomy paths and attribute values
- Shopify Help: Product Category - taxonomy integration with tax, feeds, metafields
- .planning/PROJECT.md - milestone goal, constraints, key decisions

### Secondary (MEDIUM confidence)
- pricepertoken.com OpenAI models - gpt-4o-mini 0.15/0.60 per 1M tokens verified June 2026
- Shopify Tags Best Practices (Black Belt Commerce) - 5-15 tags, lowercase-hyphen format
- Shopify Product Tags SEO (Eastside Co) - tag pages indexed = duplicate content risk
- Shopify community: Drive URL import - uc?id redirect limitation confirmed

### Project Memory (HIGH confidence for this codebase)
- Finalize parser brand-leak fix (2026-05-29) - Q-Tees hyphenated brand caused color token corruption
- Drive uploadToDrive update-in-place gotcha - same fileId returned on update; never trash before comparing
- OpenAI monthly usage cap (~10-15 dollars/session) - checkpoint/resume pattern mandatory for AI batches

---
*Research completed: 2026-06-09*
*Ready for roadmap: yes*