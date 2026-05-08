# Phase 15: Garment Type Verification - Context

**Gathered:** 2026-05-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Per-candidate Vision-based garment-type verification inside `generateGarmentView()` so AI-generated back/side images that drift to a different garment shape (e.g., crewneck → hoodie on pid A343) never reach Drive or the store. Plus a one-off retro audit script that flags wrong-shape images already uploaded — flag-only, no fixes.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**6 requirements are locked.** See `15-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `15-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- Per-candidate type-match check inside `generateGarmentView()`
- New helper that performs the Vision-based shape comparison
- Skip + TSV-log behavior when all candidates fail type-match
- Retro audit script that flags (does not fix) already-uploaded AI back/side images
- Unit tests covering candidate filtering, retry-on-all-fail, skip-on-total-fail, and the helper itself
- Acceptance fixture set of 5–10 hand-picked pids (≥1 per CategoryGroup) with expected pass/fail outcomes

**Out of scope (from SPEC.md):**
- AI-enhanced front images (`enhanceFrontImage`)
- Supplier-sourced images (CSW, S&S, OMG) at the in-pipeline check (note: retro script DOES scan all back/side regardless of source — see D-04)
- Any retroactive deletion or regeneration of wrong-shape images
- Changes to hue-drift logic, `scoreImageQuality`, or D-04 hue-fallback behavior
- Vision-call cost reporting / budget telemetry
- Sub-type drift detection (long-sleeve vs short-sleeve, boxy vs relaxed)

</spec_lock>

<decisions>
## Implementation Decisions

### Vision Verifier Design
- **D-01: Side-by-side two-image comparison.** `verifyGarmentTypeMatch(generatedBuffer, frontBuffer)` sends BOTH images in a single Vision API call and asks "are these the same garment family?" Returns `{ match: boolean, reason: string }`. Single call per candidate, no caption-string-compare fragility.
- **D-02: Coarse family match.** The verifier matches at the CategoryGroup level (`tops` | `hoodies` | `polos` | `crewnecks` | `jackets`). Long-sleeve vs short-sleeve, boxy vs relaxed, etc. all count as the same family — only major shape drift (the A343 hoodie-for-crewneck class) is rejected.
- **D-03: Vision model is `gpt-4o-mini`.** Matches the existing `describeGarment()` pattern in `src/lib/ai-image-generator.ts`. Cheap (~$0.0001/call). Verifier calls are not budgeted (per SPEC R5).

### Retro Audit Identification
- **D-04: Retro script scans ALL back/side images, not just AI-generated.** No identification heuristic needed — `scripts/audit-garment-types.ts` runs `verifyGarmentTypeMatch()` on every product's back and side regardless of whether they came from AI, supplier, or sheet URL. Mismatches go to a TSV regardless of source. This expands SPEC R6's coverage as a free side-effect (catches mislabeled supplier images too) and removes the ⚠ flag from R6 — identification mechanism is "no filtering needed."
- **D-05: Total cost cap is trivial.** ~283 products × 2 views × $0.0001/call ≈ $0.06 per full retro pass. No budget gating required.

### Rejects TSV Format
- **D-06: Path is `tmp/garment-type-rejects.tsv`.** Matches the existing imagery-audit pattern (`tmp/imagery-audit.tsv`, `tmp/contaminated-sides-unfixable.tsv`).
- **D-07: Columns: `pid | view | reason | timestamp | run_id`.** Tab-separated. Header row written on first write per run. Append across runs (no overwrite). `run_id` is an ISO-8601 timestamp captured once at the start of the audit invocation so a single run's rows can be filtered out.

