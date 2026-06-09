# Phase 15: Garment Type Verification - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-08
**Phase:** 15-garment-type-verification
**Areas discussed:** Vision verifier design, R6 retro identification mechanism, Mechanical defaults (TSV format, fixture set, test strategy)

---

## Vision Verifier Design

### Q1: How should the Vision check work — one API call or two?

| Option | Description | Selected |
|--------|-------------|----------|
| Two-image side-by-side comparison | Send BOTH source front AND generated candidate to Vision in a single call. Asks "are these the same garment family?" Most accurate. | ✓ |
| Caption-then-classify | Reuse existing describeGarment() caption + 1 Vision call per candidate to verify match. Cheaper but relies on caption fidelity. | |
| Two captions + string compare | Generate two captions independently and compare strings/embeddings. Most expensive and fragile. Not recommended. | |

**User's choice:** Two-image side-by-side comparison
**Notes:** User wants the model to see both images directly rather than rely on caption fidelity.

### Q2: How strict should 'same garment' be?

| Option | Description | Selected |
|--------|-------------|----------|
| Coarse family match | Match at CategoryGroup level. Long-sleeve vs short-sleeve crewneck = match (both crewneck). Catches A343 hoodie-for-crewneck without false-positives on style variations. | ✓ |
| Strict shape match | Long-sleeve ≠ short-sleeve. Boxy ≠ relaxed. More precise but generates many more rejects. Risk of false rejects burning generation budget. | |

**User's choice:** Coarse family match
**Notes:** Sufficient for the A343 bug class; tighter granularity deferred.

---

## R6 Retro Identification Mechanism

### Q3: How does the retro script know which uploaded back/side images came from AI generation?

| Option | Description | Selected |
|--------|-------------|----------|
| 'No supplier coverage' delta | Re-run sourceImages(); if it returned NULL for back/side at audit time, the view was AI-generated. Zero new infra. | |
| Scan all back/side and let TSV filter | Run verifyGarmentTypeMatch on EVERY back/side regardless of source. ~$0.06 per full pass. Simplest; catches mislabeled supplier images too. | ✓ |
| Mark AI generations in sheet going forward, retro = scan-all | Hybrid: future runs are precise via new sheet column, past runs are exhaustive scan-all. | |

**User's choice:** Scan all back/side and let TSV filter
**Notes:** Removes the ⚠ flag from SPEC R6 — identification mechanism is "no filtering needed." Free side-effect: catches bad supplier-sourced images too.

---

## Mechanical Defaults (Claude proposed, user confirmed)

### Q4: Defaults look right?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — lock them all | Vision model gpt-4o-mini, TSV at tmp/garment-type-rejects.tsv with 5 columns, fixture set under tests/fixtures/garment-type/, unit tests mocked + fixture-based test gated on OPENAI_API_KEY. | ✓ |
| Tweak one or more | I'll list each one again and you can change individual choices. | |

**User's choice:** Yes — lock them all
**Notes:** All five defaults locked: model, TSV path, TSV columns, fixture location, test strategy.

---

## Claude's Discretion

- Exact Vision prompt wording for `verifyGarmentTypeMatch()` — researcher experiments and the planner picks the winner based on fixture-set pass-rate.
- Whether the rejects TSV deduplicates rows when the same product is re-run — planner decides based on whether re-runs are common.
- Whether `run_id` is the audit invocation start time, a UUID, or something else — planner picks; just must be stable for one audit pass.
- Where in `generateGarmentView()` the type-check is wired in — alongside hue check in `scoreCandidates()` or as a separate filter after — implementation detail.
- Picking the 5 known-good fixture pids (1 per CategoryGroup) — planner selects from products with current passing back/side images.

## Deferred Ideas

- Verifier on AI-enhanced fronts (out of scope per SPEC; scoped to back/side only).
- Sub-type drift detection (long-sleeve vs short-sleeve, boxy vs relaxed) — coarse family match sufficient for v1.
- Retro REMEDIATION (delete + regenerate flagged images) — SPEC R6 is flag-only; remediation is a follow-up phase.
- Verifier cost telemetry — currently bypasses CostTracker; deferred until/unless Vision spend becomes meaningful.
