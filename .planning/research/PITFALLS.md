# Pitfalls Research

**Domain:** v3.0 Catalog Data Completion — Drive→BR image linker, AI categories, AI keywords
**Researched:** 2026-06-09
**Confidence:** HIGH (based on codebase inspection + known project failure modes)

---

## Critical Pitfalls

### Pitfall 1: Wrong-Color Image Overwrite via Loose Color Join

**What goes wrong:**
The Drive→BR linker joins Drive files to BR rows by (pid, colorName). If the color-match logic is too loose — e.g. `normalizeColor()` strips hyphens/spaces so "Forest Green" and "Forest Grn" both become `forestgrn`, but "Forest Green" and "Forest Gray" both collapse to `forestgr` — an image for one color silently overwrites a cell for a different color. At 24,175 rows / ~291 products this goes undetected until a customer sees the wrong garment color on the storefront.

**Why it happens:**
The existing `link-drive-images.ts` normalizes both the Drive filename token and the BR `colorName` to lowercase alphanum only (`color.toLowerCase().replace(/[^a-z0-9]/g, '')`). This is too aggressive — it makes "Forest Green" and "Forest Gray" indistinguishable. It also relies on the filename color token being an exact extraction, which fails with the new canonical filename convention `{Brand}-{pid}-{Color}-{Role}.png` if the color contains spaces (encoded as hyphens in filenames but stored with spaces in BR).

**How to avoid:**
1. Use a two-pass join: exact normalized match first, then fuzzy only as a fallback with a minimum similarity threshold.
2. Before `--apply`, produce a dry-run diff that shows `pid | colorName | old URL | new URL` for every overwrite and count color-token mismatches (where Drive color != BR colorName).
3. Validate the join on a known-good sample: pick 10 products with 5+ colors and manually verify each row maps to the correct Drive file before running on the full sheet.
4. Never fall back to the "generic" image bucket (no color in filename) when overwriting existing non-empty cells — only write generic images to rows that are currently blank.

**Warning signs:**
- More cell updates than `(rows with empty image cells)` in dry-run — means overwriting existing links.
- Two different BR colors resolve to the same Drive file URL.
- Color token in Drive filename has fewer characters than the BR colorName after normalization.

**Phase to address:** Drive→BR image linker (Stream A)

---

### Pitfall 2: Overwriting Previously-Good Image Links on Drive-File-Missing Rows

**What goes wrong:**
The linker OVERWRITEs all image cells (per spec). If a Drive file is absent for a particular pid/color (e.g., a color was never standardized, or the file was in a non-standard folder), the script overwrites the existing valid link with an empty string or silently skips the row. The previously-good URL — which was working on the store — is gone.

**Why it happens:**
"Overwrite all" is simpler than "merge only empty", but it conflates two distinct states: (a) Drive has the canonical file → write it, (b) Drive does not have the file → preserve existing value. The old `link-drive-images.ts` only wrote to missing cells (`needFront/needBack/needSide` guard), but the v3.0 spec calls for overwriting. If the script applies a no-file result as an empty string, damage is permanent.

**How to avoid:**
1. Treat Drive-file-absent as a no-op for that cell, not a write-empty. Only write a cell if the corresponding Drive file was actually found.
2. In dry-run output, separately report: (a) cells that will be written with a Drive URL, (b) cells where Drive file is missing and the existing value will be preserved.
3. Before overwriting, read the current cell value and write it to a TSV backup file (`tmp/br-image-backup-{date}.tsv`). This is the recovery path if something goes wrong.
4. The 5 new columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack) can be safely written fresh — there are no existing values to preserve. Treat them separately from the 3 existing columns (FrontImage, BackImage, DirectSideImage).

**Warning signs:**
- Dry-run shows fewer total Drive-file-found counts than expected given Drive completion (452/452 was confirmed).
- Any existing non-empty cell in FrontImage/BackImage/DirectSideImage being overwritten with empty string.

**Phase to address:** Drive→BR image linker (Stream A)

---

### Pitfall 3: Brand-Name Leak into Color Token (Hyphenated Brand Regression)

