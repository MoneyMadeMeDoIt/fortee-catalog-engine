# Phase 17 — Context decisions (pre-plan)

Decisions locked before `/gsd-plan-phase 17`. Researcher's recommendations accepted.

## D-17-01: fix-model-images.ts is a standalone script

The Model image rebuild (Plan 17-03) lives in its OWN script — `scripts/fix-model-images.ts` — rather than being a Tier 4 branch inside `scripts/fix-image-pollution.ts`.

**Why:** Model rebuild has materially different inputs (Model* columns, not Front/Back/DirectSide), different supplier API path (S&S `colorOnModel*` URLs), different verifier comparison semantics (model-with-garment vs garment-only), and different cost profile (~$6 worst-case for full 213-pid set). Cramming it into the existing orchestrator's tier ladder would obscure both flows.

**How to apply:** New script with its own CLI surface; reuse Phase 16 helpers (`appendTrailRow`, `verifySameProduct`, Drive helpers) and Phase 10's `generateModelImage` directly. Trail tier convention: use `tier=4` for Model rebuild ops so it's distinguishable from Phase 16's tier 1/2/3.

## D-17-02: 10-pid sample-test before full Model rebuild

Before running Plan 17-03 against the 213-pid corpus, run a 10-pid sample-test (~$0.30) to empirically validate that `generateModelImage` + `verifySameProduct` actually pass at acceptable rates. If sample pass-rate < 50%, fix orchestrator design before scaling.

**Why:** Phase 16 dry-run estimated Tier 1 yield at 36 pids; real yield was 1. We've already been bitten once by an unvalidated assumption. The verifier-pass-rate of AI-generated MODELS against `verifySameProduct` (which was tuned for garment-only comparisons) is empirically untested.

**How to apply:** Plan 17-03 has two sub-tasks: (a) 10-pid sample-test as a separate executable task with explicit pass-rate gate ("proceed iff ≥ 7/10 pids pass verifier"), (b) full 213-pid run gated on (a). If (a) fails, replan the verifier approach before running (b).

## Researcher's confidence on yield estimates

Treat ALL dry-run estimates with skepticism. Real Tier 1 yield in Phase 16 was 1 vs 36 estimated. For Phase 17:
- Plan for **50–100 Tier 1 fixes** after 17-02 (not 36)
- Sample-test 17-03 before committing to full run
- Track actual vs estimated in every plan summary

## Plan execution order (locked)

Per researcher's dependency analysis:
1. **17-01** (Drive timeout) — prerequisite to any large-scale run
2. **17-02** (per-color canonical) — fixes the "wrong color" rejections
3. **17-04** (D-12 prefix dispatcher widening) — unlocks adidas, B+C, Gildan, etc. via S&S routing. NO new scrapers needed (researcher's surprise finding).
4. **17-03** (Model rebuild) — sample-test first, then full run. Runs AFTER 17-02 so FrontImage references are fresh.
5. **17-05** (Manual triage) — operator effort on the residue.

## Minor cleanup (run anytime after 17-01)

- B-2: `--dry-run` Drive-trash gap in `fix-image-pollution-manual.ts`
- B-3: cleanup script `MANUAL/` blind spot
- B-4: OpenAI billing-hard-limit short-circuit in fix orchestrator Tier 2
