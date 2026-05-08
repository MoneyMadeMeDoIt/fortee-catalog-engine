---
phase: 14-imagery-cleanup
plan: 01
subsystem: imagery-reconciliation
tags: [shopify, drive, dedupe, audit, supplier-prefix, helper, throw-on-multi]

# Dependency graph
requires:
  - phase: 13-cli-entry-point
    provides: Shopify client factory and logger primitives reused by resolveStoreProduct
provides:
  - resolveStoreProduct helper enforcing exactly-one-match semantics for pid → handle lookups
  - KNOWN_SUPPLIER_PREFIXES allowlist for the cross-pollution audit check
  - Extended STRAY_PATTERNS in dedupe-drive-duplicates covering 3 supplier-original naming families
  - 142 supplier-original Drive duplicates trashed across 20 product folders
  - tmp/dedupe-leftovers.tsv documenting 9 unresolved DUPE-DRIVE rows (different naming category)
affects: [14-02 BR-Drive-Store reconciliation, 14-03 store push remediation, future imagery audits]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "throw-on-multi resolver pattern: explicit error classes (NoStoreProductError, MultipleStoreProductsError) replace silent first-match"
    - "supplier-prefix allowlist: per-pid Record<pid, prefixes[]> entries gate the cross-pollution check"
    - "extended STRAY_PATTERNS guarded by canonicalExists: dedupe only matches dupes that have a canonical _std.png sibling"

key-files:
  created:
    - src/shopify/resolve-store-product.ts
    - tmp/dedupe-leftovers.tsv
  modified:
    - scripts/audit-product-imagery.ts
    - scripts/dedupe-drive-duplicates.ts

key-decisions:
  - "Helper filters by last hyphen-segment === pid (case-insensitive) to drop substring matches like richardson-trucker-1683 when searching for 168"
  - "Cross-pollution allowlist keyed by pid (not global) so adding a per-supplier prefix is explicit and reviewable"
  - "Live trash with --apply gated behind dry-run review checkpoint (user approved 142 candidates)"
  - "9 leftover DUPE-DRIVE rows documented as accepted-variance (different naming family without canonical siblings — future plan scope)"
  - "NODE_OPTIONS=--use-system-ca needed on Node v24 to verify Google OAuth cert (corporate root CA in Windows store)"

patterns-established:
  - "Pid resolution: every imagery script that takes a pid arg should call resolveStoreProduct() instead of hand-rolled handle:* queries to prevent silent first-match drift"
  - "Audit cross-pollution: when a supplier ships brand-prefix filenames (e.g. Richardson_168_*), add a KNOWN_SUPPLIER_PREFIXES entry rather than relaxing the global pid-prefix rule"
  - "Drive dedupe: extend STRAY_PATTERNS only when canonicalExists guard guarantees a sibling — never broaden the regex to catch dupes without a keeper"

requirements-completed:
  - R1.5000-recon
  - R2.sibling-invariant
  - R5.168-cross
  - R4.dupe-round2
  - R10.audit-extension

# Metrics
duration: ~25min (across multiple agent sessions including the dry-run checkpoint pause)
completed: 2026-05-08
---

# Phase 14 Plan 01: Imagery Cleanup Foundations Summary

**resolveStoreProduct helper with throw-on-multi semantics, KNOWN_SUPPLIER_PREFIXES allowlist for cross-pollution audit, and 142 supplier-original Drive duplicates trashed across 20 folders.**

## Performance

- **Duration:** Plan execution spanned multiple sessions; final task (3b live trash + audit + summary) ≈ 8 minutes
- **Started:** 2026-05-08T07:51:00Z (Task 1 commit)
- **Completed:** 2026-05-08T13:55:00Z (this summary)
- **Tasks:** 4 (Tasks 1, 2, 3a, 3b — checkpoint resolved with `approve`)
- **Files modified:** 3 source files + 1 documentation TSV

## Accomplishments

- `resolveStoreProduct(client, pid)` ships with explicit `NoStoreProductError` and `MultipleStoreProductsError` classes, replacing the silent `first: 1` pattern that caused the 5000-handle drift
- Smoke test against pid 5000 confirms helper returns `unisex-heavy-cotton-t-shirt-5000` (raw 3 → surviving 1 after segment filter)
- Audit cross-pollution check now respects `KNOWN_SUPPLIER_PREFIXES['168']` containing `Richardson_168_` — pid 168 audit reports 0 CROSS-POLLUTION rows (was 36 false positives)
- Dedupe STRAY_PATTERNS extended with 3 supplier-original families (CSW-style underscored, S&S Profile, HR-suffixed) — dry-run produced 142 candidates with canonical _std.png siblings
- Live trash trashed all 142 duplicates with 0 errors; DUPE-DRIVE audit category dropped from 92 to 9 (a different naming family flagged for follow-up)

## Task Commits

Each task committed atomically:

1. **Task 1: resolveStoreProduct helper** — `48178ce` (feat)
2. **Task 2: KNOWN_SUPPLIER_PREFIXES allowlist** — `ef4aa59` (feat)
3. **Task 3a: STRAY_PATTERNS extension (dry-run)** — `28ce912` (feat)
4. **Checkpoint:decision** — resolved by user with `approve`
5. **Task 3b: Live trash + leftovers documentation** — `dce78ef` (chore)

## Files Created/Modified

- `src/shopify/resolve-store-product.ts` — New helper exporting `resolveStoreProduct`, `NoStoreProductError`, `MultipleStoreProductsError`
- `scripts/audit-product-imagery.ts` — Added `KNOWN_SUPPLIER_PREFIXES` constant and modified prefix-validation to consult it
- `scripts/dedupe-drive-duplicates.ts` — Appended 3 new STRAY_PATTERNS entries; canonicalExists guard preserved
- `tmp/dedupe-leftovers.tsv` — 9 unresolved DUPE-DRIVE rows (different naming family) documented for follow-up
- `.planning/phases/14-.../deferred-items.md` — Out-of-scope test-file TS errors and DUPE-DRIVE leftover scope notes