**What goes wrong:**
The canonical filename format is `{Brand}-{pid}-{Color}-{Role}.png`. Brands like `Q-Tees`, `BELLA+CANVAS`, `J-America` contain hyphens or special characters. When the linker splits on `-` to extract the color token, the brand suffix bleeds into the color: `Q-Tees-H08050-Forest-Green-Front.png` parsed naively gives color token starting with `Tees`. This was the exact bug that caused the finalize parser to leak hyphenated brand names into color names and grow each run.

**Why it happens:**
Splitting on the first/last hyphen is ambiguous when brands contain hyphens. The parser must know the brand name to skip it, not infer it from position.

**How to avoid:**
1. Parse the canonical filename `{Brand}-{pid}-{Color}-{Role}.png` by extracting the pid (known from context) and role (known enum: Front/Back/Side/LeftSide/RightSide/ModelFront/ModelSide/ModelBack) first, then deriving color as the middle segment. Do not rely on positional hyphen splitting.
2. Maintain the `KNOWN_SUPPLIER_PREFIXES` allowlist pattern from Phase 14 — the linker should recognize the brand prefix per pid and skip it, not attempt to parse it generically.
3. Add a post-parse validation step: assert that extracted color name exists in the set of BR colorName values for that pid. If it does not match any known color, flag the file as unresolvable rather than silently assigning a wrong color.

**Warning signs:**
- Extracted color token contains a known brand name substring (e.g., `tees`, `canvas`, `america`).
- More than 1 Drive file resolves to the same (pid, color, role) triple — indicates the color extraction is returning different strings for the same physical color.

**Phase to address:** Drive→BR image linker (Stream A)

---

### Pitfall 4: Header Drift When Adding 5 New Columns to a Live 24k-Row Sheet

**What goes wrong:**
The 5 new columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack) are appended by writing headers to the next available column indices. If the script reads headers, appends, then immediately writes data using the column index calculated from the in-memory header snapshot — but another user or concurrent script has already appended a column — the data ends up one column to the right of the header. At 24,175 rows, this is silent and catastrophic.

**Why it happens:**
The existing `write-model-urls.ts` pattern reads headers once, computes `headers.length` as the append offset, then writes data in a single operation. This is correct if no other writer touches the sheet between the read and write. On a shared sheet with a human co-editing, this assumption can break.

**How to avoid:**
1. After appending headers, re-read the header row to confirm the column indices before writing any data. Do not trust the in-memory snapshot for the data-write phase.
2. Use a single atomic `batchUpdate` that writes both the header cells and a probe data row in the same API call, then validate the probe row is in the expected column before proceeding with the bulk write.
3. Add an existence check: if any of the 5 new column names already exists in the header row (possibly from a previous partial run), use the existing index rather than appending a duplicate header. The script is idempotent on headers.
4. Never delete and re-add a header (confirm the "never delete sheet tabs" rule extends to columns).

**Warning signs:**
- Column count after append differs from `original + 5`.
- Headers and first data row are misaligned (a cell in the data row does not match the column header above it).
- Running the script twice creates 10 new columns instead of 5.

**Phase to address:** Drive→BR image linker (Stream A); also applies to any AI output column addition

---

### Pitfall 5: Off-by-One Column Index on Write (Sheet Row vs. Data Row Indexing)

**What goes wrong:**
The Sheets API uses 1-based row numbers; the in-memory data array uses 0-based indices. The canonical mapping is `sheetRow = dataRowIndex + 2` (header is row 1, first data row is row 2). An off-by-one in either direction writes every cell one row above or below the correct row — overwriting the header row with data, or leaving row 2 untouched while row 24,176 gets an extra blank.

**Why it happens:**
The existing `write-model-urls.ts` uses `const sheetRow = ri + 2` which is correct. But if a new script reads the sheet with `readAllRows()` (which returns 0-based data rows) and then computes the range as `ri + 1` (forgetting that row 1 is the header), it writes to the wrong row. With 24k rows, this produces 24k wrong writes that are difficult to detect and expensive to roll back.

**How to avoid:**
1. Centralize the row-index-to-sheet-range conversion in a single helper (already exists: `columnToLetter`; add `dataRowToSheetRow(i) = i + 2`). Never compute `+1` or `+2` inline in batch-write loops.
2. In dry-run output, always print the first 3 and last 3 ranges being written — make it easy to spot if row 1 (the header) is in the update list.
3. Add an assertion before writing: `assert(sheetRowNum >= 2, 'Refusing to write to header row')`.

