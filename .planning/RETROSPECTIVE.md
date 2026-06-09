# Project Retrospective — Fortee Catalog Engine

## Milestone: v2.0 — Image Automation

**Shipped:** 2026-06-09
**Phases:** 10 dirs (08–17) | **Plans:** ~13 roadmap-tracked + ad-hoc

### What Was Built
End-to-end product imagery automation: quality scoring (08), multi-supplier sourcing (09), AI back/side generation (10), 85%-height standardization + safe upload (11), an audit runner (12) and CLI (13), then three reactive phases that emerged from real catalog state — BR↔Drive↔Store reconciliation (14), garment-type verification (15), and catalog image-pollution audit + fix (16–17). Closed with the Complete-Bestsellers Drive finalize standardizing every pid folder to `{Brand}-{pid}-{Color}-{Role}.png`.

### What Worked
- **Verify-don't-trust**: the finalize rule "confirm with a dry-run plan=0, never trust the checkpoint" caught that the checkpoint alone wasn't proof of completion.
- **Classify-then-apply** (TSV-driven Drive mutation in 14): review every action before applying beat per-folder ad-hoc cleanup — 191 mutations, 0 errors, all explainable.
- **Fail-loud helpers** (`resolveStoreProduct` throws on >1 match) closed a whole silent-pick bug class.

### What Was Inefficient
- Phases 14/16/17 were added as directories but never registered in ROADMAP.md, so milestone state drifted (GSD still thought v2.0 was open with un-archived phases at close time).
- 17-03 Model* AI rebuild was abandoned mid-stream — the verifier doesn't catch view-mismatch (front images labeled as side/back pass), forcing a pivot to an operator-driven manual+AI workflow.

### Patterns Established
- Operator-checkpoint gates for blocking human-verify steps (Phase 16 driver pattern).
- Drive filename canonicalization as a discrete pre-processing step, decoupled from sheet writes.

### Key Lessons
- Register ad-hoc phases in ROADMAP.md when created, or milestone bookkeeping silently drifts.
- AI generation needs an independent view/identity check; garment-shape verification alone is insufficient.
- The OpenAI monthly *usage cap* (separate from balance) is a recurring blocker — raise it before AI batches.

## Cross-Milestone Trends

| Milestone | Shipped | Phases | Theme |
|-----------|---------|--------|-------|
| v1.0 MVP | 2026-03-26 | 6 | Sheet → Shopify push pipeline |
| v2.0 Image Automation | 2026-06-09 | 10 | Imagery quality, generation, standardization, pollution cleanup |
