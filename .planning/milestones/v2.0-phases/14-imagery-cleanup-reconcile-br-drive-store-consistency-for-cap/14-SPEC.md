# Phase 14: Imagery Cleanup — BR ↔ Drive ↔ Store Reconciliation — Specification

**Created:** 2026-05-08
**Ambiguity score:** 0.14
**Requirements:** 6 locked

## Goal

`audit-product-imagery.ts` reports zero unjustified issues across STORE-DRIFT, CROSS-POLLUTION, DUPE-DRIVE, BAD-ALT, and dupe-product checks for the curated bestseller catalog (~460 pids). Each remaining audit row must either be classified as an accepted variance (with reason recorded) or fixed.

## Background

After the morning's imagery work and tonight's drift+side-label fixes, the audit (run 2026-05-07 23:47Z and 2026-05-08 00:00Z) still flags 1033+ issues:

| Check | Count | Notes |
|---|---|---|
| CROSS-POLLUTION | 826 (47 pids) | Drive files in wrong product folders, never addressed |
| DUPE-DRIVE | 92 (20 pids) | Supplier-original files in naming patterns the earlier dedupe missed (`693_NAVY_FRONT_low_375x.webp`, `H08355-Ivory-Profile_2000x.webp`, `1040_black_front_HR.jpg`) |
| STORE-DRIFT | ~42 (2 pids) | 5000 has BR↔store mismatch from tonight's bad drop; 168 has Richardson_-prefixed Drive files audit rejects |
| BAD-ALT | 2 pids (13 alts) | L01210 + L01250 design-sample alts ("Left Chest Print", "Back Print") |

Tonight also produced a known-bad state needing rollback in this phase:

- 5000 (real product `unisex-heavy-cotton-t-shirt-5000`, 250 media, 67 colors): 15 colors on store (Aquatic, Antique Jade Dome, Antique Orange, Berry, Blackberry, Blue Dusk, Brown Savana, Cobalt, Dusty Rose, Electric Green, Lilac, Midnight, Neon Blue, Neon Green, Russet) were dropped from BR but not from store — they're now orphaned.
- This happened because the investigator looked up 5000 with `first: 1` and found a stale orphan duplicate (`t-shirt-gildan-5000`, 21 media, 2 colors) instead of the live product. The orphan was correctly deleted; the BR drop was correct in intent (low-priority colors) but executed against bad data.

The codebase already has the working scripts needed for this phase: `audit-product-imagery.ts`, `fix-store-drift.ts`, `dedupe-drive-duplicates.ts`, `cleanup-all-drive-orphans.ts`, `redetect-unknown-side-cache.ts`, `swap-mislabeled-store-sides.ts`, `drop-br-colors.ts`. The phase consists of applying these scripts (and small extensions) to drive remaining issue counts to zero or accepted-variance.

## Requirements

1. **5000 BR↔store reconciliation**: Resolve the 15 dropped-but-orphaned colors on `unisex-heavy-cotton-t-shirt-5000`.
   - Current: 15 colors exist on the live store product but no longer in BR (orphan); freed cap slots not used.
   - Target: Either (a) 15 colors deleted from store (matches dropped intent), OR (b) 15 BR rows restored from Sheets version history. User picks one path; spec accepts either.
   - Acceptance: Re-run audit; zero STORE-EXTRA-COLOR rows for pid 5000; pid 5000's audit STORE-DRIFT = 0.

2. **Sibling-product invariant**: Any cleanup script that resolves a pid to a single store product must enumerate ALL matches and fail loudly if more than one is found.
   - Current: Tonight's lookup used `first: 1` and silently picked a stale orphan duplicate, causing the bad drop.
   - Target: Helper function `resolveStoreProduct(pid)` that throws if `> 1` non-archived match exists; all reconciliation scripts in this phase use it. Documented in scripts/lib if reused.
   - Acceptance: Code review confirms no script in scripts/ uses `first: 1` against `handle:*{pid}*` without explicit dedup-or-fail handling.

