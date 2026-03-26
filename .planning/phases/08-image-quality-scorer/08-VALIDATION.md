---
phase: 08
slug: image-quality-scorer
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing project test runner) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/shopify/image-scorer.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/shopify/image-scorer.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | QUAL-01 | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 1 | QUAL-02 | unit | `npx vitest run tests/shopify/image-scorer.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 2 | QUAL-03 | integration | `npx vitest run tests/shopify/image-scorer.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-02 | 02 | 2 | QUAL-04 | integration | `npx vitest run tests/shopify/image-scorer.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/shopify/image-scorer.test.ts` — test stubs for QUAL-01 through QUAL-04
- [ ] Test fixture images (known-good, known-blurry, low-res, watermarked) — either real samples or generated buffers

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Threshold calibration against 50+ real images | QUAL-03 | Requires real supplier image corpus | Run `scripts/calibrate-scorer.ts`, verify false-reject rate < 5% |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