**Warning signs:**
- Dry-run shows a range like `'Bestsellers-Ready'!AM1` (row 1) in the updates list.
- After a real run, the header row has unexpected URL values.

**Phase to address:** All write phases (Stream A, B, C)

---

### Pitfall 6: Partial-Write Corruption on Network Error Mid-Batch

**What goes wrong:**
With 24,175 rows and up to 8 image columns per row, a full overwrite generates ~50k-200k cell updates. The writer chunks these (current BATCH_SIZE = 50,000 cells). If the process crashes, is killed, or a network error occurs after chunk 2 of 4 is written, the sheet is in a split state: some rows have v3 standardized URLs, others still have old links. Re-running without resumability may re-overwrite the already-correct rows or miss the failed rows depending on the script's idempotency.

**Why it happens:**
The existing writer has no checkpoint — each `batchUpdate` call is fire-and-forget. If the process dies between calls, there is no record of which chunks succeeded.

**How to avoid:**
1. Write a progress file after each chunk: `tmp/br-image-linker-checkpoint.json` containing `{ lastWrittenChunkIndex, totalChunks, timestamp }`. On re-run, skip chunks <= lastWrittenChunkIndex.
2. Alternatively, make the script fully idempotent: read the current sheet state, compute only the delta (Drive URL differs from current cell value), and write only the delta. This way re-running naturally skips already-correct cells.
3. For the 5 new columns which start empty, idempotency is trivial — skip any row where the cell is already non-empty.

**Warning signs:**
- Script exits with error mid-run and no checkpoint file exists.
- After a partial run, some rows in the same product group have URLs and some do not — visible as a ragged fill pattern.

**Phase to address:** Drive→BR image linker (Stream A)

---

### Pitfall 7: Drive URL Format That Does Not Render in Shopify

**What goes wrong:**
The current URL format `https://drive.google.com/uc?id={fileId}` is a redirect/proxy URL. Shopify's CDN ingestion (when the push script reads BR and uploads to Shopify) may follow the redirect successfully, or it may fail with a 403 or receive an HTML error page instead of the image binary depending on whether the file's sharing permission is "anyone with the link" vs. domain-restricted. The BR cells would contain valid-looking URLs that silently produce broken images on the store.

**Why it happens:**
`uploadToDrive` already creates a `reader`/`anyone` permission for new files. But existing files that were uploaded without that permission step (e.g., files moved via Drive UI rather than through the upload script) may be restricted. The linker generates a URL from the fileId without verifying the file's sharing status.

**How to avoid:**
1. During the Drive scan phase, fetch the file's permissions and verify `role=reader, type=anyone` is present. If it is missing, set it before writing the URL to BR.
2. Alternatively, use the `https://lh3.googleusercontent.com/d/{fileId}` direct-serve URL which works only for publicly shared files — if the URL resolves to an image, the permission is set; if it returns 403, the permission is missing.
3. Add a post-link validation step: for a sample of 10 random written URLs, make an HTTP HEAD request and verify `Content-Type: image/png`. Flag any that return non-image content.

**Warning signs:**
- Shopify push script logs "failed to fetch image" for BR rows with Drive URLs.
- Manually opening a written URL in a browser shows "You need permission to access this file."

**Phase to address:** Drive→BR image linker (Stream A)

---

### Pitfall 8: AI Category Hallucination and Taxonomy Mismatch

**What goes wrong:**
GPT-4o generates category strings that are plausible English but do not match the existing `CATEGORY_ALIASES` / `GarmentCategory` taxonomy used by the decoration rules engine. Examples: the model outputs "Quarter-Zip Sweatshirt" but the engine only knows "Hoodie"; or it outputs "Men's Athletic Tee" when the field should contain a flat category token like "T-Shirt". Downstream scripts that call `resolveCategory()` return `null` and the product gets no decoration placements.

**Why it happens:**
Without schema constraints, LLMs default to descriptive natural language. The categories column feeds both consumer-facing display AND the decoration rules engine — a mismatch in either direction breaks functionality.

