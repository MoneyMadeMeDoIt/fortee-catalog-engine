---
phase: 05
slug: scale-and-reliability
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/shopify/batch-push.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/shopify/`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | OPS-01 | unit | `npx vitest run tests/shopify/dry-run.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | OPS-02 | unit | `npx vitest run tests/shopify/batch-push.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | OPS-03 | unit | `npx vitest run tests/shopify/batch-push.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/shopify/batch-push.test.ts` — stubs for OPS-02, OPS-03
- [ ] `tests/shopify/dry-run.test.ts` — stubs for OPS-01

*Existing infrastructure covers framework — vitest already installed and configured.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Progress indicator visible in terminal | OPS-02 | Visual output verification | Run batch push on 3+ products, observe `[X/Y] Z%` output updates in real-time |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
