---
phase: 11
slug: image-standardization-safe-upload
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing project test runner) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/shopify/image-standardizer.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/shopify/image-standardizer.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | STD-01 | unit | `npx vitest run tests/shopify/image-standardizer.test.ts` | ✅ | ⬜ pending |
| 11-01-02 | 01 | 1 | STD-02, OUT-02 | unit | `npx vitest run tests/shopify/image-standardizer.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing test infrastructure covers all phase requirements. No new test files needed — updating existing `tests/shopify/image-standardizer.test.ts`.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual uniform scale across products | STD-01 | Visual quality check | Standardize 5 different product types, compare garment sizes visually |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
