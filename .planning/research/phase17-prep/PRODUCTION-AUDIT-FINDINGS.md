# Phase 17 prep: production audit findings (2026-05-13 → 2026-05-14)

Notes on what the first production run of Phase 16's audit + fix orchestrator actually surfaced, plus what scope Phase 17 should target.

## What we ran

| Step | Date | Outcome |
|------|------|---------|
| Full audit `--all` | 2026-05-13 15:53 | Hung at 435/449 pids on a stuck Drive HTTP fetch (no fetch timeout in `src/sheets/drive.ts`). Killed manually. Atomic summary TSV never written. |
| Trail post-mortem | 2026-05-14 | Reconstructed pollution data from trail file. 213 polluted pids, 453 detection rows. |
| Audit TSV reconstruction | 2026-05-14 | `tmp/image-pollution-audit-2026-05-13.tsv` written from trail. |
| Fix orchestrator dry-run | 2026-05-14 11:48 | Estimated tier1_fixed=36, tier2_fixed=4. Hit OpenAI billing hard limit. `manual_queue_size=370` → BLOCKED-QUEUE-OVERFLOW. |
| Fix orchestrator `--tier1-only` | 2026-05-14 11:57 | Real run: tier1_fixed=**1** (5 pids partially fixed). Dry-run estimate was off by 36×. |

## Real pollution patterns (213 polluted pids, 453 detections)

### By class
| Class | Detections | % of total |
|-------|-----------|-----------|
| `model_pollution` | 312 | 69% |
| `shared_url` | 118 | 26% |
| `content_mismatch` | 20 | 4% |
| `shape_drift` | 3 | 1% |

### By column
| Column | Fails | % |
|--------|-------|---|
| ModelBackImage | 145 | 32% |
| ModelFrontImage | 101 | 22% |
| ModelSideImage | 82 | 18% |
| DirectSideImage | 60 | 13% |
| FrontImage | 34 | 7% |
| BackImage | 32 | 7% |

**Model* columns are 72% of all pollution.** Tier 2 (AI back/side regen) doesn't touch these.

### Notable clusters
- **Adidas-hoodie shared image** (14 detections): pids `CE520L`, `NE220`, `8882`, `5200`, `3911`, `6405`, `18000B`, `4651`, `4610` — all share one Drive fileId of an Adidas hoodie. Each is a different brand; no single supplier canonical fits.
- **Caps with hoodie models** (30+ detections): `9302`, `A702`, `1010`, `6110`, `168`, etc. — all 3 model views are pictures of a hoodie instead of a cap.
- **Garment images of wrong product class** (5+): "tote bag" model images on garment pids.

## Why Tier 1/2 yield was much lower than dry-run estimated

### Tier 1 (1/213 fully fixed)
Two structural reasons:

1. **Most polluted brands have no supplier scraper.** 714 of 1012 Tier 1 attempts logged "no canonical for tier 1". Missing scrapers for: Bella+Canvas (3000-series, 3001, 3911, 6110), Gildan (5000-series, 18000-series), Adidas (CE520L, A* series, A702), New Era (NE220, NE7*), anvil (9xx), QTB6000, M786, etc. Pids that succeeded were all S&S Canada `SP*`.

2. **`supplier-canonical` is style-level, not color-level.** Returns one canonical image per style; BR rows are per-color. Verifier (correctly) rejects mismatches with notes like "same hoodie style, different color" (7), "same softshell jacket style, different color" (2), "candidate is red, reference is black" (2). 11 such rejections this run.

### Tier 2 (0/213 fixed)
- OpenAI account hit billing hard limit; every `generateGarmentView` call returned `400 Billing hard limit has been reached`.
- Even with budget, Tier 2 only handles BackImage / DirectSideImage. 72% of real pollution is in Model* columns — Tier 2's design doesn't address those.

## Latent bugs surfaced

