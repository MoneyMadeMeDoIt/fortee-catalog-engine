# Phase 15: Garment Type Verification — Specification

**Created:** 2026-05-08
**Ambiguity score:** 0.17 (gate: ≤ 0.20)
**Requirements:** 6 locked

## Goal

The AI image generator (`generateGarmentView()`) rejects candidate back/side images whose garment type does not match the source front image, so products like pid A343 (a crewneck) never receive hoodie-shaped back/side outputs in Drive or the store.

## Background

`src/lib/ai-image-generator.ts` already runs `describeGarment()` (gpt-4o-mini Vision) against the **source front image** to build the generation prompt. After OpenAI returns 3 candidates per call, the generator filters them only by hue drift (`HUE_DRIFT_THRESHOLD`, 15°) and quality (`scoreImageQuality`). There is **no check that the output's garment shape matches the source.** A regression case is documented: pid A343 is a crewneck, but generated back/side images came out as hoodies. The audit-runner (`src/lib/audit-runner.ts:304`) accepts the generator's return at face value — by the time the candidate is selected, the wrong-shape image is already on its way to Drive.

This phase adds a per-candidate type-match check inside `generateGarmentView()`, plus a one-off retro audit script that flags wrong-shape AI images already uploaded.

## Requirements

1. **Per-candidate type check**: `generateGarmentView()` filters out candidates whose garment type differs from the source front image, before scoring picks a winner.
   - Current: Each of the 3 candidates is filtered only by hue drift + quality verdict; no garment-shape comparison happens.
   - Target: For every candidate, a Vision-based comparison answers "is this the same kind of garment as the source front?" Mismatched candidates are excluded from the winner-selection set, just like hue-failing ones today.
   - Acceptance: A unit test passes: given a stub OpenAI client returning 3 candidates where 2 are hoodie-shaped and 1 is crewneck-shaped, with a crewneck source front, the function returns the crewneck candidate (not a hoodie).

2. **Reference signal is the source front image**: The verifier compares the generated image to the source front image, not to a sheet column.
   - Current: No verifier exists. Where the existing prompt uses garment type, it pulls from `categoryGroup` (sheet) or `describeGarment()` (front-image caption). The latter is the design used here.
   - Target: A new helper (e.g., `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)`) returns `{ match: boolean, reason: string }`, deciding via a Vision API call whether both images depict the same garment family.
   - Acceptance: With a known crewneck front and a hoodie generated buffer (from A343 regression case), the helper returns `{ match: false, ... }`. With a crewneck front and a crewneck generated buffer, it returns `{ match: true, ... }`.

3. **Retry behavior unchanged in shape, expanded in trigger**: The existing 2-round retry logic also fires when type-match fails for all candidates in a round.
   - Current: Round 2 (retry with stronger prompt) only fires when zero candidates pass the hue check.
   - Target: Round 2 fires when zero candidates pass **both** hue and type-match checks. Same call budget, same prompt-building path, no additional API calls beyond the existing retry round and the per-candidate verifier calls.
   - Acceptance: A unit test where round 1 returns 3 candidates that all fail type-match shows round 2 being invoked; a test where round 1 returns 1 type-match-passing candidate shows round 2 NOT invoked.

4. **Skip + log on total failure (no D-04 fallback for type)**: If all 6 candidates across both rounds fail type-match, the view is skipped and the product is logged for human review — the generator does NOT return a knowingly-wrong-shape image.
   - Current: D-04 fallback returns the best-scoring candidate even when all fail hue check.
   - Target: When all 6 candidates fail type-match, `generateGarmentView()` returns `null` (the audit-runner treats `null` as "skipped — no upload"). The pid + view + reason are appended to a TSV (path TBD in plan-phase, e.g. `tmp/garment-type-rejects.tsv`) so the operator can review.
   - Acceptance: A unit test where all 6 candidates fail type-match returns `null` and writes one row to the rejects TSV with pid, view, and reason. The audit-runner's existing skip path handles the `null` without crashing.

5. **Vision verification calls are not budget-gated**: Type-match Vision calls run unconditionally per candidate; they do not consume the `CostTracker` budget that gates `images.edit()` calls.
   - Current: `costTracker.canAfford(...)` gates only image generation; no Vision spend tracking exists.
   - Target: Verifier calls bypass `CostTracker.canAfford()` and `record()`. Every AI back/side generation that produces candidates also produces verifier calls, even when the budget is below the per-candidate generation cost.
   - Acceptance: A unit test in which `costTracker.canAfford()` returns `false` after round 1 still shows verifier calls happening on round-1 candidates; the cost tracker's running total is not incremented by verifier calls.

6. **Retro audit script for already-uploaded AI back/side images**: A one-off script verifies historical AI-generated back/side images uploaded to Drive and writes a TSV of mismatches for human review.
   - Current: ~283 bestsellers and any prior runs have AI-generated images on Drive/store with no shape verification. The known A343 case is documented but not the only one.
   - Target: A new script (e.g., `scripts/audit-garment-types.ts`) iterates products with AI-generated views (status=`generated`, identified from audit logs or by sheet inspection), downloads the back/side from CDN URLs, runs `verifyGarmentTypeMatch` against each product's stored front, and writes mismatches to a TSV (pid, view, drive-url, reason). The script does NOT delete or re-generate — it only flags.
   - Acceptance: Running the script on a fixture set including A343 produces a TSV row for A343's back and side (mismatch). Running it on a known-good product produces zero rows for that product.

