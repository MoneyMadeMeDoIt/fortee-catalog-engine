# Phase 18: Drive to BR Image Linker - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning
**Source:** Locked decisions supplied inline at plan-phase invocation

<domain>
## Phase Boundary

Build a deterministic script (`scripts/link-br-images.ts`) that lists each product's
standardized Drive folder (`SUPPLIER/<pid>/` with files named
`{Brand}-{pid}-{Color}-{Role}.png`) and overwrites the Bestsellers-Ready (BR) sheet
image cells, joined by `(productId, colorName)`.

In scope:
- Enumerate Drive folders per product and parse standardized filenames (pid-anchored, role-anchored).
- Join Drive files to BR rows on `(productId, colorName)`.
- Overwrite existing image cells (FrontImage, BackImage, DirectSideImage) and ADD 5 new
  image columns (LeftSide, RightSide, ModelFront, ModelSide, ModelBack).
- Dry-run diff + TSV backup before any write.
- Idempotent `--apply`.

Out of scope:
- Generating or standardizing Drive imagery (handled by the v2.0 finalize pipeline).
- Pushing images to the Shopify store.
- Inferring or guessing colors for `(pid, color)` pairs that have no Drive file.

Depends on: Nothing — v2.0 finalize confirmed 452/452 pid folders at plan=0.
</domain>

<decisions>
## Implementation Decisions

### Join key
- **D-01** Join Drive files to BR rows on `productId` (NOT `styleID`), paired with `colorName`. The join key is `(productId, colorName)`.

### Role-to-column mapping (existing columns)
- **D-02** Map Drive `Front` role → BR `FrontImage` column.
- **D-03** Map Drive `Back` role → BR `BackImage` column.
- **D-04** Map Drive `LeftSide` role → the existing BR `DirectSideImage` column.

### New columns to add
- **D-05** ADD 4 new columns to BR: `RightSide`, `ModelFront`, `ModelSide`, `ModelBack`. (Note: the ROADMAP success criteria phrase this as "5 new columns" by also counting a dedicated `LeftSide` column — the planner must reconcile whether `LeftSide` is a new column or is the existing `DirectSideImage` per D-04. The locked decision here is: `LeftSide` Drive role lands in `DirectSideImage` (D-04); the four genuinely-new columns are RightSide, ModelFront, ModelSide, ModelBack. If a separate `LeftSide` column is also required for parity with the ModelSide naming, treat that as the 5th new column. Resolve during planning and reflect in must_haves.)
- **D-06** Re-read the BR header row immediately before writing any new column, so the column index is computed against the live sheet, not a stale snapshot (avoids clobbering the wrong column if headers shifted).

### Filename parsing (anti brand-leak)
- **D-07** Parse Drive filenames pid-anchored and role-anchored: locate the `pid` token and the trailing `Role` token first, then take the color as the substring strictly between them. This prevents hyphenated brand names (e.g. Q-Tees, H08050) from leaking into the parsed color token. Do NOT split on every `-`/`_` (the existing `link-drive-images.ts classifyImage` does this and is the known-broken behavior — do not reuse it).

### Never-blank / never-guess safety
- **D-08** A `(pid, colorName)` pair with NO matching Drive file leaves the existing BR cell value unchanged and is recorded in a miss log. Never write an empty string to a previously-populated cell. Never guess or synthesize a URL.

### Safety workflow
- **D-09** `--dry-run` produces a diff showing `old → new` per changed cell and applies nothing to the sheet.
- **D-10** Before `--apply` writes, emit a TSV backup of the affected cells/rows.
- **D-11** `--apply` is idempotent: re-running a second time produces zero net changes.

### Reuse
- **D-12** Reuse existing helpers where they fit: `scripts/link-drive-images.ts` (Drive folder enumeration / Sheets client wiring — but NOT its fragile `classifyImage` parser), `scripts/write-model-urls.ts` (model-image column writing patterns), and `src/sheets/writer.ts` (`writeUpdates`, `appendRows`). The new script is `scripts/link-br-images.ts` — a separate deterministic entry point, not an edit of `link-drive-images.ts`.

### Claude's Discretion
- TSV backup file path/naming convention and where it is written.
- Miss-log format and destination (stdout vs file).
- Internal data structures for the Drive-file index and the BR-row index.
- Batching/chunking strategy for Sheets API writes (subject to reusing `writer.ts`).
- Exact CLI flag names beyond `--dry-run` / `--apply` (e.g. an optional `--supplier` filter).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Reuse targets (read for patterns, signatures, conventions)
- `scripts/link-drive-images.ts` — Drive folder enumeration + Sheets client wiring + `colLetter` helper. Its `classifyImage`/`extractColor` parser is the KNOWN-BROKEN brand-leak behavior — read it to understand what NOT to replicate (D-07).
- `scripts/write-model-urls.ts` — patterns for writing model-image URL columns into BR.
- `src/sheets/writer.ts` — `writeUpdates(...)` and `appendRows(...)` write primitives.
- `src/sheets/client.ts` — `createSheetsClient` (referenced by link-drive-images.ts).

### Sheet identifiers (from link-drive-images.ts)
- BR spreadsheet ID: `1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs`
- BR tab: `Bestsellers-Ready`

### Project guidance
- `./CLAUDE.md` (if present) and `.claude/skills/` — project-specific rules.
- Memory: finalize parser brand-leak fix (hyphenated brands leaked into color names) — directly motivates D-07.
</canonical_refs>

<specifics>
## Specific Ideas

- Standardized Drive layout: `SUPPLIER/<pid>/{Brand}-{pid}-{Color}-{Role}.png`.
- Roles produced by finalize: Front, Back, LeftSide, RightSide, ModelFront, ModelSide, ModelBack.
- Regression case for D-07: Q-Tees H08050 — the color token must come out clean with no "Q" / "Tees" leakage.
- Idempotency check (D-11): a clean second `--apply` must report 0 changed cells.
</specifics>

<deferred>
## Deferred Ideas

- Pushing the linked imagery to the Shopify store (separate phase).
- Auto-generating any missing Drive imagery (owned by the finalize pipeline, already complete at 452/452).
</deferred>

---

*Phase: 18-drive-to-br-image-linker*
*Context gathered: 2026-06-10 from inline locked decisions*
*Covers: IMG-01, IMG-02, IMG-03, IMG-04, OPS-02, OPS-03*
