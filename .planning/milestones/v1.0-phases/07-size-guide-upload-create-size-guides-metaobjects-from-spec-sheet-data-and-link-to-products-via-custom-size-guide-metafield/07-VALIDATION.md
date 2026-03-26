---
phase: 7
slug: size-guide-upload
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-11
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | size-guide-read | unit | `npx vitest run tests/shopify/size-guide.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | size-guide-create | unit | `npx vitest run tests/shopify/size-guide.test.ts` | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 2 | size-guide-push | integration | `npx vitest run tests/shopify/product-push.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/shopify/size-guide.test.ts` — stubs for size guide reading and metaobject creation
- [ ] Shared fixtures for spec sheet mock data

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Size guide renders on storefront | size-guide-display | Theme-dependent rendering | Push test product, verify size guide tab shows correct data |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
