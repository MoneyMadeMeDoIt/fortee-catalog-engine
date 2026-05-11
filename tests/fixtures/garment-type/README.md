# Garment Type Verifier — Fixture Set

Phase 15 / Plan 04 real-API fixture tests for `verifyGarmentTypeMatch()`.

## Purpose

Validates `verifyGarmentTypeMatch()` (`src/lib/ai-image-generator.ts`) against
real gpt-4o-mini Vision responses on a hand-curated set of `(front, back, side)`
PNG triples. Tests assert the verifier's pass/fail outcomes match the
hand-labeled `expected_match` in `labels.json`.

## Sourcing

- **A343** binaries come from Drive. Use `row.FrontImage` / `row.BackImage` /
  `row.DirectSideImage` for pid `A343` (the canonical regression case — a
  crewneck whose AI back/side came out as hoodies; both back and side are
  expected `match: false`).
- **5 known-good fixtures** are picked by the Plan 04 Wave 0 executor from
  products with current passing back/side per the CategoryGroup distribution
  (`tops`, `hoodies`, `polos`, `crewnecks`, `jackets`). All expected
  `match: true` for back and side.

## Format

- 1024×1024 PNG preferred. Smaller is acceptable.
- White background, garment centered, no model body parts (matches AI
  generation output format).

## File Layout

Each fixture image is named `{pid}-{view}.png` exactly matching the
`*_path` fields in `labels.json`:

```
tests/fixtures/garment-type/
  labels.json
  README.md  (this file)
  A343-front.png
  A343-back.png
  A343-side.png
  FIXTURE-tops-01-front.png
  ...
```

## What is Committed Here vs Plan 04

This plan (15-01) commits **only** `labels.json` + this `README.md` so
downstream plans (02, 03, 04) have a stable schema to import. The PNG
binaries themselves are deferred to Plan 04 Wave 0 — that plan's
executor sources A343 from Drive, picks the 5 known-good pids, and
captures the 18 PNGs (6 pids × 3 views).
