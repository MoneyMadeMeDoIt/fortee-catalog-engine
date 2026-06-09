---
phase: 17-catalog-image-pollution-fix
plan: 02
subsystem: image-pollution
tags: [phase-17, supplier-canonical, per-color, audit, fix-orchestrator, manual-cli]
dependency_graph:
  requires:
    - src/lib/supplier-canonical.ts (Phase 16 dispatcher — extended)
  provides:
    - per-color supplier-canonical resolver (`resolveSupplierCanonical(pid, colorName?)`)
    - `CanonicalResult.wasFallback` flag
  affects:
    - scripts/audit-image-pollution.ts (Pass 1 + Pass 2 supplier-canonical calls)
    - scripts/fix-image-pollution.ts (Tier 1 supplier fetch)
    - scripts/fix-image-pollution-manual.ts (handleReplace FrontImage SoT)
tech-stack:
  added: []
  patterns:
    - "S&S client-side per-color filter (case-insensitive whitespace-trimmed equality)"
    - "CSW filename-substring slug match (lowercase + hyphenated colorName)"
    - "Fallback flag (`wasFallback: true`) when colorName provided but unmatched"
key-files:
  created: []
  modified:
    - src/lib/supplier-canonical.ts
    - scripts/audit-image-pollution.ts
    - scripts/fix-image-pollution.ts
    - scripts/fix-image-pollution-manual.ts
    - tests/lib/supplier-canonical.test.ts
    - tests/scripts/audit-image-pollution.test.ts
    - tests/scripts/fix-image-pollution.test.ts
    - tests/scripts/fix-image-pollution-manual.test.ts
decisions:
  - "Backward-compatible signature: omitting `colorName` preserves Phase 16 first-front-image-bearing-variant behavior."
  - "S&S match is normalized exact-equality (uppercase + trim), NOT substring — prevents BR colorName 'BLACK' from matching S&S 'BLACK FOREST' (T-17-05)."
  - "When colorName matches but the variant's colorFrontImage is empty, we fall through to the first non-empty variant AND set wasFallback=true. Conservative: never return an empty URL."
  - "CSW filename match is best-effort (lowercase + spaces→hyphens substring); CSW has no first-class color metadata. Documented in JSDoc."
  - "No new API calls — S&S /products/?style= already returns all colors in one response (RESEARCH Finding 4)."
metrics:
  duration: ~12 min
  completed_date: 2026-05-14
requirements: [R17-02]
---

# Phase 17 Plan 02: Per-color supplier-canonical Summary

Extended `resolveSupplierCanonical(pid, colorName?)` to filter the S&S /products/?style= response per-color (case-insensitive trim-equality) and the CSW images array per-filename-slug (best-effort substring); threaded the BR row's colorName cell through all 3 call sites (audit Pass 2, Tier 1 fix, manual Tier 3 handleReplace).

## What changed

### `src/lib/supplier-canonical.ts`

- Added optional `wasFallback?: boolean` to `CanonicalResult`.
- Added optional `colorName?: string` second positional parameter to `resolveSupplierCanonical`.
- **S&S branch**: now requests `colorName,colorFrontImage` from `/products/?style=` and filters client-side using `String(p.colorName ?? '').toUpperCase().trim() === target`. Variants that match colorName but have empty `colorFrontImage` are skipped so we never return an empty URL. Fallback path: first variant with a non-empty `colorFrontImage` — `wasFallback: true` set iff a colorName was provided but unmatched.
- **CSW branch**: builds a `colorName.toLowerCase().trim().replace(/\s+/g, '-')` slug and substring-matches each `images[].src` filename. Fallback: first image; `wasFallback: true` set iff colorName provided but unmatched.
- Per-resolution log line now includes `colorName=<X>` and `(fallback)` markers.

### `scripts/audit-image-pollution.ts`

- `PidData` extended with `colorName: string`; `buildPidData` reads from BR header `colorName`.
- `recommendedFixTier(pid, colorName, deps)` signature extended; Pass 1 shared_url loop builds a `pid → colorName` lookup map (the shared_url path iterates a flat fileId map, not PidData), Pass 1 invalid-mime path passes `p.colorName`.
- Pass 2 supplier-canonical call now passes `p.colorName` as 2nd arg.

### `scripts/fix-image-pollution.ts`

- `tier1Fix` reads `colorName` from `brEntry.row[brIndex.headerMap['colorName']]` and passes to `deps.supplierCanonicalFn(pid, colorName)`.

### `scripts/fix-image-pollution-manual.ts`

- `handleReplace` reads `colorName` from `brEntry.row` and passes to `deps.supplierCanonicalFn(row.pid, colorName)` in the FrontImage SoT branch.

## Tests added

### `tests/lib/supplier-canonical.test.ts` (12 new cases in `describe('17-02 per-color resolver')`)

