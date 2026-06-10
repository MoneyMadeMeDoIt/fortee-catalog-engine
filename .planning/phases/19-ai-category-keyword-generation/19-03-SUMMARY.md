# Phase 19-03 — Live Apply Summary

**Completed:** 2026-06-10
**Status:** Phase 19 COMPLETE (operator-approved live apply)

## What ran
Operator approved the live `--force --apply` after reviewing the full dry-run preview at the checkpoint.

- Model: OpenAI **gpt-4o-mini** (operator chose OpenAI; existing key). One structured `chat.completions` call per product, lenient extraction + downstream getCategoryGroup gate.
- Backup written first: `tmp/gen-cat-kw-backup-2026-06-10T19-12-30-259Z.tsv` (24,174 rows).
- **461/461 products classified, 0 failures.**
- **58,684 cells written** (15,809 new + 42,875 overwritten) across `baseCategory` / `categories` / `keywords` on Bestsellers-Ready, in 2 chunked batches.
- **95 accessories/headwear flagged** → baseCategory left unchanged (D-07; never forced into a printable garment, e.g. fleece toque stays an accessory).

## Verification (success criteria)
1. Dry-run preview produced + reviewed at operator checkpoint ✓
2. `--apply` wrote all three columns per product; backup written first ✓
3. baseCategory only changed to getCategoryGroup-safe values (242 changed); accessories left unchanged (95) ✓ — no push-breaking values
4. Keywords lowercase-hyphen, audience-preserved, no color/size/style#/GSM/jargon (two-layer clean) ✓
5. Idempotent: non-force re-run skips 453/461 (cell-filled); checkpoint covers the rest ✓
6. Live spot-check: 4651 "Long Sleeve Shirts", A702 "Polo Shirts", NE220 "Hoodies", H08010 beanie baseCategory empty/unchanged + taxonomy "Beanies" ✓

## Notes / deferred
- `--apply` re-runs the model (checkpoint stores pids, not results), so written values are fresh classifications of equivalent quality to the preview, not byte-identical (AI non-determinism).
- 8 accessory products with structurally-empty baseCategory re-process on a checkpoint-cleared non-force run (harmless churn on categories/keywords); the apply's checkpoint avoids this in normal operation.
- Shopify push wiring of the taxonomy categoryId + tags remains deferred (v2/PUSH-01, PUSH-02).
