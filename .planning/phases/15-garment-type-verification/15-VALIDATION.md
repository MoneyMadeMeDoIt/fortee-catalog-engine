---
phase: 15
slug: garment-type-verification
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-08
updated: 2026-05-11
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/lib/ai-image-generator.test.ts tests/lib/rejects-tsv.test.ts tests/lib/garment-type-verifier-unit.test.ts tests/scripts/audit-garment-types.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Fixture-gated command** | `OPENAI_API_KEY=<key> npx vitest run tests/lib/garment-type-verifier.test.ts` |
| **Estimated runtime** | ~30 seconds (mocked); +30–60 seconds when `OPENAI_API_KEY` is set (fixture suite, 12 real calls) |

---

## Sampling Rate

- **After every task commit:** Run the per-task `<verify><automated>` command (each plan specifies its own).
- **After every plan wave:** Run the **Quick run command** above (all mocked tests).
- **Before `/gsd-verify-work`:** Full suite must be green + (if local dev) fixture suite must be green.
- **Max feedback latency:** 30 seconds for mocked tests.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 15-01-T1 | 01 | 1 | R2 | T-15-03 | Mocked OpenAI; verifier helper exports + JSON parse fallback paths | unit (mocked) | `npx tsc --noEmit` | extends src/lib/ai-image-generator.ts | ⬜ pending |
| 15-01-T2 | 01 | 1 | R4 (writer used by R4 path) | T-15-02 | TSV sanitization strips `[\t\n\r]+`; fs failure swallowed | unit (mocked fs) | `npx vitest run tests/lib/rejects-tsv.test.ts` | new file src/lib/rejects-tsv.ts | ⬜ pending |
| 15-01-T3 | 01 | 1 | R2 | T-15-03 | 7 mocked-OpenAI tests cover happy/error paths; no real API key needed | unit (mocked) | `npx vitest run tests/lib/garment-type-verifier-unit.test.ts tests/lib/rejects-tsv.test.ts` | new tests/lib/garment-type-verifier-unit.test.ts + labels.json scaffold | ⬜ pending |
| 15-02-T1 | 02 | 2 | R1 (foundation) | T-15-01, T-15-02 | CandidateResult extended; scoreCandidates calls verifier; NO CostTracker leak | unit (intermediate typecheck) | `grep -E "passesType\|verifyGarmentTypeMatch\\(openai, buffer, frontBuffer\\)" src/lib/ai-image-generator.ts | wc -l` | modifies src/lib/ai-image-generator.ts | ⬜ pending |
| 15-02-T2 | 02 | 2 | R1, R3, R4, R5 | T-15-02 | Strict AND filter at 2 sites; D-04 block replaced with skip+log; pid threaded through both audit-runner callers | unit (typecheck) | `npx tsc --noEmit` | modifies src/lib/ai-image-generator.ts + src/lib/audit-runner.ts | ⬜ pending |
| 15-02-T3 | 02 | 2 | R1, R3, R4, R5 | T-15-02, T-15-03 | 6 mocked-OpenAI tests cover R1 filter, R3 strict-AND retry trigger, R3 no-retry, R4 skip+TSV write, R5 CostTracker untouched, verifier-error fallback | unit (mocked) | `npx vitest run tests/lib/ai-image-generator.test.ts` | extends tests/lib/ai-image-generator.test.ts | ⬜ pending |
| 15-03-T1 | 03 | 2 | R6 | T-15-Extra | Read-only retro CLI; chunked --all support; --dry-run; --limit; --help | smoke (CLI invocation) | `npx tsc --noEmit && npx tsx scripts/audit-garment-types.ts --help` | new scripts/audit-garment-types.ts | ⬜ pending |
| 15-03-T2 | 03 | 2 | R6 | T-15-Extra | 7 DI-seam tests: happy path, dry-run skip, invalid URL skip, download fail continue, match=true no-write, --limit caps, read-only invariant grep | unit (mocked DI) | `npx vitest run tests/scripts/audit-garment-types.test.ts` | new tests/scripts/audit-garment-types.test.ts | ⬜ pending |
| 15-04-T1 | 04 | 3 | R2 | T-15-Fixture | Operator sources 18 fixture PNGs; visual confirmation A343 is hoodie-shape regression | manual | `ls tests/fixtures/garment-type/*.png | wc -l` returns 18 | new binary fixtures | ⬜ pending (checkpoint:human-action) |
| 15-04-T2 | 04 | 3 | R2 | T-15-03 | `describe.skipIf` gate ensures CI without key passes silently; 12 real-API assertions when key set | integration (real API, gated) | `npx vitest run tests/lib/garment-type-verifier.test.ts` | new tests/lib/garment-type-verifier.test.ts | ⬜ pending |
| 15-04-T3 | 04 | 3 | R6 (E2E proof) | T-15-Extra | Live run on A343 catches regression + writes TSV row; no Drive/Sheets writes | manual (operator-driven) | `npx tsx scripts/audit-garment-types.ts --style-id A343` | exercises Plan 01 + 03 together | ⬜ pending (checkpoint:human-verify) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

