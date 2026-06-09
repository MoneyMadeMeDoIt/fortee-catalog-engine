# Phase 12: Audit Runner - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 12-audit-runner
**Areas discussed:** Pipeline flow decisions

---

## Pipeline Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Score → source → generate → standardize | Linear pipeline, one product at a time | ✓ |
| Score → source+generate per view | Process each view independently | |
| Batch: score all, source all, generate all | Three passes over product | |

**User's choice:** Linear pipeline (score → source all missing/failed → generate remaining → standardize)

### Follow-up: Skip Logic

| Option | Description | Selected |
|--------|-------------|----------|
| Skip entirely if all pass | Don't touch products with passing images | |
| Re-standardize anyway | Always run through 85% standardization even if quality passes | ✓ |
| Skip scoring, standardize only | Don't score, just standardize everything | |

**User's choice:** Re-standardize anyway — existing images may not be at correct 85% scale

---

## Logging and Reporting

Not discussed — Claude's discretion (structured JSON per product recommended).

## Claude's Discretion

- Logging format and structure
- How to fetch existing product images for scoring
- Error handling per pipeline step
- Return value from auditProductImages()
- CostTracker wiring across products
- Internal function decomposition

## Deferred Ideas

- Shopify GID-based media replacement (from Phase 11)
- Contextual on-model photos (from Phase 08)