**How to avoid:**
1. Pass the full `CATEGORY_ALIASES` key list as the allowed output set in the system prompt. Use `response_format: { type: 'json_schema' }` (OpenAI structured outputs) to constrain the response to a JSON object with `baseCategory` and `categories` fields, each an enum from the allowed set.
2. Post-process: run `resolveCategory()` on every AI output. Any null result is a hallucination — fall back to the existing BR value rather than overwriting with an invalid category.
3. Keep the `baseCategory` column as the engine-facing canonical value. Use the `categories` column for the consumer-facing display. These are allowed to diverge (e.g., `baseCategory = "T-Shirt"`, `categories = "Tops, Casual Wear, Summer Essentials"`).
4. Test the prompt on 20 diverse products (caps, hoodies, polos, quarter-zips) before running on all 291, verifying that `resolveCategory(output.baseCategory)` returns non-null for every test case.

**Warning signs:**
- `resolveCategory()` returns null for more than 5% of AI outputs in the test batch.
- AI outputs contain multi-word descriptors with adjectives (gender, fit, material) in the baseCategory field.
- Categories contain duplicates across different products that should be distinct.

**Phase to address:** AI category inference (Stream B)

---

### Pitfall 9: Inconsistent Category Labels Across the 291-Product Batch

**What goes wrong:**
Even with a constrained schema, the same physical product type gets different category labels across runs or across similar products. "Hoodie" in run 1, "Hooded Sweatshirt" in run 2. Or "Polo" for one product but "Golf Shirt" for another identical garment type. The `categories` column becomes unusable as a filter on the storefront.

**Why it happens:**
Without a canonical reference list in the prompt, the model exercises creative variation. Temperature > 0 introduces non-determinism. When the full batch runs in chunks across sessions, the model's interpretation of context varies.

**How to avoid:**
1. Use `temperature: 0` for all category inference calls — consistency matters more than creativity here.
2. After the first batch run, generate a frequency table of all output category strings. Identify near-duplicates and add them as explicit "do not use" or "map to X" rules in the prompt before the next run.
3. Run a consistency check after batch completion: for all BR rows with the same `productName` + `brandName` combination, assert that `categories` values are identical. Discrepancies indicate prompt drift.

**Warning signs:**
- More than 20 distinct category strings in the output for a product set that should map to ~10-15 garment types.
- Two products with identical `productName` have different `categories`.

**Phase to address:** AI category inference (Stream B)

---

### Pitfall 10: AI Keyword Stuffing and Wholesale Jargon

**What goes wrong:**
The model generates keywords that are accurate for a wholesale buyer but wrong for a consumer storefront: "bulk t-shirts", "wholesale blank apparel", "case quantity", "GSM weight", "PartID". Shopify SEO uses these as meta keywords and search terms — wholesale jargon actively hurts consumer discoverability and makes the brand look like a B2B liquidator, not a custom apparel shop.

**Why it happens:**
The product descriptions in BR contain supplier language (GSM, PartID, case quantities). Without explicit persona framing, the model mirrors the input vocabulary. The CostTracker pattern means the model is given batch context that includes many rows — any B2B language in one row bleeds into neighboring rows' keyword generation.

**How to avoid:**
1. Frame the system prompt with an explicit consumer persona: "You are generating SEO keywords for a custom apparel storefront selling to small businesses, sports teams, and event organizers — not a wholesale distributor. Never use wholesale terms: bulk, GSM, case quantity, PartID, style number, blank."
2. Include a blocklist in the prompt: supply the list of field names and supplier identifiers that must never appear in output.
3. Use `max_tokens` limits per keyword field to prevent over-generation (20-30 tokens is sufficient for a keyword list of 5-8 terms).
4. Post-validate: run a regex check for known bad terms (`bulk|wholesale|GSM|PartID|case qty|style #`) against every generated keyword string. Flag any match as a hallucination requiring manual review.

**Warning signs:**
- Keywords contain numbers (GSM values, SKU fragments).
- Keywords contain words ending in "-able" or "-ment" (embroiderable, fulfillment) — supplier ops vocabulary.
- Keyword string length exceeds 80 characters — usually means run-on descriptions rather than discrete tags.

**Phase to address:** AI keyword generation (Stream C)

---

### Pitfall 11: Prompt Injection from Product Descriptions