- **S&S: returns the colorFrontImage of the matching color when colorName is provided** — happy path BLACK/WHITE/ROYAL → asks for ROYAL → gets ROYAL.
- **S&S: matches colorName case-insensitively and trims surrounding whitespace** — `'royal'` and `'  Royal  '` both hit `ROYAL`.
- **S&S: falls back to first front-image-bearing variant and sets wasFallback=true when colorName has no match** — `'NONEXISTENT-COLOR'` → first variant (`BLACK`), `wasFallback: true`.
- **S&S: with no colorName argument, returns first front-image-bearing variant and does NOT mark wasFallback** — backward-compat path.
- **S&S: skips a colorName match whose colorFrontImage is empty; falls back to first non-empty variant with wasFallback=true** — defensive: never return empty URL.
- **S&S: returns null when /products/ response is empty even with colorName provided** — `[]` response → `null`.
- **S&S: passing colorName does NOT add extra fetches (same call count as Phase 16)** — Finding 4 invariant.
- **CSW: matches the image whose filename contains the colorName slug** — `'Royal'` → `L00660-Royal-front.jpg`.
- **CSW: converts spaces in colorName to hyphens to build the filename slug** — `'Heather Gold Melange'` → `heather-gold-melange-front`.
- **CSW: falls back to first image and sets wasFallback=true when no filename matches the colorName slug** — `'NONEXISTENT'` → first image, `wasFallback: true`.
- **CSW: with no colorName argument, returns first image and does NOT mark wasFallback** — backward-compat path.
- **exports CanonicalResult with optional url/source/styleId/wasFallback fields** — public-surface assertion.

### `tests/scripts/audit-image-pollution.test.ts` (1 new test in `describe('17-02 colorName propagation')`)

- **audit Pass 2 forwards the BR row colorName cell to supplierCanonicalFn** — synthetic BR row with `colorName: 'ROYAL'` triggers Pass 2; assertion: every supplierCanonicalFn call has `('S05610', 'ROYAL')`.

### `tests/scripts/fix-image-pollution.test.ts` (1 new test + 1 existing-assertion update)

- New: **Tier 1 forwards the BR row colorName cell to supplierCanonicalFn** — pid `'S05610'`, BR `colorName: 'ROYAL'` → assertion: calls are `('S05610', 'ROYAL')`.
- Updated: existing Test 3 (resume-from-trail) now asserts `.toHaveBeenCalledWith('pidB', expect.any(String))` (was 1-arg).

### `tests/scripts/fix-image-pollution-manual.test.ts` (1 new test in `describe('17-02 colorName propagation')`)

- **handleReplace forwards the BR row colorName cell to supplierCanonicalFn** — pid `'L00660'`, BR `colorName: 'Heather Gold Melange'` → assertion: calls are `('L00660', 'Heather Gold Melange')`.

## Acceptance criteria — verified

- `grep -nE "resolveSupplierCanonical\(.*pid: string.*colorName\?: string" src/lib/supplier-canonical.ts` → matches (multi-line; verified by `Grep`: `colorName?: string` on line 276 inside the function signature spanning lines ~274-277).
- `grep -nE "wasFallback\?: boolean" src/lib/supplier-canonical.ts` → 1 line (line 102).
- `grep -nE "colorName\.toUpperCase\(\)\.trim\(\)" src/lib/supplier-canonical.ts` → 1 line (line 304).
- `grep -nE "colorName\.toLowerCase\(\)\.trim\(\)\.replace" src/lib/supplier-canonical.ts` → 1 line (line 349).
- `grep -nE "wasFallback = true" src/lib/supplier-canonical.ts` → 2 lines (line 311 S&S, line 355 CSW).
- `grep -nE "describe\('17-02 per-color resolver" tests/lib/supplier-canonical.test.ts` → 1 line.
- `grep -nE "supplierCanonicalFn\(([^,]+,[^,)]+)\)" scripts/{audit,fix,fix-image-pollution-manual}.ts` → 4 matches (audit `recommendedFixTier`, audit Pass 2, fix Tier 1, manual handleReplace).
- `grep -nE "supplierCanonicalFn\([^,)]+\)$" scripts/{audit,fix,fix-image-pollution-manual}.ts` → **0** single-arg calls remain.
- `grep -cE "describe\\('17-02 colorName propagation" tests/scripts/{audit,fix,fix-image-pollution-manual}.test.ts` → 3 (one per file).
- `npx vitest run tests/lib/supplier-canonical.test.ts --exclude '.claude/worktrees/**'` → **21/21 pass** (9 existing + 12 new).
- `npx vitest run tests/scripts/{audit,fix,fix-image-pollution-manual}.test.ts --exclude '.claude/worktrees/**'` → **67/67 pass**.
- `npx vitest run --exclude '.claude/worktrees/**'` → **504/504 tests pass** (the 1 failing suite is the pre-existing Phase 15 `OPENAI_API_KEY` failure that the orchestrator explicitly excluded; not related to 17-02).