## Boundaries

**In scope:**
- Per-candidate type-match check inside `generateGarmentView()`
- New helper that performs the Vision-based shape comparison
- Skip + TSV-log behavior when all candidates fail type-match
- Retro audit script that flags (does not fix) already-uploaded AI back/side images
- Unit tests covering candidate filtering, retry-on-all-fail, skip-on-total-fail, and the helper itself
- Acceptance fixture set of 5–10 hand-picked pids (≥1 per CategoryGroup) with expected pass/fail outcomes

**Out of scope:**
- AI-enhanced front images (`enhanceFrontImage`) — same bug class is theoretically possible but the user explicitly chose to scope to back/side only
- Supplier-sourced images (CSW, S&S, OMG) — even when mislabeled, those are not in this phase's scope
- Any retroactive deletion or regeneration of wrong-shape images — the retro script flags only; remediation is a separate operator decision
- Changes to hue-drift logic or `scoreImageQuality` — unchanged
- D-04 fallback behavior on hue failures — unchanged; this phase only changes the failure path for **type** mismatches
- Vision-call cost reporting / budget telemetry — verifier calls are explicitly outside the existing `CostTracker`
- Sub-type drift detection (e.g., long-sleeve crewneck → short-sleeve crewneck) — coarse garment-family match is sufficient

## Constraints

- The verifier must use the **source front image** as its reference signal — not the sheet `CategoryGroup` column. (User decision.)
- Verifier calls must NOT decrement `CostTracker`. (User decision.)
- Skip behavior on total type-match failure must NOT inherit the D-04 "return best anyway" fallback used for hue failures. The output of `generateGarmentView()` for a type-failed view is `null`, and the audit-runner's existing skip path handles `null`.
- The retro audit script must be flag-only — it must not delete, modify, or regenerate any image, and must not write to Drive or Sheets.
- Test fixture set must cover ≥1 product per CategoryGroup (`tops`, `hoodies`, `polos`, `crewnecks`, `jackets`).

## Acceptance Criteria

- [ ] `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)` returns `{ match: false, ... }` for the A343 regression pair (crewneck front + hoodie generated buffer).
- [ ] `verifyGarmentTypeMatch` returns `{ match: true, ... }` for a known-good crewneck front + crewneck back pair (positive control).
- [ ] On a curated fixture set of 5–10 pids spanning all 5 CategoryGroups, the verifier's pass/fail outcomes match the hand-labeled expectations.
- [ ] `generateGarmentView()` excludes type-mismatched candidates from winner selection (unit test with mixed mock candidates).
- [ ] When all 6 candidates fail type-match, `generateGarmentView()` returns `null` and appends a row to the rejects TSV.
- [ ] When `CostTracker` is exhausted, verifier calls still run on already-fetched candidates (their cost is not budget-gated).
- [ ] `enhanceFrontImage` is unchanged — no verifier call is added on the front-enhancement path.
- [ ] `scripts/audit-garment-types.ts` runs end-to-end on a fixture set, writes a TSV with one row per detected mismatch, and does not write to Drive or Sheets.
- [ ] A re-audit of pid A343 with this phase shipped produces either a correctly-shaped crewneck back/side or skipped views — never hoodie-shaped output.

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                            |
|--------------------|-------|------|--------|--------------------------------------------------|
| Goal Clarity       | 0.88  | 0.75 | ✓      | Trigger, source-of-truth, hook point all locked  |
| Boundary Clarity   | 0.85  | 0.70 | ✓      | AI back/side only; explicit exclusions for enhance + sourced |
| Constraint Clarity | 0.70  | 0.65 | ✓      | No budget gating; flag-only retro                |
| Acceptance Criteria| 0.85  | 0.70 | ✓      | A343 + positive + 5–10 fixture set               |
| **Ambiguity**      | 0.17  | ≤0.20| ✓      |                                                  |

## Interview Log

| Round | Perspective     | Question summary                                | Decision locked                                     |
|-------|-----------------|-------------------------------------------------|-----------------------------------------------------|
| 1     | Researcher      | What signals "right" for the checker?           | Compare against source front image (not sheet)      |
| 1     | Researcher      | When in the pipeline does the check run?        | Per-candidate, immediately after OpenAI returns 3   |
| 1     | Failure Analyst | What if all 6 candidates fail?                  | Skip view + log to follow-up TSV; no D-04 fallback  |
| 2     | Boundary Keeper | Coverage scope?                                 | AI-generated back/side ONLY (not enhance, not sourced) |
| 2     | Researcher      | Cost-budget integration?                        | Verifier calls NOT budget-gated; always run         |
| 3     | Boundary Keeper | Retroactive scope for already-uploaded?         | Going forward + separate flag-only retro script     |
| 3     | Failure Analyst | What proves the checker works?                  | A343 + positive case + 5–10 fixture set per CategoryGroup |

---

*Phase: 15-garment-type-verification*
*Spec created: 2026-05-08*
*Next step: /gsd-discuss-phase 15 — implementation decisions (Vision prompt design, TSV path/format, fixture-set composition, retry-trigger predicate)*
