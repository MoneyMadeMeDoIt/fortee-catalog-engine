---
phase: 10
slug: ai-image-generation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing project test runner) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/lib/ai-image-generator.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds (mocked OpenAI calls) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/lib/ai-image-generator.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | AIGEN-04 | unit | `npx vitest run tests/lib/hue-utils.test.ts tests/lib/cost-tracker.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | AIGEN-04 | unit | `npx vitest run tests/lib/prompt-templates.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 2 | AIGEN-01, AIGEN-02, AIGEN-03, AIGEN-04 | unit | `npx vitest run tests/lib/ai-image-generator.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/lib/hue-utils.test.ts` — unit tests for hue utilities
- [ ] `tests/lib/cost-tracker.test.ts` — unit tests for cost tracker including estimateCost (D-08)
- [ ] `tests/lib/prompt-templates.test.ts` — unit tests for prompt template builders
- [ ] `tests/lib/ai-image-generator.test.ts` — test stubs for AIGEN-01 through AIGEN-04
- [ ] Mock fixtures for OpenAI API responses (base64 encoded test images)

*Existing vitest infrastructure covers framework needs. `openai` SDK must be installed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Generated images look like garment views | AIGEN-01 | Visual quality is subjective | Run generator on 5 real products, visually inspect outputs |
| $200 budget cap works in production | AIGEN-04 | Requires real API calls with real costs | Monitor cost tracker during a small batch run |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
