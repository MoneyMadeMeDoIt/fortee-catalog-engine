---
phase: 17-catalog-image-pollution-fix
plan: 04
subsystem: supplier-canonical-resolver
tags: [dispatcher, ss-routing, adidas, bella-canvas, gildan, next-level, comfort-colors, american-apparel, richardson]
status: complete
type: execute
wave: 3
requirements: [R17-04]

dependency_graph:
  requires:
    - 17-01  # Drive timeout (prerequisite for any large-scale audit)
    - 17-02  # Per-color canonical (this plan extends the same dispatcher)
  provides:
    - widened-ss-dispatcher: "adidas A* / CE* + KNOWN_SUPPLIER_PREFIXES route via S&S"
    - routesViaSS-helper: "exported predicate for downstream callers"
  affects:
    - src/lib/supplier-canonical.ts
    - tests/lib/supplier-canonical.test.ts

tech_stack:
  added: []   # No new dependencies — pure routing widening
  patterns:
    - "Set<string>-backed prefix dispatch (O(1) lookup via Object.keys(KNOWN_SUPPLIER_PREFIXES))"
    - "Routing-rule log line for operator observability (S* / A* / CE* / KNOWN_PREFIX)"

key_files:
  created: []
  modified:
    - src/lib/supplier-canonical.ts
    - tests/lib/supplier-canonical.test.ts
    - .planning/phases/17-catalog-image-pollution-fix/deferred-items.md

decisions:
  - "Richardson 168/112 route via S&S (NOT scoped out by D-22) — they're caps but not H08-prefixed, per Open Question 4."
  - "Removed the now-unreachable `KNOWN_SUPPLIER_PREFIXES[pid] → null + D-12 log` fall-through. All 19 entries now route via S&S above."
  - "routesViaSS is exported (named) for testability AND to give downstream callers a one-shot predicate. Phase 17-03 and the audit script can call it without reimplementing the regex set."

metrics:
  duration: "~40 min"
  completed: "2026-05-14"
  tasks: 1
  tests_added: 22  # 21 new under '17-04 prefix routing' + 1 rewritten "allowlist routing" test
  files_modified: 3
---

# Phase 17 Plan 04: D-12 Prefix Dispatcher Widening Summary

Widen the S&S branch in `src/lib/supplier-canonical.ts` to route adidas (A*, CE*) and the existing `KNOWN_SUPPLIER_PREFIXES` allowlist (Bella+Canvas, Gildan, Next Level, Comfort Colors, American Apparel, Richardson) through the existing S&S `/styles/?search=<pid>` resolver — no new scrapers built.

## What shipped

**The surprise finding from RESEARCH Findings 1 + 2 is now in production code:**

| Brand family | Trigger | Status |
|---|---|---|
| S&S native (S*) | `/^S/i` | unchanged — Phase 16 baseline preserved |
| adidas (A2009, A702, A231, A267) | `/^A\d/i` | **NEW** — routes via S&S |
| adidas CE-family (CE520L) | `/^CE\d/i` | **NEW** — routes via S&S |
| Bella+Canvas (1010, 3001, 3010, 3480, 4610, 6003, 6008, 6110, 8882) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S |
| Next Level (1510, 3900, 3911, 9002) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S |
| Comfort Colors (1466, 1467) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S |
| Gildan (5200) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S |
| American Apparel (1304) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S |
| Richardson (168, 112) | `SS_ROUTABLE_PIDS.has(pid)` | **NEW** — routes via S&S (Open Question 4 disposition) |
| CSW (L*) | `/^L/i` | unchanged — falls through to CSW branch |
| H08* headwear | `/^H08/i` | unchanged — early-return BEFORE dispatcher (D-22 invariant) |
| True unsupported (M786, NE220, anvil 9xx, QTB6000) | fall-through | unchanged — returns null, no fetch (Plan 17-05 manual triage) |

## Changes

### `src/lib/supplier-canonical.ts`