## TDD gate compliance

| Task | RED commit | GREEN commit | REFACTOR |
| ---- | ---------- | ------------ | -------- |
| 1: extend resolveSupplierCanonical | `3dcd979` test(17-02-T1-RED) | `ed245c5` feat(17-02-T1) | n/a |
| 2: thread colorName through 3 call sites | `987e093` test(17-02-T2-RED) | `d71c63d` feat(17-02-T2) | n/a |

Each task followed RED → GREEN: a failing-test commit landed first, then the implementation commit drove the suite to green.

## Operator runbook — re-run Tier 1 against the 2026-05-14 audit TSV

The acceptance criterion R17-02 is verified by tests (the 11 "same style, different color" verifier-rejects would no longer fire because the resolver now returns the per-color URL). An operator can additionally confirm real-world yield by re-running:

```bash
npx tsx scripts/fix-image-pollution.ts --tier1-only --audit-file tmp/image-pollution-audit-2026-05-13.tsv
```

Expected outcome:
- At least 1 new BR_WRITE row appears in `tmp/image-pollution-fix-trail-<date>.tsv` for pids that previously failed with reason `'same .+style, different color'` or `'candidate is .+, reference is .+'` (color mismatch) in the 2026-05-14 trail.
- Real Tier 1 yield (per CONTEXT D-17-02 disciplined estimate): **50–100 Tier 1 fixes** total after 17-02 + 17-04 ship. Do NOT trust the 36-pid dry-run number from 2026-05-14 (off by 36×).
- Actual yield: **TBD** until operator runs the smoke test.

## Threat model — outcomes

| Threat ID | Disposition | Outcome |
| --------- | ----------- | ------- |
| T-17-05 (colorName injection routes to wrong product) | mitigated | Normalized exact-equality (`.toUpperCase().trim()`) on S&S branch — substring collision impossible. |
| T-17-06 (colorName containing tabs/newlines corrupts trail TSV) | mitigated | Trail writer's existing `sanitize()` collapses `[\t\n\r]+` for the 4 unsafe fields; no new surface. |
| T-17-07 (CSW filename match reveals internals in log) | accepted | Logged filename is already a public URL fragment; no new disclosure. |
| T-17-08 (extra API call per audit row) | accepted | Zero new API calls — same fetch count as Phase 16 per RESEARCH Finding 4; verified by Test 7 (`fetchSpy.mock.calls.length === 2`). |

## Deviations from plan

None — plan executed exactly as written.

## Known S&S colorName edge cases (candidates for follow-up normalization)

Per plan `<output>` (d): surface S&S colorName conventions that may diverge from BR colorName. Plan 17-02 does **not** attempt normalization — that's outside scope. Surfacing for future follow-up:

- S&S may use abbreviated tokens (e.g., `'HTHR ROYAL'`) while BR populates the full word (e.g., `'Heather Royal'`). Such cases will currently fall back to first-front-image with `wasFallback: true`. Operator can observe these by grep on `(fallback)` in the supplier-canonical log lines; if frequent in production, a normalization map (S&S abbreviation → BR full-word) is a natural next iteration.

No edge cases were observed at the test level — every test scenario uses BR colorName values matching S&S's `colorName` field verbatim or with intentional case/whitespace variance.

## Self-Check: PASSED

Verifications:

- `[X] FOUND: src/lib/supplier-canonical.ts` — modified.
- `[X] FOUND: scripts/audit-image-pollution.ts` — modified.
- `[X] FOUND: scripts/fix-image-pollution.ts` — modified.
- `[X] FOUND: scripts/fix-image-pollution-manual.ts` — modified.
- `[X] FOUND: tests/lib/supplier-canonical.test.ts` — extended.
- `[X] FOUND: tests/scripts/audit-image-pollution.test.ts` — extended.
- `[X] FOUND: tests/scripts/fix-image-pollution.test.ts` — extended.
- `[X] FOUND: tests/scripts/fix-image-pollution-manual.test.ts` — extended.
- `[X] FOUND commit 3dcd979 (test 17-02-T1-RED)`
- `[X] FOUND commit ed245c5 (feat 17-02-T1)`
- `[X] FOUND commit 987e093 (test 17-02-T2-RED)`
- `[X] FOUND commit d71c63d (feat 17-02-T2)`
- `[X] Test gate: 21/21 supplier-canonical, 67/67 across 3 script test files, 504/504 full suite (excluding worktrees + pre-existing Phase 15 OPENAI_API_KEY failure).`