**What goes wrong:**
Product descriptions in BR (scraped from supplier pages) may contain embedded instruction-like text: "Note: Do not expose this product to heat above 60°C", "See size chart for details", or in pathological cases, supplier system strings like `{TEMPLATE}` or `{{brand_name}}`. When these are interpolated directly into the prompt string, they can confuse the model into following the embedded instruction instead of the actual task, or cause template literal interpolation errors in the script itself.

**Why it happens:**
The `description` field is scraped, not sanitized. The existing `rewrite-descriptions.ts` script processes descriptions but does not produce a version that is safe for prompt interpolation. Backticks, dollar signs, and curly braces in descriptions break TypeScript template literals.

**How to avoid:**
1. Sanitize all BR field values before prompt interpolation: escape or strip `{`, `}`, `\``, `$` characters. Use a `sanitizeForPrompt(s: string)` helper that replaces these with safe equivalents.
2. Wrap user-supplied content in explicit XML delimiters in the prompt: `<product_description>{...}</product_description>` and instruct the model that content inside these tags is data, not instructions.
3. Set a character limit on what is passed to the AI for each field — truncate descriptions to 500 chars. The model does not need full supplier prose to infer a category or generate keywords.

**Warning signs:**
- Model output for a specific product is unusually long or contains instructions ("please also note that...").
- Script throws `SyntaxError` on a template literal — indicates unescaped backtick in a product description.
- Keywords for one product bleed into the next (if descriptions are concatenated without clear separators).

**Phase to address:** AI category inference (Stream B) and AI keyword generation (Stream C)

---

### Pitfall 12: OpenAI Monthly Usage Cap Halting Mid-Batch Without Checkpoint

**What goes wrong:**
OpenAI enforces a monthly USAGE CAP separate from the account balance. This project has previously hit it at ~$10-15/session. An AI batch running 291 products × 2 calls (categories + keywords) = 582 calls will be cut off mid-run when the cap is hit, leaving the BR sheet in a partial state. Without a checkpoint, re-running from the start re-spends tokens on already-complete rows.

**Why it happens:**
The existing `CostTracker` in `src/lib/cost-tracker.ts` tracks spend-to-budget within a single process run but does not persist state across sessions and does not handle the external monthly cap (which surfaces as an HTTP 429 with a `monthly_quota_exceeded` code, not a balance error).

**How to avoid:**
1. Before starting the batch, hit the OpenAI `/v1/usage` endpoint (or check the dashboard programmatically) and log current monthly spend. If spend is within $5 of the cap, pause and warn the operator.
2. Write a per-product checkpoint file (`tmp/ai-categories-checkpoint.json`) after each successfully processed product. Structure: `{ completedPids: string[], failedPids: string[], timestamp }`. On re-run, skip pids in `completedPids`.
3. Catch the `429 monthly_quota_exceeded` error specifically (distinct from `429 rate_limit`) and exit cleanly with a checkpoint save rather than crashing.
4. Design the AI calls so categories and keywords for a product are generated in a single call (one prompt, one API round-trip per product), minimizing total call count.

**Warning signs:**
- Script crashes with `Error: 429 You exceeded your current quota` mid-batch.
- BR sheet has AI-filled cells for the first N products and empty cells for the rest.
- Re-running produces duplicate entries or overwrites correctly-filled cells.

**Phase to address:** AI category inference (Stream B) and AI keyword generation (Stream C)

---

### Pitfall 13: Re-Run Drift on Overwrite Scripts (Idempotency Failure)

**What goes wrong:**
Running the Drive→BR linker or the AI scripts a second time overwrites cells that were manually corrected by the operator between runs. Alternatively, the overwrite logic regenerates AI outputs with different values on the second run (non-deterministic at temperature > 0), producing cells that oscillate between values each run — the same failure mode as the mirror-side oscillation bug in the finalize parser.

**Why it happens:**
Scripts that unconditionally overwrite all target cells cannot distinguish "cell was blank, we filled it" from "cell was manually edited, we should preserve it." The AI at temperature > 0 produces different outputs on each call.

