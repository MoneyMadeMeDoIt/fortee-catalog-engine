---
phase: 16
slug: catalog-image-pollution-audit-fix
status: planning-complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-12
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (already in package.json — see Phase 15 work) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/lib/ tests/scripts/ tests/sheets/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds (quick) / ~110s with OPENAI_API_KEY (fixture suite) |

---

## Sampling Rate

- **After every task commit:** run the per-task `<verify><automated>` command from the plan.
- **After every plan wave:** Run the **Quick run command** above.
- **Before `/gsd-verify-work`:** Full suite must be green.
- **Max feedback latency:** 30 seconds (quick).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 16-01 T1 | 01 | 1 | R7, R11 | T-16-06, T-16-07 | Trail TSV append-only with fsync + sanitize | unit (mocked fs) | `npx vitest run tests/lib/image-pollution-trail.test.ts tests/sheets/drive.test.ts` | Plan 01 creates | ⬜ pending |
| 16-01 T2 | 01 | 1 | R3 (verifier-after foundation), R8, R9 | T-16-02 | False-accept on verifier error; gpt-4o-mini json_object; detail:'low' | unit (mocked OpenAI) | `npx vitest run tests/lib/verify-same-product.test.ts` | Plan 01 creates | ⬜ pending |
| 16-01 T3 | 01 | 1 | R3 (Tier 1 dispatch) | T-16-05 | Headwear short-circuit; RATE_LIMIT enforced; colorSideImage NEVER canonical | unit (mocked fetch) | `npx vitest run tests/lib/supplier-canonical.test.ts` | Plan 01 creates | ⬜ pending |
| 16-02 T1 | 02 | 2 | R1 (Pass 1), R2 (6 columns), Headwear D-22 | T-16-04 (foundation) | Read-only static invariant (Test 7); raw-row reader for Model* | unit + static-parse (mocked deps) | `npx vitest run tests/scripts/audit-image-pollution.test.ts` | Plan 02 creates | ⬜ pending |
| 16-02 T2 | 02 | 2 | R1 (Pass 2 + 3), R2, D-07 ordering | T-16-02, T-16-03 | Pass 3 only on Pass-1/2-clean pids; trail logs VERIFIER_PASS/FAIL with tier=0 | unit (mocked deps) | `npx vitest run tests/scripts/audit-image-pollution.test.ts` | Plan 02 extends | ⬜ pending |
| 16-03 T1 | 03 | 2 | R3, R7, R8, R9 | T-16-01, T-16-02, T-16-03 | origFileId !== newFileId compare-before-trash; verifier-after-fix on every back/side write; front-first ordering | unit (mocked deps) | `npx vitest run tests/scripts/fix-image-pollution.test.ts` | Plan 03 creates | ⬜ pending |
| 16-03 T2 | 03 | 2 | R4, R6, R11 | T-16-01 (Tier 2), T-16-05 | Tier 2 uses generateGarmentView's built-in verifier (no double-call); R6 hard cap → exit 2 + BLOCKED-QUEUE-OVERFLOW; manual queue TSV written even on block | unit (mocked deps) | `npx vitest run tests/scripts/fix-image-pollution.test.ts` | Plan 03 extends | ⬜ pending |
| 16-04 T1 | 04 | 3 | R5, R8, R10, R11 | T-16-01, T-16-04, T-16-09 | Literal DELETE/FORCE confirmation; promptFn DI seam; tier=3 trail rows; --re-audit invocation | unit (mocked readline) | `npx vitest run tests/scripts/fix-image-pollution-manual.test.ts` | Plan 04 creates | ⬜ pending |
| 16-04 T2 | 04 | 3 | R5, R8, R10 | T-16-01, T-16-04 | Operator end-to-end walkthrough confirms terminal-clickable URLs + verifier-after-fix observed behavior + DELETE abort path + re-audit confirms zero unresolved | manual checkpoint | (human-verify) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] **None.** vitest is already installed (Phase 15 work). No new dev dependencies needed.
- [ ] **Test fixtures:** Phase 15's `tests/fixtures/garment-type/` directory has 39 fixture binaries (13 pids × 3 views). Phase 16 unit tests use mocked Buffers (`Buffer.from('fake-png')`) — no new fixture binaries required for the test suite. Optional real-API fixture test could reuse Phase 15's `OPENAI_API_KEY` gate, but is deferred (not blocking).
- [ ] **Wave 0 file scaffolds:** every plan's tests/* file path is part of that plan's `files_modified` — created in-task, not separately.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator-readable terminal clickable URLs | R5 | Terminal rendering varies by emulator (iTerm, Windows Terminal, VSCode integrated); not reliably testable in CI | Plan 04 Task 2 manual walkthrough: operator visually confirms `https://drive.google.com/uc?id=...` lines are click-targetable in their terminal |
| Verifier-after-fix subjective acceptance | R8, R9 | The verifier's threshold for "same specific product" needs operator calibration; false-positive/false-negative rates only knowable from running real audits | After first full-run audit completes, operator inspects 10 random Pass 2 false-positives and 10 false-negatives; if false-positive rate > 10%, revisit SAME_PRODUCT_SYSTEM_PROMPT |
| --post-mortem class breakdown readability | R6 fallback | Class breakdown layout is operator-UX; cannot CI-test "is this readable?" | After a synthetic BLOCKED-QUEUE-OVERFLOW dry run, operator confirms the post-mortem output groups pids by class clearly enough to decide D-12 scraper expansion priority |
| Post-fix Shopify store visual spot-check (deferred) | (not a Phase 16 SPEC AC) | Store push is OUT OF SCOPE per SPEC. Operator does store push separately via push-bestsellers-to-store.ts | If operator chooses to push after Phase 16 closes: visually verify 5-10 fixed pids on the live store show corrected imagery |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (8/9 tasks have `npx vitest run ...`; 1/9 task is `checkpoint:human-verify` which is explicitly manual per `<task type="checkpoint:*">` exemption)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (Plans 01–03 are all auto; Plan 04 Task 1 is auto; Plan 04 Task 2 is the single manual checkpoint after extensive auto coverage)
- [x] Wave 0 covers all MISSING references — no MISSING dependencies, vitest already present
- [x] No watch-mode flags (all `vitest run`, never `vitest --watch`)
- [x] Feedback latency < 30s (quick command runs full lib + scripts + sheets tests; ~30s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (planner self-check, 2026-05-12). Operator approval at end of Plan 04 Task 2.
