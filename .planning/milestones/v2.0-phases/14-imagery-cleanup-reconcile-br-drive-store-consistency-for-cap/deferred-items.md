# Phase 14 Deferred Items

Out-of-scope discoveries logged during execution per executor scope-boundary rule.

## Pre-existing TypeScript errors in test file

**File:** `tests/scripts/audit-images.test.ts`
**Type:** Test-only TypeScript mock-typing errors
**Discovered during:** Plan 14-01 typecheck verification
**Why deferred:** Errors are pre-existing in this test file — none introduced by Plan 14-01 changes (resolve-store-product.ts, audit-product-imagery.ts, dedupe-drive-duplicates.ts). Per scope-boundary rule, only fix issues directly caused by the current task's changes.

Sample errors:
- `tests/scripts/audit-images.test.ts(186,7)`: `Type 'Mock<Procedure | Constructable>' is not assignable to type '(row: SheetRow, ...) => Promise<...>'`
- `tests/scripts/audit-images.test.ts(194,48)`: `Parameter 'c' implicitly has an 'any' type`
- ~10 similar mock-binding errors

**Fix scope:** Update vitest mock typings in test file to match production signatures. Should be a separate cleanup task, not in Phase 14.

## DUPE-DRIVE leftovers (9 rows, 4 pids)

**File:** `tmp/dedupe-leftovers.tsv`
**Type:** Audit category not closed
**Discovered during:** Plan 14-01 Task 3b post-audit
**Why deferred:** The 9 remaining DUPE-DRIVE rows are a different naming category than the 142 supplier-original duplicates that Plan 14-01 targeted:
- `1275InnwerW-*-HIRes.jpg` (no canonical `_std.png` sibling)
- `BELLA_+_CANVAS_4610_*` (DirectSide vs Side_Model and Back vs Back_Model pairs without canonicals)
- `Next_Level_9002_Heather_Black_Front_*` (High vs High_Model)
- `Next_Level_3911_Heather_Grey_*` (DirectSide vs Side_Model and Back vs Back_Model and Front vs Front_Model)

These all lack the `canonicalExists` guard that the dedupe script requires — they would need either canonical-version generation first or a different reconciliation pattern. Out of scope for 14-01 (helper + extension foundations only).

**Fix scope:** Address in a follow-up plan — likely 14-02 (BR-Drive-Store reconciliation) or a phase 15 item.