**How to avoid:**
1. For the image linker: use Drive file content hash as the signal — if the current BR cell already contains a URL that resolves to the same Drive fileId, skip the write. If the Drive file has changed (re-standardized), overwrite.
2. For AI outputs: after the first successful batch, treat non-empty `categories` and `keywords` cells as locked. The re-run script should default to skip-if-filled. Provide an explicit `--force` flag to re-run AI on already-filled cells, requiring operator intention.
3. For AI calls, use `temperature: 0` — this makes outputs deterministic given the same input, so a re-run produces identical results and the overwrite is a no-op in practice.
4. Log a summary at end of each run: `{ skipped_already_filled: N, overwritten_changed: N, written_new: N }` so the operator can verify the run did not disturb manually-edited cells.

**Warning signs:**
- Manual edits to BR are lost after a script re-run.
- The same cell has different values in consecutive runs with no Drive-file change in between.
- `skipped_already_filled` is 0 on a second run — means the script is not checking for existing values.

**Phase to address:** All three streams

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single-pass color join without validation sample | Faster to ship | Silent wrong-color image assignments discovered only after store push | Never — validate 10 products manually first |
| In-memory column index after header append | Simpler code | Data lands in wrong column if concurrent edit occurs | Only when the sheet is locked to a single writer |
| AI categories without schema constraint | Faster prompt iteration | `resolveCategory()` returns null; decoration engine breaks | Never for the baseCategory field |
| No checkpoint on AI batch | Simpler code | Monthly cap crash = re-spend on completed rows | Never for batches > 50 products |
| Unconditional overwrite of all image cells | Simpler than merge logic | Destroys manually-corrected links when Drive file is absent | Never — Drive-absent should always be a no-op |
| `temperature > 0` for keyword generation | More "creative" output | Non-deterministic re-runs produce oscillating values | Never — consistency beats creativity for tags |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Google Sheets batchUpdate | Using `USER_ENTERED` valueInputOption — Sheets auto-interprets URLs as hyperlinks, stripping the raw string | Always use `RAW` valueInputOption for Drive URLs (already done in `writer.ts`) |
| Google Drive files.list | Not paginating — `pageSize` default is 100, but a product folder with 30+ images only returns the first page | Always loop on `nextPageToken` until undefined |
| Google Drive permissions | Relying on the folder's inherited permissions — files moved via Drive UI do not inherit the folder's public permission | Check and set `reader/anyone` permission on each file individually before writing its URL to BR |
| OpenAI Chat Completions | Interpolating raw BR field values into prompt strings — backticks and curly braces cause JS template literal errors or confuse the model | Sanitize all input fields through `sanitizeForPrompt()` before interpolation; use XML delimiters in prompt |
| OpenAI monthly quota | Catching 429 as a generic rate-limit and retrying with backoff — monthly cap 429s do not resolve with backoff, they cause infinite retry loops | Inspect the `error.code` field: `rate_limit_exceeded` → backoff; `insufficient_quota` → checkpoint and exit |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Sequential Drive file.list per product folder | Script takes 10+ minutes for 291 products | Batch list all files under the supplier root in one paginated call, then partition by folderId in memory | At 50+ products |
| One OpenAI API call per row (24,175 calls for keywords) | Hits rate limits; costs ~$24 at $0.001/row | One call per product (~291 calls), passing all color-row data together; BR rows for the same pid share the same product attributes | At 500+ rows |
| Reading all 24,175 rows into memory for each write chunk | Memory pressure; slow startup on each batch | Read once, accumulate all updates, write in chunks — do not re-read the sheet per chunk | At 50k+ rows |
| `batchUpdate` with 200k individual single-cell ranges | Hits Sheets API payload limit (~10MB per request) | Coalesce contiguous cells for the same column into a single range using column notation `AM2:AM24176` | At 10k+ updates |

---

## "Looks Done But Isn't" Checklist