| ID | Where | Issue | Severity |
|----|-------|-------|----------|
| **B-1** | `src/sheets/drive.ts` | No HTTP timeout on Drive fetch calls. A stuck connection blocks the audit indefinitely. Hung at pid after `1376842` after 2.5 hours of normal operation. | High — blocks any large-scale audit |
| **B-2** | `scripts/fix-image-pollution-manual.ts` | `--dry-run` gates Sheets writes (lines 404, 741) but NOT `trashDriveFileFn` (lines 429, 712). Operator with `--dry-run` typing DELETE still trashes Drive files. | Medium — destructive footgun |
| **B-3** | `scripts/cleanup-checkpoint-test-data.ts` | Scans `CHECKPOINT-TEST/` only. FORCE-uploaded replacements land in `MANUAL/<pid>/` (because `handleReplace` hardcodes `supplierCode='MANUAL'`). Cleanup leaves orphans there. | Low — one-shot script |
| **B-4** | `scripts/fix-image-pollution.ts` Tier 2 | No graceful handling of OpenAI billing hard limit. Each pid retries individually, spamming errors and wasting time. Should detect HTTP 400 "billing hard limit" once and abort Tier 2 entirely. | Medium — usability |

## Phase 17 scope (proposed)

Reordered by impact-per-effort:

### Plan 17-01: Drive fetch timeout (B-1 fix) — 1 day
Adds 30s fetch timeout + retry budget to `uploadToDrive`, `downloadFromDrive`, `getDriveFileMetadata`, `trashDriveFile`. Unblocks every large-scale audit run forever. Pre-requisite to all other plans (any of them would re-hit B-1 on a full catalog scan).

### Plan 17-02: Per-color supplier-canonical — 2-3 days
Modify `src/lib/supplier-canonical.ts` to accept `(pid, colorName)` and query the supplier API for that specific color. Targets the 11 color-mismatch rejections + the many cases that didn't even attempt because canonical returned a wrong-color URL.

### Plan 17-03: Model image rebuild tool — 3-5 days
**Biggest yield by far** — addresses 312 of 453 detections (69%). Build `scripts/fix-model-images.ts` that:
- Detects pids where Model* images don't match the garment type (reuse Phase 15 verifier + Phase 16 audit logic)
- For caps/hats/headwear: regenerate models using the cap-specific prompt
- For garments: rebuild model images using `generateGarmentView` in "model" mode
- Per-color rebuild so each row gets its correct color

Note: requires OpenAI budget topped up. Costs scale with number of Model* slots.

### Plan 17-04: D-12 scraper expansion — 4-5 days
Add scrapers for the missing brands ranked by impact:
1. Bella+Canvas (3001, 3911, 6110, 18500, etc. — 50+ polluted pids)
2. Gildan (5000-series, 18000-series — 30+ pids)
3. Adidas (CE520L, A702, A* series — 15+ pids)
4. New Era (NE220, NE7xx — 10+ pids)
5. anvil (9xx — 8+ pids)

Each scraper is its own sub-task. Each unlocks Tier 1 fixes for its respective pids — once 17-02 ships, the color-aware canonical will use these scrapers correctly.

### Plan 17-05: Shared_url cluster manual triage — operator effort, not engineering
After 17-01..17-04 reduce the count, walk the remaining `shared_url` clusters in the manual CLI. Plan author already shipped the operator tooling in Phase 16; just need to run it on the residue.

### Minor cleanup plans
- Patch B-2 (`--dry-run` Drive-trash gap) — 30 min
- Patch B-3 (cleanup script blind spot) — 30 min
- Patch B-4 (Tier 2 billing-limit short-circuit) — 1 hour

## Artifacts from today (NOT committed, in tmp/)

- `tmp/image-pollution-fix-trail-2026-05-13.tsv` — 1528 trail rows (audit + checkpoint + Tier 1 attempts). Source of truth for post-mortem.
- `tmp/image-pollution-fix-trail-2026-05-14.tsv` — 100 trail rows from Tier 1 run.
- `tmp/image-pollution-audit-2026-05-13.tsv` — 453 reconstructed audit rows, ready for fix orchestrator.
- `tmp/image-pollution-manual-queue-2026-05-14.tsv` — 366 pids that cascaded to Tier 3.
- `tmp/audit-run-2026-05-13.log` — audit hang investigation evidence.
- `tmp/fix-tier1-2026-05-14.log` — fix run log.

These are large and ephemeral. Don't commit; rerun if needed.

## Cost so far

| Operation | Cost |
|-----------|------|
| Audit run (1522 Vision calls before hang) | ~$3.80 |
| Tier 1-only fix run | $0.00 |
| **Total** | **~$3.80** |
