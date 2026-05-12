# Phase 16: Catalog Image Pollution Audit & Fix — Context

**Gathered:** 2026-05-12
**Status:** Ready for planning
**Source:** /gsd-discuss-phase 16 (1 round, 4 gray areas resolved)
**SPEC:** 16-SPEC.md (11 requirements locked, ambiguity 0.18)

<domain>
## Phase Boundary

Phase 16 audits Bestsellers-Ready (~460 pids) for image pollution across all 6 image columns (FrontImage, BackImage, DirectSideImage, ModelFrontImage, ModelSideImage, ModelBackImage). Detection uses three passes (structural → AI content → AI shape). Auto-fix runs per-tier (supplier API → AI regen → manual queue). Phase closes when zero polluted pids remain. Manual queue size is HARD-capped at 20.

The phase is NOT:
- A repush of fixed products to the live store (separate workflow)
- A fix for the broader Sheet1 master sheet (44k rows, deferred)
- Headwear/caps support (verifier doesn't support those CategoryGroups; separate phase)
- Drive folder reorganization (only file content writes/deletes in scope)
</domain>

<decisions>
## Implementation Decisions

### Detection (Pass 1 — Structural)

**D-01: Detect shared-URL pollution by scanning BR for fileId collisions across pids.** Any fileId (extracted from FrontImage / BackImage / DirectSideImage / ModelFrontImage / ModelSideImage / ModelBackImage URLs) appearing in rows for >1 distinct pid is flagged as content-mismatch. This is cheap, deterministic, no AI calls. Catches the 8882=5200=CE520L=NE220 Adidas-hoodie class.

**D-02: Pass 1 produces a TSV of (fileId, list_of_pids_sharing_it, columns_using_it) sorted by collision count descending.** Operator-readable; informs which fileIds are "spreaders" vs minor cases.

### Detection (Pass 2 — AI content verification)

**D-03: For each pid, compare the BR FrontImage against a supplier canonical fetched at audit time.** Verifier prompt: "Are these two images of the same specific product? Answer yes/no with a one-sentence reason." (Not "same garment family?" — that's too loose; this needs same-product strict.)

**D-04: Supplier canonical resolution:**
- S* prefix → S&S Canada REST API (pattern from `scripts/fetch-ss-rest-sizes.ts`)
- L* prefix → CSW scraper (pattern from `scripts/scrape-csw-product.ts`)
- Other prefixes (numeric / brand-specific) → look up via `KNOWN_SUPPLIER_PREFIXES` allowlist from Phase 14; if no supplier mapped, flag as `no_canonical_available` (cannot Pass 2 verify; goes through Pass 3 for shape only)

**D-05: Pass 2 also verifies each Model* column against the corresponding garment-only column for the same pid.** "Is the garment in this model photo the same product as in this front photo?" Catches the 8882 case where the model image is for a different (A2009) hoodie.

### Detection (Pass 3 — AI shape verification)

**D-06: Reuse Phase 15's `verifyGarmentTypeMatch()` on each pid's BackImage vs FrontImage, DirectSideImage vs FrontImage.** Same prompt, same gpt-4o-mini model, same `detail: 'low'`. No changes needed.

**D-07: Pass 3 only runs on pids that survived Passes 1+2 cleanly (no other pollution flagged).** Avoids double-flagging — a pid with shared-URL pollution already gets queued for fix; running shape verification on it adds noise.

### Audit output

**D-08: Single audit TSV: `tmp/image-pollution-audit-{YYYY-MM-DD}.tsv`.** Columns: `pid`, `pollution_class` (one of: shared_url | content_mismatch | shape_drift | model_pollution), `affected_columns` (comma-separated), `affected_drive_urls` (comma-separated), `expected_supplier_url` (or `no_canonical_available`), `recommended_fix_tier` (1/2/3), `pass_detected_in` (1/2/3), `notes`.

**D-09: Pre-audit summary header in TSV:** `# audit_run_id`, `# pids_scanned`, `# pids_polluted`, `# class_counts`, `# headwear_skipped_count`. Helps operator gauge scope at a glance.

### Fix flow

**D-10: Per-tier batching.** Execute in three phases:
1. **Tier 1 (supplier fetch)** — for every polluted pid where supplier canonical exists, re-fetch supplier image. Batch supplier API calls where possible. Verifier-after-fix (compare new candidate to existing FrontImage if pollution was Back/Side/Model — i.e., front is the truth; or to supplier canonical if FrontImage itself was polluted).
2. **Tier 2 (AI regen)** — for shape-drift pids not resolved by Tier 1, call `generateGarmentView()` with the front. Phase 15's strict-AND verifier ensures shape match before commit.
3. **Tier 3 (manual queue)** — write remaining pids to `tmp/image-pollution-manual-queue-{YYYY-MM-DD}.tsv` and launch the interactive CLI (see D-13).

**D-11: After Tier 2 completes, manual queue size is known.** If > 20, phase BLOCKS:
- Phase status set to BLOCKED-QUEUE-OVERFLOW
- Operator can run `npx tsx scripts/audit-image-pollution.ts --post-mortem` for a queue analysis showing which pollution classes drove the overflow
- Planner re-engages to broaden Tier 1/Tier 2 coverage (add scrapers, loosen retry, etc.)

**D-12: Tier 1 supplier scraper expansion strategy (if queue > 20):**
- Add Bella+Canvas (high-volume brand for premium tees)
- Add Gildan core catalog (high-volume cheap tier)
- Add S&S front-image OneSource fallback (for pids that exist in S&S inventory but not REST API)
This is a planning-time decision, not run-time — planner sees the post-mortem and decides which scrapers to add before the next audit run.

### Manual queue UX

**D-13: Interactive CLI walkthrough.** New script: `scripts/fix-image-pollution-manual.ts`. For each row in the manual queue TSV:
- Display: `pid`, `pollution_class`, `affected_columns`, current Drive URLs (with `gdrive.com/file/d/...` viewable links printed terminal-friendly)
- Prompt: `[r] replace with new fileId | [s] skip (defer) | [a] accept-as-is (skip and mark accepted) | [d] delete (blank the column) | [v] view full pid context | [q] quit`
- On `r`: prompt for new URL or fileId; verifier-after-fix runs on the new image; if pass, BR cell written + trail logged; if fail, retry or skip
- On `d`: confirm by typing `DELETE` literally before blanking column; trail logs
- On `s` / `a`: write to trail with status `skip` / `accepted-as-is`; pid is NOT counted as resolved (R11: resolved requires `BR_WRITE` with `new_value != old_value`)
- On `q`: save progress; resumable next run

### Trail format

**D-14: Single append-only TSV: `tmp/image-pollution-fix-trail-{YYYY-MM-DD}.tsv`.** One row per operation, columns: `timestamp_iso`, `pid`, `operation` (BR_WRITE | DRIVE_UPLOAD | DRIVE_DELETE | SUPPLIER_FETCH | AI_REGEN | VERIFIER_PASS | VERIFIER_FAIL | MANUAL_SKIP | MANUAL_ACCEPT), `column_or_path`, `old_value`, `new_value`, `tier`, `notes`.

**D-15: Resume from trail.** On run startup, the audit/fix script reads any existing trail TSV for today, builds a set of `processed_pids` (pids with at least one operation logged), and skips them in the current run. Each operation row is written + fsync'd before continuing to the next, so a mid-pid crash loses at most one in-flight operation. Re-running after a crash is safe and idempotent.

**D-16: Re-audit mechanism.** After fix flow completes, the audit script can be re-run with `--re-audit` flag to verify zero polluted pids remain. R10 (phase closes on zero unresolved) is checked by this re-audit, not by an inline assertion at end of fix run.

### Safety rails (R8, R9 from SPEC)

**D-17: Verifier-after-fix gate is mandatory on EVERY tier-1 and tier-2 write.** No image hits BR/Drive without passing the verifier. The verifier compares the new image to the "source of truth" front for that pid:
- If BR's FrontImage itself is being replaced, source of truth = supplier canonical
- If a back/side/model image is being replaced, source of truth = current FrontImage (assumed correct unless Tier 1 already flagged + fixed it earlier in the same run)

**Exception:** When replacing FrontImage with the supplier canonical (Tier 1), the verifier-after-fix step is skipped because the new value IS the source-of-truth — comparing supplier-canonical to itself is tautological. Trail logs the operation with `tier=1` and `notes='verifier_skipped_tautology'` (NOT a fake VERIFIER_PASS row). This exception is documented in RESEARCH lines 510-512 and was sanctioned during revision iteration 1.

**D-18: Verifier failure rolls back transparently.** New image is discarded, BR cell + Drive are not modified, pid cascades to the next tier (Tier 1 fail → Tier 2; Tier 2 fail → Tier 3). Trail logs `VERIFIER_FAIL` with reason.

**D-19: Delete operations require explicit pollution confirmation.** A Drive delete (or BR column blank) only fires when the trail has a confirmed `VERIFIER_FAIL` or pollution-class flag for that specific image. Audit pollution flag alone is enough; tier-3 manual `d` choice from CLI is enough. Defensive — no implicit deletes.

### Concurrency

**D-20: Sequential per-pid within each tier; parallel across tiers if needed.** Each tier processes pids sequentially (predictable, debuggable, simple trail). If Tier 1 is rate-limited by supplier APIs, the planner may add concurrency (e.g., 3-5 parallel requests) but the trail format must remain append-only with thread-safe writes.

**D-21: No concurrency between tiers.** Tier 1 must complete fully before Tier 2 starts (need definitive Tier-1-resolved set). Tier 2 must complete fully before Tier 3 is finalized (need definitive manual queue size for R6 gate).

### Headwear

**D-22: H08* pids are skipped silently in Passes 1-3 but counted.** Audit summary header in TSV includes `headwear_skipped_count`. No flag, no error. SPEC marks headwear out of scope.

### Cost / runtime budgets

**D-23: Audit budget:** ~$1.50-2.00 in Vision API calls (~460 pids × Pass 2 + Pass 3, each ~2-4 calls @ $0.0003). Supplier API calls free (S&S/CSW have no per-call cost). Audit runtime ≤ 60 minutes.

**D-24: Fix budget:** No explicit cap. Whatever AI regen / supplier API costs to drive manual queue ≤ 20. Operator-observable cost shown in run summary.

</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing:

### Phase 16 spec
- `.planning/phases/16-catalog-image-pollution-audit-fix/16-SPEC.md` — 11 locked requirements, 10 acceptance criteria, all boundaries

### Prior phase artifacts (reusable patterns)
- `.planning/phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/` — Phase 14 SUMMARY.md(s) document `resolveStoreProduct`, `KNOWN_SUPPLIER_PREFIXES` allowlist, dedupe `STRAY_PATTERNS`, cross-pollution TSV format
- `.planning/phases/15-garment-type-verification/15-PHASE-SUMMARY.md` — Phase 15 ships `verifyGarmentTypeMatch`, `appendRejectRow`, retro audit script pattern, fixture-gated test pattern

### Source code (reuse, do not duplicate)
- `src/lib/ai-image-generator.ts` — `verifyGarmentTypeMatch()` (used in D-06), `generateGarmentView()` (used in Tier 2)
- `src/lib/rejects-tsv.ts` — `appendRejectRow()` extensible pattern for trail TSV writer (D-14)
- `scripts/audit-garment-types.ts` — DI seam pattern for the new audit script
- `scripts/fetch-ss-rest-sizes.ts`, `scripts/fetch-model-images.ts`, `scripts/fetch-ss-images-fixed.ts` — S&S supplier patterns
- `scripts/scrape-csw-product.ts` — CSW scraper pattern
- `src/sheets/client.ts`, `src/sheets/drive.ts`, `src/sheets/reader.ts`, `src/sheets/writer.ts` — sheet/Drive auth + read/write
- `src/shopify/variants.ts` (`getCategoryGroup`) — CategoryGroup derivation
- `src/sheets/types.ts` — SheetRow shape

### Operational evidence (from this session)
- Today's full retro audit (`tmp/full-audit-2026-05-12.log`, `tmp/garment-type-rejects.tsv`) — in progress at SPEC time; will have results before plan phase

</canonical_refs>

<specifics>
## Specific Ideas

### Concrete pollution cases observed in BR (from this session)

These are the empirical examples Phase 16 must handle:

1. **Shared-URL pollution (Pass 1 catches):**
   - `8882`, `5200`, `CE520L`, `NE220` all share fileId `1tr8XMqVABvDCJQFjxnWKdXiy5oZfvT0m` (Adidas hoodie) as their FrontImage
   - Pass 1 flags this fileId with 4-pid collision; expected fix tier varies per pid (Tier 1 from supplier API for each, or Tier 3 manual)

2. **Content-mismatch pollution (Pass 2 catches):**
   - `6110` FrontImage shows a baby onesie, but 6110 is supposed to be a t-shirt
   - Pass 2 compares 6110's current FrontImage to S&S supplier canonical for 6110; mismatch flagged

3. **Model-image pollution (Pass 2 catches):**
   - `8882` has a ModelFrontImage that the operator identifies as a model image for `A2009` (a hoodie not even in our catalog)
   - Pass 2 compares 8882's ModelFrontImage to 8882's garment-only FrontImage (or to supplier canonical); mismatch flagged

4. **Shape drift (Pass 3 catches):**
   - Already-uploaded back/side images where the AI gen drifted to a different garment shape
   - Phase 15's `verifyGarmentTypeMatch` already proven on this class

### Manual queue CLI expected behavior (D-13 expansion)

For each row in the manual queue, the CLI must:
1. Print: `Polluted pid: 8882 — class=model_pollution, columns=ModelFrontImage`
2. Show the polluted image URL (terminal-clickable: `https://drive.google.com/uc?id=...`)
3. Show the supplier canonical URL if Pass 2 fetched one
4. Show the operator's options in single-letter form
5. On `r`, prompt: `New fileId or URL?` — accept either Drive URL or bare fileId
6. On `r` after input, run verifier-after-fix; if fail, prompt: `Verifier rejected. Retry, skip, or force?` (force requires typing `FORCE` literally)
7. After each pid resolved, advance and persist trail row

</specifics>

<deferred>
## Deferred Ideas

These are explicitly NOT in Phase 16's scope:

- **Sweep Sheet1 (44k rows)** — only Bestsellers-Ready in scope. A separate phase could extend the audit + fix pipeline to Sheet1 later. The infrastructure built here makes that extension straightforward.
- **Sweeping CSW baseCategory fix (1,494 rows)** — separate from image pollution. Documented in Phase 15 follow-up memory; needs its own phase.
- **Headwear CategoryGroup support** — verifier doesn't support beanies/caps. Needed for caps to participate in any future audit. Separate phase.
- **Store push of fixed products** — Phase 16 writes to BR + Drive only. Operator runs `scripts/push-bestsellers-to-store.ts` at their discretion afterward.
- **Drive folder reorganization** — out of scope per SPEC. Only file content writes/deletes happen.
- **Adding new pids to BR** — Phase 16 fixes existing pids; doesn't promote new ones.
- **Automated regression test that re-runs audit weekly** — could be useful follow-up; deferred until Phase 16's audit infrastructure is proven.
- **Web UI for manual queue** — interactive CLI is sufficient for ≤20 cases. Web UI deferred unless queue gets persistently large.

</deferred>

<claudes_discretion>
## Claude's Discretion

Areas where the planner / executor decides without further user input:

- **TSV column ordering and exact header naming** — within the schemas described in D-08 and D-14, planner picks sensible defaults
- **CLI flag set for the audit script** — `--all`, `--pid X`, `--dry-run`, `--re-audit`, `--manual`, `--post-mortem` are sufficient defaults; planner may add others as needed
- **Logging verbosity per tier** — debug/info/warn balance left to planner; trail TSV is the durable record regardless
- **Verifier prompt exact wording** — D-03 specifies semantics ("are these two images of the same specific product?"); planner refines the exact string and any few-shot examples
- **Supplier API rate-limit handling** — planner picks (linear backoff vs exponential, retry budget per pid)
- **Color-aware vs color-blind comparison** — if a supplier canonical is "Black" but BR FrontImage is "Navy" of the same product, should the verifier flag? Default: color-blind ("ignore color, compare style/brand/cut"). Planner may iterate based on false-positive rate.
- **Front image source-of-truth ordering** — D-17 specifies the logic; planner implements without further consultation
- **Concurrency tuning within tiers** — D-20 allows it; planner picks parallelism level based on observed rate limits
- **Audit/fix script names** — `scripts/audit-image-pollution.ts` (audit), `scripts/fix-image-pollution.ts` (auto-fix), `scripts/fix-image-pollution-manual.ts` (interactive CLI) are reasonable defaults; planner can adjust if collision with existing scripts

</claudes_discretion>

---

*Phase: 16-catalog-image-pollution-audit-fix*
*Context gathered: 2026-05-12 via /gsd-discuss-phase (1 round, 4 areas resolved)*