### Fixture Set
- **D-08: Location: `tests/fixtures/garment-type/`.** Labels file at `tests/fixtures/garment-type/labels.json` mapping pid → `{ expected_category, front_path, back_path, side_path, expected_match: { back: bool, side: bool } }`. Image buffers stored at `tests/fixtures/garment-type/{pid}-{view}.png`.
- **D-09: Composition: A343 + 1 known-good per CategoryGroup = 6 minimum.** A343 is mandatory (regression case from `project_garment_classifier.md` memory; back+side both expected `match: false`). Known-good fixtures are picked by the planner from products with current passing back/side images — 1 each from `tops`, `hoodies`, `polos`, `crewnecks`, `jackets`. Expandable to 10 if more A343-class regressions are surfaced during plan-phase research.

### Test Strategy
- **D-10: Unit tests with mocked OpenAI (Phase 10 pattern).** `tests/lib/ai-image-generator.test.ts` (extend) covers:
  - Candidate filter logic (mixed mock candidates, only type-passing survives)
  - Strict AND predicate (no winner if hue OR type fails)
  - Round 2 retry trigger (round 1 all-fail → round 2 fires)
  - Skip + TSV-log on total fail (all 6 fail → returns null + 1 TSV row)
  - CostTracker not decremented by verifier calls
- **D-11: Fixture-based test calls real `gpt-4o-mini`.** New file `tests/lib/garment-type-verifier.test.ts`. Runs `verifyGarmentTypeMatch()` against stored buffers in `tests/fixtures/garment-type/`. Gated on `process.env.OPENAI_API_KEY` — `it.skipIf(!process.env.OPENAI_API_KEY)` so CI without the key skips silently. Asserts `match: false` for A343 and `match: true` for each known-good fixture.

### Claude's Discretion
- Exact Vision prompt wording for `verifyGarmentTypeMatch()` — researcher experiments with phrasings and the planner picks the winner based on fixture-set pass-rate.
- Whether the rejects TSV deduplicates rows when the same product is re-run — planner decides based on whether re-runs are common.
- Whether `run_id` is the audit invocation start time, a UUID, or something else — planner picks; just must be stable for one audit pass.
- Where in `generateGarmentView()` the type-check is wired in — alongside hue check in `scoreCandidates()` or as a separate filter after — implementation detail.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Locked Requirements
- `.planning/phases/15-garment-type-verification/15-SPEC.md` — Locked requirements, boundaries, acceptance criteria. MUST read before planning.

### Existing AI Generation Pipeline (this phase modifies it)
- `src/lib/ai-image-generator.ts` — `generateGarmentView()` is the function being modified. `describeGarment()` (line 35) shows the existing gpt-4o-mini Vision pattern to mirror in the verifier.
- `src/lib/ai-image-types.ts` — `AIView`, `GenerateViewResult`, `CANDIDATES_PER_CALL`, `HUE_DRIFT_THRESHOLD` constants.
- `src/lib/cost-tracker.ts` — `CostTracker` class (verifier calls bypass `canAfford()` and `record()`, per SPEC R5).
- `src/lib/prompt-templates.ts` — Existing prompt builders (the verifier may need its own prompt template here).
- `src/lib/hue-utils.ts` — Hue check pattern; type check filter mirrors its structure.

### Audit Pipeline Integration
- `src/lib/audit-runner.ts` — Calls `generateGarmentView()` at line 304. Already handles `null` return as a skip; no changes needed there for in-pipeline behavior.
- `src/shopify/image-scorer.ts` — `scoreImageQuality()` and `CategoryGroup` type used in scoring.
- `src/shopify/types.ts` — `CategoryGroup = 'tops' | 'hoodies' | 'polos' | 'crewnecks' | 'jackets'` (line 102).

### Test Patterns
- `tests/lib/audit-runner.test.ts` — Existing audit-runner tests; new tests follow same Vitest + mocked OpenAI patterns.
- `tests/lib/prompt-templates.test.ts` — Prompt-template test pattern.

### Prior Phase Decisions (Phase 10 — relevant)
- `.planning/phases/10-ai-image-generation/10-CONTEXT.md` — D-04 (hue-fallback "return best") behavior is preserved unchanged for hue; type-match has its own skip-on-total-fail path. D-07 (CostTracker) gates only `images.edit()` calls, not verifier calls.