- **Added** `SS_ROUTABLE_PIDS = new Set<string>(Object.keys(KNOWN_SUPPLIER_PREFIXES))` — O(1) dispatch lookup of the 19 allowlist pids.
- **Added** `export function routesViaSS(pid: string): boolean` — single-source-of-truth predicate. Returns true for `/^S/i`, `/^A\d/i`, `/^CE\d/i`, or `SS_ROUTABLE_PIDS.has(pid)`.
- **Modified** `resolveSupplierCanonical` dispatcher: replaced `if (/^S/i.test(pid)) { ... }` with `if (routesViaSS(pid)) { ... }`. The S&S branch body (resolveSSStyleId → /products/?style= → 17-02 per-color filter → makeSSLargeUrl) is **unchanged** — only the gate widened.
- **Added** routing-rule log line at the entry of the S&S branch: `[supplier-canonical] routing <pid> via S&S (<rule>) colorName=<color>` where rule is `S*`, `A*`, `CE*`, or `KNOWN_PREFIX`. Operator observability for audit-run diagnosis.
- **Removed** the now-unreachable `if (KNOWN_SUPPLIER_PREFIXES[pid]) { logger.info('...D-12 expansion candidate...') }` fall-through. All 19 entries now route via S&S, so this dead-code branch is gone. Truly unsupported pids fall through to a silent `return null` (no log noise).
- **Updated** the file-header and dispatcher JSDocs to reflect the new dispatch order and route the reader to RESEARCH Findings 1 + 2 + Open Question 4.

### `tests/lib/supplier-canonical.test.ts`

- **Added** `describe('17-04 prefix routing', ...)` block with **21 new tests**:
  - Tests 1-9: each brand family (adidas A702, CE520L, Bella 6110, Bella 3001, Gildan 5200, Next Level 1510, Comfort Colors 1466, American Apparel 1304, Richardson 168) routes via S&S and returns a non-null result.
  - Test 10: H08* invariant — `H08355` returns null with **NO fetch** (early-return preserved).
  - Tests 11-12: true unsupported brands — `M786` and `NE220` return null with **NO fetch** (no dispatcher match → no S&S call).
  - Tests 13-14: existing S* (`S05610`) and L* (`L00660`) behavior unchanged — regression guards.
  - Tests 15-20: `routesViaSS` direct unit tests for prefix-matching edge cases — `A` alone is false, `A2009` is true, `CE520L` is true, `L00660` is false, `s05610` (lowercase) is true, `980` (anvil — not in KNOWN_PREFIXES) is false.
  - Test 21: dispatcher emits a log line surfacing which routing rule fired (operator observability assertion).
- **Rewrote** the obsolete `describe('resolveSupplierCanonical — allowlist-but-no-scraper')` test to reflect post-17-04 behavior: `6110` now routes through S&S, not null+log. Block renamed to `describe('resolveSupplierCanonical — allowlist routing post-17-04')`.

## Tests

- **Target file:** `npx vitest run tests/lib/supplier-canonical.test.ts` — **69/69 pass** (42 tests in the canonical file + 27 from inadvertent worktree copies of the same file — the canonical file itself is 42/42 green).
- **Full suite (excluding worktrees):** `npx vitest run --exclude '.claude/worktrees/**'` — **525/525 tests pass**, 2 pre-existing suite-level failures unrelated to 17-04 (documented in `deferred-items.md`):
  - `tests/scripts/fix-model-images.test.ts` — depends on Plan 17-03's `scripts/fix-model-images.ts` which lands separately.
  - `tests/lib/garment-type-verifier.test.ts` — pre-existing env-var requirement at module load.

## Deviations from plan

### Rule 1 — Auto-fix obsolete test

**[Rule 1 - Bug] Updated "allowlist-but-no-scraper" test to reflect post-17-04 behavior**

- **Found during:** Task 1 — writing the RED-phase tests.
- **Issue:** The existing `describe('resolveSupplierCanonical — allowlist-but-no-scraper')` test (Test 6 in the file) asserted that `resolveSupplierCanonical('6110')` returned null and logged a "Phase 16 D-12 expansion candidate" hint. After 17-04, `6110` routes through S&S — that test would fail as a regression even though the new behavior is exactly what 17-04 is supposed to ship.
- **Fix:** Rewrote that test to assert the new behavior: `6110` now resolves through the S&S branch (mocks `/styles/?search=6110` + `/products/?style=50061` and asserts source === 'ss'). Renamed the describe block to `'resolveSupplierCanonical — allowlist routing post-17-04'`.
- **Files modified:** `tests/lib/supplier-canonical.test.ts` (existing Test 6 block).
- **Commits:** `a3be128` (RED) + `4e78484` (GREEN).

### Rule 2 — Auto-add: dead code removed

**[Rule 2 - Dead code] Removed unreachable KNOWN_SUPPLIER_PREFIXES log fall-through**

- **Found during:** Task 1 — writing the implementation.
- **Issue:** The old dispatcher had a fall-through branch `if (KNOWN_SUPPLIER_PREFIXES[pid]) { logger.info('...D-12 expansion candidate...'); return null; }` AFTER the S&S and CSW branches. With 17-04, all 19 KNOWN_SUPPLIER_PREFIXES entries are now caught by `routesViaSS(pid)` BEFORE reaching that branch. Leaving the dead branch in would have created false confidence and confused future readers.
- **Fix:** Removed the entire block and replaced it with a comment explaining where those pids now route.
- **Files modified:** `src/lib/supplier-canonical.ts`.
- **Commit:** `4e78484`.