3. **CROSS-POLLUTION sweep (826 rows / 47 pids)**: Triage and resolve.
   - Current: 826 audit rows where a Drive file's filename prefix doesn't match its parent folder's pid.
   - Target: Each row classified into one of: (a) FILE WAS MISFILED — move to correct product folder; (b) FILE IS LEGITIMATE NON-PID-PREFIX (e.g., Richardson_168_*) — extend audit's allowed-prefix list with the pid's known supplier prefix; (c) ORPHAN — trash. Output written to `tmp/cross-pollution-resolution.tsv` for traceability.
   - Acceptance: Re-run audit; CROSS-POLLUTION = 0, OR remaining rows have a documented reason in `tmp/cross-pollution-resolution.tsv` marked ACCEPTED.

4. **DUPE-DRIVE round 2 (92 rows / 20 pids)**: Extend dedupe to catch the missed naming patterns.
   - Current: `dedupe-drive-duplicates.ts` only catches `pid-color-view-NNNNxNNNN.webp` hyphenated patterns. Misses underscored (`693_NAVY_FRONT_low_375x.webp`), Profile-named (`H08355-Ivory-Profile_2000x.webp`), and HR-suffixed (`1040_black_front_HR.jpg`) supplier-original variants.
   - Target: Extended STRAY_PATTERNS regex (or a v2 script) that detects each of the 3 documented patterns AND any other supplier-original lookalike when a canonical `_std.png` exists for the same (color, view).
   - Acceptance: Re-run audit; DUPE-DRIVE = 0 OR remaining rows have a documented exception (e.g., a file that legitimately is the canonical version).

5. **168 cross-pollution fix**: Resolve Richardson_-prefixed files.
   - Current: pid 168's BR uses Drive files like `Richardson_168_Black_Front_High.jpg`. Audit flags as CROSS-POLLUTION because `Richardson_` doesn't start with the pid `168`. Store has 0 fronts/backs for any 168 color because of this mismatch (4 STORE-DRIFT rows).
   - Target: Either rename Drive files to drop `Richardson_` prefix OR extend audit's allowed prefix list to recognize `Richardson_` as a legitimate supplier-pid prefix. Then re-run drift fix to populate the missing front/back/sides.
   - Acceptance: Audit shows 0 CROSS-POLLUTION rows for pid 168 AND 0 STORE-DRIFT rows for pid 168.

6. **BAD-ALT triage**: Decide on the 13 design-sample alts.
   - Current: L01210 has 4 alts (`Left Chest Print` ×2, `Back Print`); L01250 has 9 alts (empty, `Back Print`, `Left Chest Print`). Audit flags as BAD-ALT.
   - Target: User decides per pid: (a) keep — extend audit's BAD-ALT regex to whitelist these decoration-zone alts; OR (b) delete — remove from store.
   - Acceptance: Audit shows 0 BAD-ALT rows OR the remaining rows match the user-approved whitelist pattern.

## Boundaries

**In scope:**
- All issues currently flagged by `scripts/audit-product-imagery.ts` for the curated bestseller catalog (~460 pids in BR-Ready)
- 5000 BR↔store reconciliation (rollback OR forward-resolve)
- Audit script extensions needed to recognize legitimate non-canonical patterns (Richardson prefix, decoration-zone alts)
- A reusable `resolveStoreProduct(pid)` helper that prevents the silent-pick-from-multiple bug

**Out of scope:**
- Catalog curation work (filling missing descriptions, size charts, categories) — that is the v2.0 milestone curation track, separate from imagery
- New product imports / pushes that would CREATE new pids on the store (this phase is reconciliation only, not expansion)
- Performance optimizations to the audit or fix scripts — only correctness matters here
- v3.0 features (product curation filtering, missing-image generation) — separate research items
- Any pid not in BR-Ready (e.g., experimental tabs, legacy data)

## Constraints