### Project-Level
- `.planning/REQUIREMENTS.md` — AIGEN-01 through AIGEN-04 are the parent v2.0 requirements.
- Memory: `project_garment_classifier.md` — Documents the A343 regression case.

### Patterns for Retro Script
- `tmp/imagery-audit.tsv`, `tmp/contaminated-sides-unfixable.tsv` — Existing TSV output convention to mirror.
- `scripts/audit-images.ts` — Existing audit CLI structure to mirror for `scripts/audit-garment-types.ts`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `describeGarment()` in `src/lib/ai-image-generator.ts:35` — gpt-4o-mini Vision pattern is the template for `verifyGarmentTypeMatch()`. Same OpenAI client factory, same base64 image encoding, same JSON-prompt structure.
- `scoreCandidates()` in `src/lib/ai-image-generator.ts:151` — Existing per-candidate scoring loop is the natural insertion point for type-match check; result struct already accumulates per-candidate verdicts.
- `CostTracker` — Inject into verifier ONLY for visibility; do NOT call `canAfford()` or `record()`.
- Vitest mocked-OpenAI pattern from Phase 10 tests — Reuse for unit tests of filter logic.

### Established Patterns
- Vision calls go through `client.chat.completions.create({ model: 'gpt-4o-mini', ... })` with base64 data URLs in `image_url` content blocks.
- Functions return typed results (`{ match, reason }` shape mirrors `GenerateViewResult`).
- Errors are non-fatal with `logger.warn(...)` and a fallback (e.g., `describeGarment` returns empty string on error). Verifier should follow: on Vision API failure, log warning and treat candidate as `match: true` (don't reject candidates because the verifier itself broke — that would worsen reliability).
- TSV outputs go to `tmp/` with tab-separated columns and a header row.

### Integration Points
- `generateGarmentView()` already filters candidates by hue + quality. Type-match is a third filter in the same per-candidate scoring step.
- `audit-runner.ts:304` already handles `generateGarmentView()` returning `null` as a skip — no audit-runner changes needed for the skip-on-total-fail path.
- Retro audit script is a new file at `scripts/audit-garment-types.ts` and follows `scripts/audit-images.ts` CLI conventions.

</code_context>

<specifics>
## Specific Ideas

- **A343 is the canonical regression test.** Stored memory `project_garment_classifier.md` cites this pid (a crewneck) generating hoodie back/side. Acceptance criterion 1 in SPEC.md requires this pair be caught.
- **Verifier failure should not falsely reject.** If the Vision API itself errors, log warning and let the candidate through (treat as match=true). The cost of false-rejecting valid candidates is wasted generation budget; the cost of false-accepting is one wrong image. We've chosen to trust the existing hue+quality filters when the verifier breaks.
- **Side-by-side comparison was preferred over caption-then-classify** because the user wants the model to see both images directly rather than rely on caption fidelity.

</specifics>

<deferred>
## Deferred Ideas

- **Verifier on AI-enhanced fronts.** `enhanceFrontImage()` could in theory drift the front to a different garment, but it uses the real garment image as input. The user explicitly scoped this phase to back/side only — adding front coverage is a future phase if a regression appears.
- **Sub-type drift detection.** Long-sleeve vs short-sleeve, boxy vs relaxed crewnecks. Coarse family match is sufficient for v1. If false-accepts emerge during retro audit, a future phase can tighten the granularity.
- **Retro REMEDIATION (delete + regenerate the bad ones).** SPEC R6 is flag-only. Once the retro TSV exists, a follow-up phase can act on the rows.
- **Verifier cost telemetry.** Currently bypasses CostTracker entirely. If Vision spend ever becomes meaningful, a future phase can add separate tracking.

</deferred>

---

*Phase: 15-garment-type-verification*
*Context gathered: 2026-05-08*