## Decisions Made

- **Throw-on-multi over first-match:** The helper refuses to silent-pick and surfaces the matches list in the error message — the 15-color drop on pid 5000 happened because the previous code took `first: 1` of 3 matches; never again.
- **Per-pid allowlist instead of global:** Adding a global "supplier prefix is OK" relaxation would have masked legitimate cross-pollution. `KNOWN_SUPPLIER_PREFIXES['168']` is explicit and reviewable; future suppliers add their own pid → prefix entries.
- **Live trash batched to dry-run + checkpoint:** Trashing 142 files without a candidate review would have been reckless; the explicit checkpoint with `tmp/dedupe-dryrun-14-01.log` lets the user spot-check pattern over-matches before any mutation.
- **9 DUPE-DRIVE leftovers documented, not force-fixed:** Files like `1275InnwerW-Front-Black-HIRes.jpg` and the BELLA `DirectSide_High`/`Side_High_Model` pairs lack canonical `_std.png` siblings — they're a different reconciliation problem (probably 14-02 scope) and force-trashing them would lose the only copy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Node v24 TLS cert verification failed against Google OAuth**
- **Found during:** Task 3b (first live-trash attempt)
- **Issue:** `npx tsx -r dotenv/config scripts/dedupe-drive-duplicates.ts --apply` failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` against `https://oauth2.googleapis.com/token`. Node v24 stricter cert handling no longer trusts the corporate-managed root CA from the bundled cert store.
- **Fix:** Wrapped invocations with `NODE_OPTIONS="--use-system-ca"` (the error message itself recommends this; Node v24 feature uses the Windows OS cert store where the corporate root CA is installed).
- **Files modified:** None (env-only workaround at invocation time)
- **Verification:** Live trash succeeded with EXIT=0; trashed=142, errors=0. Re-audit also succeeded with the same env wrapper.
- **Committed in:** dce78ef (no source change; the workaround is documented in this summary and in deferred-items.md for future imagery scripts)

**2. [Rule 3 - Blocking] Default `--dry-run` flag prevented live trash**
- **Found during:** Task 3b first attempt
- **Issue:** The dedupe script defaults `dryRun: true`. Running it bare with `> tmp/dedupe-live-14-01.log` repeated the dry-run instead of mutating Drive.
- **Fix:** Re-invoked with explicit `--apply` flag.
- **Files modified:** None (correct usage on retry)
- **Verification:** Log header now reads `{"dryRun":false,...}` and Summary block shows trashed=142.
- **Committed in:** dce78ef (live log gitignored as `*.log`)

---

**Total deviations:** 2 auto-fixed (both Rule 3 blocking issues; environmental).
**Impact on plan:** No scope creep. Both deviations were execution-environment hurdles, not plan-design issues. The plan's 3 source-code deliverables landed exactly as specified.

## Issues Encountered

- **Pre-existing TS errors in `tests/scripts/audit-images.test.ts`** (vitest mock typing, ~10 errors). Out of scope per executor scope-boundary rule; logged in `deferred-items.md`. None of the 3 plan-modified source files emit any TS errors.
- **9 DUPE-DRIVE leftovers** (4 pids: L01275, 4610, 9002, 3911) belong to a different naming family without canonical siblings. Plan's exit criterion permitted "≤ 5 OR documented in `tmp/dedupe-leftovers.tsv`" — went the documented path. Tracked in `deferred-items.md`.

## Known Stubs

None — all helpers, constants, and patterns wire into real call sites. No placeholder data, no UI rendering of empty arrays, no "coming soon" text.

## User Setup Required

None — no new environment variables or external service configuration. The TLS workaround `NODE_OPTIONS=--use-system-ca` is a developer-machine consideration, not a project setting; documented in deferred-items.md so any future imagery script invocation includes it.

## Self-Check

- [x] `src/shopify/resolve-store-product.ts` exists (4420 bytes, exports verified)
- [x] `KNOWN_SUPPLIER_PREFIXES` literal present in `scripts/audit-product-imagery.ts` (3 occurrences)
- [x] `STRAY_PATTERNS` literal present in `scripts/dedupe-drive-duplicates.ts` (2 occurrences)
- [x] `tmp/dedupe-leftovers.tsv` exists with 9 rows
- [x] Commit `48178ce` exists in git log (Task 1)
- [x] Commit `ef4aa59` exists in git log (Task 2)
- [x] Commit `28ce912` exists in git log (Task 3a)
- [x] Commit `dce78ef` exists in git log (Task 3b)
- [x] Smoke test `pid=5000 → unisex-heavy-cotton-t-shirt-5000` passes
- [x] `npx tsc --noEmit` shows zero errors in plan-modified files

## Self-Check: PASSED

## Next Phase Readiness

- **14-02 (BR-Drive-Store reconciliation)** can now use `resolveStoreProduct` for safe pid lookups; the 5000 silent-pick bug class is closed at the helper layer.
- **14-03 (BAD-ALT remediation)** unblocked — the audit script's prefix check no longer false-positives on the Richardson cap line, so pid 168 BAD-ALT signal is clean.
- **9 DUPE-DRIVE leftovers** carried forward in `tmp/dedupe-leftovers.tsv` and `deferred-items.md`; expected resolution either in 14-02 (pid-level reconciliation) or a phase-15 cleanup if they're truly orphan.

---
*Phase: 14-imagery-cleanup*
*Completed: 2026-05-08*
