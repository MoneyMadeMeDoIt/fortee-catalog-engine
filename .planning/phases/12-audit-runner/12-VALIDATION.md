---
phase: 12
slug: audit-runner
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing project test runner) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/lib/audit-runner.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds (all dependencies mocked) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/lib/audit-runner.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | integration | unit | `npx vitest run tests/lib/audit-runner.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/lib/audit-runner.test.ts` — test stubs mocking all Phase 08-11 dependencies

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| End-to-end pipeline on real product | integration | Requires real Shopify/OpenAI API access | Run `npx tsx scripts/audit-images.ts --style-id CSW-12345 --dry-run` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