- Shopify hard cap: 250 media per product. Cap-bound products (3001, 5000, 64000) cannot exceed this. Color drops on these products are a one-way decision — back-restore from Sheets version history is the only way to undo a BR drop.
- Every Shopify destructive mutation (`productDelete`, `productDeleteMedia`) MUST be dry-run verified first AND logged with the deleted ID. No batch-deletes without target list confirmed by audit output.
- BR sheet row deletions MUST NOT touch tabs other than `Bestsellers-Ready`. Cross-tab deletions are a separate operation.
- Push operations (`push-bestsellers-to-store.ts`) MUST use `--handles` flag, not `--pids` (which doesn't exist). Misuse caused tonight's `jersey-tee-3001` rogue duplicate creation.
- All store reads that resolve a pid to a single product must enumerate matches; tonight's `handle:*5000*` `first: 1` query silently picked an orphan stale duplicate.

## Acceptance Criteria

- [ ] `scripts/audit-product-imagery.ts` reports STORE-DRIFT = 0 OR remaining rows have a per-pid accepted-variance reason recorded in `tmp/audit-acceptance.tsv`
- [ ] CROSS-POLLUTION = 0 OR remaining rows recorded with reason in `tmp/cross-pollution-resolution.tsv`
- [ ] DUPE-DRIVE = 0 OR remaining rows recorded with reason
- [ ] BAD-ALT = 0 OR audit regex extended to whitelist user-approved decoration alts
- [ ] No store product has multiple matches for `handle:*{pid}*` for any pid in BR-Ready (no duplicates)
- [ ] `scripts/lib/resolve-store-product.ts` (or equivalent) exists, throws on > 1 match, and is used by every reconciliation script in this phase
- [ ] No Shopify mutation in this phase is invoked without a prior `--dry-run` log committed in `tmp/`
- [ ] BR sheet has no rows for colors not represented on the corresponding live store product (no BR↔store orphans in either direction)

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                              |
|--------------------|-------|------|--------|--------------------------------------------------------------------|
| Goal Clarity       | 0.85  | 0.75 | ✓      | "audit reports 0 or accepted-variance" is measurable               |
| Boundary Clarity   | 0.90  | 0.70 | ✓      | Explicit in/out lists; defers curation and v3.0 work               |
| Constraint Clarity | 0.75  | 0.65 | ✓      | Shopify cap, dry-run rule, sibling-resolution rule all stated      |
| Acceptance Criteria| 0.80  | 0.70 | ✓      | 8 pass/fail checkboxes tied to audit output                        |
| **Ambiguity**      | 0.14  | ≤0.20| ✓      |                                                                    |

## Interview Log

| Round | Perspective    | Question summary                              | Decision locked                                                      |
|-------|----------------|----------------------------------------------|----------------------------------------------------------------------|
| auto  | Researcher     | What's the current audit baseline?           | 1033 issues (826 CROSS, 92 DUPE, 42 DRIFT, 13 BAD-ALT, 0 MODEL-MISS) |
| auto  | Simplifier     | Minimum viable scope?                        | Drive audit to 0-or-justified across all 4 categories               |
| auto  | Boundary Keeper| What's NOT in this phase?                    | New imports, curation gaps, v3.0 research, performance              |
| auto  | Failure Analyst| What caused tonight's mess?                  | `first: 1` silent pick + wrong --pids flag → orphan + dupe          |
| auto  | Failure Analyst| How to prevent recurrence?                   | resolveStoreProduct() helper + dry-run-required rule in constraints |
| auto  | Seed Closer    | 5000 — rollback or forward-resolve?          | Spec accepts either path; user picks during plan-phase              |

[--auto mode: Claude derived decisions from session investigation context (commits 14ceb1a..3e2ff88 + tonight's logs). User to confirm during /gsd-discuss-phase 14.]

---

*Phase: 14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap*
*Spec created: 2026-05-08*
*Next step: /gsd-discuss-phase 14 — implementation decisions (which fix order, sibling helper API shape, etc.)*