- [ ] **Drive→BR linker:** Ran dry-run and verified output shows correct color tokens (not brand-name leaks) for 5 products with hyphenated brands (Q-Tees, BELLA+CANVAS).
- [ ] **Drive→BR linker:** Confirmed that Drive-file-absent rows are logged as "preserved existing" not "written empty."
- [ ] **Drive→BR linker:** All 5 new columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack) have headers in the correct positions — re-read header row after append and verify indices.
- [ ] **Drive→BR linker:** Backup TSV written to `tmp/br-image-backup-{date}.tsv` before any overwrite.
- [ ] **AI categories:** `resolveCategory(output.baseCategory)` returns non-null for 100% of a 20-product test batch.
- [ ] **AI categories:** Temperature is 0 on all category inference calls.
- [ ] **AI keywords:** No wholesale/supplier jargon in keyword output for 10-product spot check.
- [ ] **AI batch:** Checkpoint file created after first product, survives a manual Ctrl+C and re-run correctly skips completed products.
- [ ] **All writes:** No range with row number 1 appears in the batchUpdate data list.
- [ ] **All scripts:** `--dry-run` mode prints a human-readable diff showing old value → new value for every cell that would change.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Wrong-color image overwrite | HIGH | Restore from `tmp/br-image-backup-{date}.tsv`; re-run linker with corrected color join logic |
| Header drift / column misalignment | HIGH | Manually correct header row; delete misaligned data column; re-run linker with re-read-after-append guard |
| Partial write (network crash) | MEDIUM | Re-run from checkpoint; idempotent delta-only write skips already-correct cells |
| AI hallucinated categories | LOW | Re-run with corrected schema-constrained prompt at temperature 0; skip-if-filled handles already-correct rows |
| Monthly cap exhausted mid-batch | LOW | Request usage cap raise from OpenAI; re-run from checkpoint skips completed pids |
| Drive URL not publicly accessible | MEDIUM | Run permission repair script; re-run linker (idempotent — same fileId, same URL, same cell value) |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Wrong-color join (P1) | Drive→BR linker build | Dry-run diff shows correct colors for 5 hyphenated-brand products |
| Overwrite of good links (P2) | Drive→BR linker build | Dry-run shows 0 overwrites on cells that are non-empty in Drive-file-absent case |
| Brand-name color leak (P3) | Drive→BR linker build | No brand-name tokens appear in extracted color strings |
| Header drift on new columns (P4) | Drive→BR linker build | Re-read header after append; column count = original + 5 |
| Off-by-one row index (P5) | All write phases | Dry-run shows no row-1 ranges in update list |
| Partial-write corruption (P6) | Drive→BR linker build | Checkpoint file exists after processing first 10 products |
| Drive URL format (P7) | Drive→BR linker build | 10 random written URLs return `Content-Type: image/*` on HTTP HEAD |
| AI taxonomy mismatch (P8) | AI category inference build | `resolveCategory()` returns non-null for 100% of 20-product test batch |
| Inconsistent AI labels (P9) | AI category inference build | Frequency table shows <= 15 distinct category strings for 291 products |
| Keyword stuffing/jargon (P10) | AI keyword generation build | Regex blocklist check returns 0 matches on 291-product batch |
| Prompt injection (P11) | AI inference and keywords build | `sanitizeForPrompt()` unit-tested on known-bad supplier strings |
| Monthly cap without checkpoint (P12) | AI inference and keywords build | Checkpoint file survives Ctrl+C; re-run skips completed pids |
| Re-run drift (P13) | All AI and linker scripts | Second run on completed batch reports `written_new=0, overwritten_changed=0` |

---

## Sources

- Codebase inspection: `src/sheets/types.ts`, `src/sheets/writer.ts`, `src/sheets/reader.ts`, `src/sheets/drive.ts`, `scripts/link-drive-images.ts`, `scripts/write-model-urls.ts`, `src/decoration/category-map.ts`, `src/lib/cost-tracker.ts`
- Project memory: finalize parser brand-leak fix (hyphenated brands, 2026-05-29)
- Project memory: Drive uploadToDrive update-in-place gotcha
- Project memory: OpenAI monthly usage cap (~$10-15/session)
- Project state: v2.0 complete — canonical `{Brand}-{pid}-{Color}-{Role}.png` across 452 products (2026-06-09)
- Phase 14 decision log: `KNOWN_SUPPLIER_PREFIXES` per-pid allowlist pattern
- Phase 14 decision log: TSV-driven mutation pattern (classify first, review, then apply)
- `.planning/PROJECT.md`: v3.0 milestone goal and constraints

---
*Pitfalls research for: v3.0 Catalog Data Completion (Drive→BR linker, AI categories, AI keywords)*
*Researched: 2026-06-09*
