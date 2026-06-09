---
phase: 16
slug: catalog-image-pollution-audit-fix
status: spec-locked
ambiguity: 0.18
gate_passed: true
created: 2026-05-12
---

# Phase 16: Catalog Image Pollution Audit & Fix — SPEC

> Falsifiable requirements locked before discuss-phase. Treats this document as the WHAT contract; discuss-phase handles HOW.

---

## Phase Goal

Audit every unique pid in **Bestsellers-Ready** for image pollution across three classes (content-mismatch, shape drift, model-image pollution), then auto-fix where a source-of-truth exists. Phase closes only when **zero unresolved polluted pids** remain. Manual queue size is HARD-CAPPED at **20 pids** — if the audit produces a queue larger than 20, the planner must broaden auto-fix coverage rather than escalate operator workload.

This is different from:
- **Phase 14** — fixed structural BR ↔ Drive ↔ Store cross-pollution (color counts, orphan media, file labels). Did NOT check image content/identity.
- **Phase 15** — catches shape-drift in NEW AI generations + retro audit for already-uploaded shape drift. Does NOT cover content-mismatch (wrong product), model-image columns, or shared-URL pollution.

---

## Requirements (11 locked)

### R1 — Audit all unique pids in Bestsellers-Ready for three pollution classes

**Current state:** No tool detects content-mismatch (wrong product in image slot) or model-image pollution. Phase 15's retro audit covers only shape-drift on FrontImage/BackImage/DirectSideImage.

