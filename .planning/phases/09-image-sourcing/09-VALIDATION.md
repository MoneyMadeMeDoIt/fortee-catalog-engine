---
phase: 09
slug: image-sourcing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 09 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing project test runner) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/suppliers/image-sourcer.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/suppliers/image-sourcer.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | SRC-01 | unit | `npx vitest run tests/suppliers/image-sourcer.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | SRC-02 | unit | `npx vitest run tests/suppliers/image-sourcer.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-03 | 01 | 1 | SRC-03 | unit | `npx vitest run tests/suppliers/image-sourcer.test.ts` | ❌ W0 | ⬜ pending |
| 09-02-01 | 02 | 2 | SRC-04 | integration | `npx vitest run tests/suppliers/image-sourcer.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/suppliers/image-sourcer.test.ts` — test stubs for SRC-01 through SRC-04
- [ ] Mock fixtures for OMG, CSW, and S&S API responses

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| S&S REST API credentials work | SRC-02 | Requires real API credentials | Set SS_ACCOUNT_NUMBER/SS_API_KEY in .env, run `npx tsx scripts/test-image-sourcing.ts` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