These artifacts must exist BEFORE the corresponding tasks can run:

- [ ] **Plan 01 Task 1 prerequisite:** `src/lib/ai-image-generator.ts` exists (already true — Phase 10 shipped it). Plan 01 Task 1 only adds the new `verifyGarmentTypeMatch` export; no new test infrastructure needed.
- [ ] **Plan 01 Task 2 prerequisite:** Vitest is installed (verified — already in deps). The `fs` module is built-in. `tmp/` directory will be created by the first run; not pre-required.
- [ ] **Plan 01 Task 3 prerequisite:** Mocked-OpenAI factory pattern exists in `tests/lib/ai-image-generator.test.ts` (verified at lines 19-41) — Task 3 copies and adapts the pattern; no new framework deps.
- [ ] **Plan 02 prerequisite:** Plan 01 is committed (`src/lib/ai-image-generator.ts:verifyGarmentTypeMatch` and `src/lib/rejects-tsv.ts` are importable).
- [ ] **Plan 03 prerequisite:** Plan 01 is committed (same imports). Plan 02 is NOT a prerequisite — Plan 03 only consumes Plan 01's exports.
- [ ] **Plan 04 Task 1 (operator-only):** Operator must source 18 PNG binaries from Drive + production data. This is a `checkpoint:human-action` because A343 binaries require operator's Drive auth and "known-good" fixtures require curator judgment.
- [ ] **Plan 04 Task 2 prerequisite:** Plans 01 + 02 committed, Plan 04 Task 1 binaries staged, `OPENAI_API_KEY` available locally (test gracefully skips if absent).
- [ ] **Plan 04 Task 3 prerequisite (live E2E):** All other plans deployed, `OPENAI_API_KEY` + Google env vars available, operator has read access to A343 row in Sheet1 + Drive.

**No framework installs required.** Vitest, OpenAI SDK, sharp, googleapis are all in `package.json`. No new dependencies.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator selects A343 + 5 known-good fixture binaries | R2 acceptance (SPEC AC #1, #2, #3) | (a) A343 PNGs live in operator-authenticated Drive; (b) "known-good" curation requires visual judgment — no automated way to declare a back/side as "correctly-shaped" without recursive verifier (chicken/egg) | Plan 04 Task 1 — operator runs through 6 product candidates per CategoryGroup, visually confirms front/back/side match, downloads + commits the binaries. Documented in `tests/fixtures/garment-type/README.md`. |
| Confirm retro script wrote TSV but did NOT modify Drive/Sheets | R6 (read-only invariant) | Live-data trust gate — automated grep on imports (Plan 03 Test 7) gives static guarantee; this live check is belt-and-suspenders | Plan 04 Task 3 — operator runs `npx tsx scripts/audit-garment-types.ts --style-id A343` against live data, inspects `tmp/garment-type-rejects.tsv`, confirms no Drive/Sheet modifications. |
| Verifier prompt iteration if fixture suite fails | R2 (SPEC AC #3) | Prompt iteration is a designer judgment task — no algorithm can pick the next prompt phrasing | Plan 04 Task 2 — if any fixture assertion fails, executor reads the `result.reason`, iterates `VERIFIER_SYSTEM_PROMPT` in `src/lib/ai-image-generator.ts`, re-runs fixture test until all pass. Plan 01 mocked tests must still pass after each iteration. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify OR Wave 0 / human-action dependencies (Plan 04 Tasks 1 + 3 are explicit checkpoint types)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (within each plan, every code-modifying task has a TS or vitest gate)
- [x] Wave 0 covers all MISSING references (labels.json scaffold in Plan 01 Task 3; binaries in Plan 04 Task 1)
- [x] No watch-mode flags (all `npx vitest run` invocations are one-shot)
- [x] Feedback latency < 30s for mocked-test gates
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved — 2026-05-11