**Target state:** A single audit pass over every unique pid in Bestsellers-Ready produces a classified record per polluted pid, distinguishing:
- **Content-mismatch** — image is unique to the pid but shows a wrong product (e.g., 6110's FrontImage is a baby onesie; 8882's ModelImage is an A2009 hoodie model when A2009 isn't even in the catalog)
- **Shape drift** — back/side belongs to a different CategoryGroup than front (e.g., crewneck → hoodie)
- **Model-image pollution** — `ModelFrontImage` / `ModelSideImage` / `ModelBackImage` columns are wrong/mixed (different problem than garment-only columns)

**Acceptance:** Audit script produces `tmp/image-pollution-audit-{YYYY-MM-DD}.tsv` with one row per polluted pid containing: `pid`, `pollution_class`, `affected_columns` (comma-separated), `affected_drive_urls`, `expected_supplier_url` (if resolvable), `recommended_fix_tier` (1/2/3 per R3-R5).

### R2 — Audit covers Front/Back/DirectSide AND Model image columns (6 image columns total)

**Current state:** Phase 15's retro audit reads only `FrontImage` / `BackImage` / `DirectSideImage`. ModelFrontImage / ModelSideImage / ModelBackImage are NOT audited.

**Target state:** Audit reads all 6 image columns per pid. For Model* columns specifically, verifier compares the model image to the garment-only front (same comparison logic — does the garment in the model photo match the garment in the canonical front?).

**Acceptance:** TSV column `affected_columns` correctly identifies which of the 6 columns are polluted per pid. Test fixture (e.g., 8882) shows ModelImage pollution in audit output.

### R3 — Auto-fix Tier 1: Re-fetch from supplier API

**Current state:** Project has supplier fetchers — `scripts/fetch-ss-rest-sizes.ts`, `scripts/fetch-model-images.ts`, `scripts/fetch-ss-images-fixed.ts`, `scripts/scrape-csw-product.ts`. None integrated into a pollution-fix flow.

**Target state:** For content-mismatch pollution on supplier-sourced images (S* = S&S Canada, L* = CSW), the auto-fix flow re-fetches the canonical product image from the supplier's API/scraper, runs Phase 15's verifier on (new_image vs old_front-or-supplier-front), and writes only if verifier passes.

**Acceptance:** Tier-1 fix on a known content-mismatch pid (e.g., 6110 if S&S has it, or a CSW pid) replaces the bad image with a verifier-passing supplier image. New BR cell value differs from old. Trail TSV records old + new fileId.

### R4 — Auto-fix Tier 2: AI regenerate via Phase 10 pipeline + Phase 15 verifier

**Current state:** Phase 10's `generateGarmentView()` exists with Phase 15's strict-AND verifier integrated. Currently invoked only during initial product setup.

**Target state:** For shape-drift pollution on FrontImage / BackImage / DirectSideImage (specifically back and side, since front is the source-of-truth), Phase 16 invokes `generateGarmentView()` with the current front, captures the regenerated back/side. Phase 15's strict-AND verifier ensures the output shape matches; if 2-round retry fails, pid moves to Tier 3.

**Acceptance:** Tier-2 fix on a known shape-drift pid produces a new Drive file whose verifier output is `match: true`. The 2-round-retry-fail path correctly cascades to Tier 3 without writing.

### R5 — Auto-fix Tier 3: Manual operator queue

**Current state:** No manual queue exists. Operator must inspect pollution evidence ad-hoc.

**Target state:** Pids that survive Tiers 1 + 2 (supplier fetch failed AND AI regen failed-or-not-applicable) are written to `tmp/image-pollution-manual-queue-{YYYY-MM-DD}.tsv` with: `pid`, `pollution_class`, `affected_columns`, `current_drive_urls`, `front_image_screenshot_link`, `suggested_action` (e.g., "operator picks replacement from Drive", "delete + leave blank for next push regen").

**Acceptance:** Manual queue TSV produced. Operator can act on each row by writing replacement to BR or marking as "accepted as-is". Phase logic re-reads queue + flags any pid not marked resolved.

### R6 — HARD CONSTRAINT: Manual queue size ≤ 20 pids

**Current state:** No constraint exists. Audit could produce arbitrarily large manual queues, blocking operator.

**Target state:** After Tier 1 + Tier 2 auto-fix attempts complete across the full audit set, the count of pids in the manual queue MUST be ≤ 20. If > 20, the phase BLOCKS (does not close) and the planner must either:
- Add more supplier scrapers (improve Tier 1 coverage), or
- Loosen AI regen retry/fallback (improve Tier 2 coverage), or
- Re-classify some "polluted" pids as acceptable

**Acceptance:** Auto-fix run produces a JSON summary with `manual_queue_size` field. If > 20, phase status = BLOCKED. Planner records the gap and re-plans coverage before retrying.

### R7 — Full audit trail of every change

**Current state:** Phase 14 had partial logging via the cross-pollution TSV but no comprehensive trail of every BR write + Drive operation.

**Target state:** Every BR cell modified, every Drive file uploaded/deleted, every supplier API call appended to `tmp/image-pollution-fix-trail-{YYYY-MM-DD}.tsv` with: `timestamp_iso`, `pid`, `operation` (BR_WRITE | DRIVE_UPLOAD | DRIVE_DELETE | SUPPLIER_FETCH | AI_REGEN | VERIFIER_PASS | VERIFIER_FAIL), `column_or_path`, `old_value`, `new_value`, `tier`, `notes`.

**Acceptance:** Trail TSV exists post-run. Row count matches sum of (BR cell updates + Drive uploads + Drive deletes + supplier fetches + AI regens). Each pid in the audit appears at least once. Rollback possible by replaying trail in reverse.

### R8 — Safety rail: never delete a good image

**Current state:** No safety rail. A misclassification could delete a correct image, leaving the product without imagery on the store.

**Target state:** Before any Drive delete or BR cell blank, verifier MUST confirm the image is polluted (i.e., `verifyGarmentTypeMatch` or the audit's content-mismatch classifier returned a positive pollution signal for THAT specific image). On verifier disagreement, skip the delete and log to a `safety-rail-skips` section of the trail.

**Acceptance:** Test fixture: feed the auto-fix flow a correctly-imaged pid. Verifier returns match=true. The flow does NOT delete the image. Trail logs the skip with reason.

### R9 — Safety rail: never replace good with wrong

**Current state:** No verifier-after-fix step exists. A failed supplier fetch or AI regen could write a wrong image back to BR/Drive.

**Target state:** After every Tier-1 supplier fetch or Tier-2 AI regen, before committing to BR/Drive, verifier runs on (new_image vs source-of-truth front). On verifier fail, the new image is discarded, BR/Drive are NOT modified, and the pid cascades to the next tier.

**Acceptance:** Test fixture: induce a Tier-1 supplier fetch that returns a wrong product (mock). Verifier rejects. BR cell + Drive file unchanged. Pid cascades to Tier 2.

### R10 — Phase closes only when zero unresolved polluted pids remain

**Current state:** Phase 16 is just starting.

**Target state:** Phase closes when a re-audit run produces zero polluted pids, OR every polluted pid in the original audit appears in {auto-fixed, manually-fixed} status in the trail. Manual-queue pids count as "resolved" when operator writes a replacement to BR (NOT just by marking "accepted as-is" — see R11 for the resolution definition).

**Acceptance:** Re-running the audit script after fix completes returns 0 polluted pids. OR: every pid from the original audit TSV has at least one BR_WRITE entry in the trail (auto OR manual).

### R11 — "Resolved" means: image was auto-fixed OR operator manually wrote a replacement

**Current state:** Resolution definition undefined.

**Target state:** A pid is "resolved" iff the trail TSV contains a `BR_WRITE` operation for it where the new_value differs from the original polluted value. Operator marking "accepted as-is" without changing the cell does NOT count as resolved (forces operator to either commit a real fix or escalate).

**Acceptance:** Resolution status query script returns `resolved=true` only when at least one BR_WRITE operation exists for the pid in the trail with `new_value != old_value`.

---

## Boundaries

### IN SCOPE

1. **Bestsellers-Ready only** (~460 unique pids across ~24k color/size rows)
2. **All 6 image columns:** `FrontImage`, `BackImage`, `DirectSideImage`, `ModelFrontImage`, `ModelSideImage`, `ModelBackImage`
3. **3 pollution classes:** content-mismatch, shape drift, model-image pollution
4. **Auto-fix sources:** S&S REST API (S* pids), CSW scraper (L* pids), Phase 10 AI regen, operator manual queue
5. **Drive folder operations** as needed to write/delete files (NOT folder restructuring per the OOS list)
6. **Audit trail** as a mandatory artifact, not optional
7. **Safety rails** (R8, R9) as code-level gates, not procedural checklist items

### OUT OF SCOPE

1. **Sheet1** (the 44,880-row master sheet) — separate scope, deferred to a future phase
2. **Store push** — phase writes to BR + Drive only. A separate push-from-BR workflow (existing `scripts/push-bestsellers-to-store.ts`) handles deployment of fixes to the live store. Operator runs that workflow at their discretion after Phase 16 closes.
3. **Headwear/caps** (H08* style ids) — Phase 15's verifier doesn't support headwear CategoryGroup. Caps are excluded from the audit set. Separate phase needed to add headwear support.
4. **Drive folder reorganization** (renaming/moving folders) — only file content updates and individual file writes/deletes are in scope.
5. **Adding new pids to BR** — phase fixes existing pids; doesn't add or promote new ones.
6. **Shared-URL pollution as a separate class** — folded into content-mismatch (a shared URL is detected structurally and resolved via the same Tier 1-3 flow). Not tracked as its own bucket in the TSV.

---

## Acceptance Criteria (10 pass/fail checks)

- [ ] **AC1** — Audit script produces `tmp/image-pollution-audit-{YYYY-MM-DD}.tsv` listing every polluted pid in BR with `pollution_class`, `affected_columns`, `affected_drive_urls`, `recommended_fix_tier`
- [ ] **AC2** — Audit covers all 6 image columns (FrontImage, BackImage, DirectSideImage, ModelFrontImage, ModelSideImage, ModelBackImage); test fixture confirms ModelImage pollution surfaces in output
- [ ] **AC3** — Tier-1 supplier fetch flow writes a verifier-passing replacement for at least one known content-mismatch pid; verifier-fail path leaves BR/Drive unchanged
- [ ] **AC4** — Tier-2 AI regen flow writes a verifier-passing back/side for at least one known shape-drift pid; 2-round retry cascade to Tier 3 works
- [ ] **AC5** — Tier-3 manual queue TSV produced; resolution requires `BR_WRITE` with `new_value != old_value`
- [ ] **AC6** — Manual queue size ≤ 20 after auto-fix completes; phase BLOCKS if larger
- [ ] **AC7** — Full trail TSV exists; row count matches BR_WRITE + DRIVE_UPLOAD + DRIVE_DELETE + SUPPLIER_FETCH + AI_REGEN + VERIFIER_PASS + VERIFIER_FAIL totals
- [ ] **AC8** — Re-audit run after fix returns 0 polluted pids OR every original-pid has a BR_WRITE entry in the trail
- [ ] **AC9** — Sheet1, store push, headwear pids are NOT touched (grep-verifiable: no writes to non-BR sheets; no calls to push scripts; H08* pids absent from audit set)
- [ ] **AC10** — Safety rails fire correctly: no Drive deletes without verifier-confirmed pollution; no BR overwrites without verifier-confirmed fix quality (unit tests on both gates)

---

## Constraints

- **Audit cost budget:** ~$0.30 - $1.00 in OpenAI Vision API calls (~460 pids × 4-6 Vision calls each at ~$0.0003)
- **Auto-fix cost budget:** No explicit cap; whatever supplier API + AI regen + verifier costs to drive the manual queue ≤ 20
- **Time budget:** Audit + auto-fix runtime ≤ 60 minutes (allows operator to inspect manual queue same-day)
- **Idempotency:** Re-running the audit + auto-fix must be safe — produces the same trail rows or no-ops for already-resolved pids
- **Headwear (H08*) hard exclusion** — verifier doesn't support beanie/cap CategoryGroups (separate phase)

---

## Ambiguity Report (final)

| Dimension | Final Score | Minimum | Status |
|-----------|-------------|---------|--------|
| Goal Clarity | 0.85 | 0.75 | ✓ |
| Boundary Clarity | 0.80 | 0.70 | ✓ |
| Constraint Clarity | 0.80 | 0.65 | ✓ |
| Acceptance Criteria | 0.80 | 0.70 | ✓ |

**Final Ambiguity: 0.18** (gate ≤ 0.20)

---

## Open questions for discuss-phase

The following remain at Claude's Discretion (or operator decision in discuss-phase) — SPEC.md does not constrain them:

1. **TSV column granularity** — exact field list, header naming, sort order
2. **Tier 1 supplier scraper additions** — if existing scrapers don't cover enough pids to hit ≤ 20 manual queue, planner decides which to add
3. **Front-image source-of-truth for verifier-after-fix** — use the current BR FrontImage, the supplier's canonical, or the operator's last-curated reference?
4. **Audit re-run mechanism** — automatic post-fix or manual `--re-audit` flag?
5. **Manual queue UI** — TSV with operator workflow doc, or a small CLI that walks them through each row?

---

*Phase 16: 16-catalog-image-pollution-audit-fix*
*Spec gathered: 2026-05-12 via Socratic interview (4 rounds)*