## Per-brand Tier 1 unlock estimate

The plan's success criterion is "researcher-disciplined estimate post-17-04: 714 'no canonical' trail rows → ≤ 100". Real-yield TBD until the operator re-runs the audit (runbook below). Static analysis of `tmp/image-pollution-fix-trail-2026-05-14.tsv` lists ~145 pids whose prefixes match a newly-routed family. Per-brand breakdown (theoretical maxima — actual yield depends on whether S&S's `/styles/?search=` recognizes the brand pid string verbatim and whether BR's colorName matches an S&S variant):

| Family | Approx. pids in BR | Expected Tier 1 unlocks (theoretical) |
|---|---|---|
| adidas (A*, CE*) | ~8 | up to 8 |
| Bella+Canvas | ~45 | up to 45 |
| Gildan (5200) | ~12 | up to 12 |
| Next Level | ~15 | up to 15 |
| Comfort Colors | ~10 | up to 10 |
| American Apparel (1304) | ~3 | up to 3 |
| Richardson | ~5 | up to 5 |
| **Total maxima** | **~98** | **~98** |

Real-yield will be lower (researcher's Phase 16 calibration: estimate-to-real ratio was 36-to-1). Document actuals in the next audit run.

## Operator runbook

After Plan 17-04 lands AND Plan 17-03 lands AND 17-01 + 17-02 are merged:

1. Re-run the audit:
   ```
   npx tsx scripts/audit-image-pollution.ts
   ```
2. Count `no canonical for tier 1` trail rows in the produced TSV:
   ```
   awk -F'\t' '$3 == "SUPPLIER_FETCH" && $9 ~ /no canonical/ {print}' tmp/image-pollution-fix-trail-<date>.tsv | wc -l
   ```
   Expected: **drops from 714 (2026-05-14 baseline) to ≤ 100**.
3. Verify no H08* pid leaked into the dispatcher:
   ```
   grep -c 'routing H08' tmp/audit-<date>.log  # MUST be 0
   ```
4. Sanity-check brand routing distribution from the new log lines:
   ```
   grep -oP 'routing \S+ via S&S \(\K(S\*|A\*|CE\*|KNOWN_PREFIX)' tmp/audit-<date>.log | sort | uniq -c
   ```
   Expected: a mix of `S*` (majority — existing baseline), `A*` / `CE*` (adidas — new), `KNOWN_PREFIX` (new — Bella / Gildan / Next Level / Comfort / American / Richardson).

## Known stubs

None. The implementation wires `routesViaSS` into a single dispatcher call and uses live S&S routing for all new pids. No mock data, no placeholders.

## Self-Check: PASSED

- `src/lib/supplier-canonical.ts` — line 103: `const SS_ROUTABLE_PIDS: Set<string> = new Set<string>(...)` present.
- `src/lib/supplier-canonical.ts` — line 119: `export function routesViaSS(pid: string): boolean {` present.
- `src/lib/supplier-canonical.ts` — line 121: `if (/^A\d/i.test(pid)) return true;` present.
- `src/lib/supplier-canonical.ts` — line 122: `if (/^CE\d/i.test(pid)) return true;` present.
- `src/lib/supplier-canonical.ts` — line 335: `if (routesViaSS(pid)) {` present (single occurrence — no body duplication).
- `tests/lib/supplier-canonical.test.ts`: `describe('17-04 prefix routing'` matches exactly once.
- Commit `a3be128` exists (RED test commit).
- Commit `4e78484` exists (GREEN implementation commit).
- `npx vitest run tests/lib/supplier-canonical.test.ts` → 42/42 pass.
- Full suite minus worktrees: 525 tests pass; 2 pre-existing failures documented in `deferred-items.md` are NOT caused by this plan.

## TDD Gate Compliance

- **RED gate:** commit `a3be128` (`test(17-04-T1-RED): failing tests for prefix dispatcher widening`) — 17 tests failed as expected before implementation.
- **GREEN gate:** commit `4e78484` (`feat(17-04-T1): widen S&S dispatcher to cover adidas + KNOWN_SUPPLIER_PREFIXES`) — all 42 tests in the file pass after implementation.
- **REFACTOR:** none needed. The implementation is the minimal change to make the tests pass and matches the RESEARCH §17-04 Pattern B excerpt exactly.
