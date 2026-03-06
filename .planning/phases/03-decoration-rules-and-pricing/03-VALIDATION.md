---
phase: 3
slug: decoration-rules-and-pricing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run tests/decoration/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/decoration/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | DECOR-01 | unit | `npx vitest run tests/decoration/rules.test.ts -t "category"` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | DECOR-02 | unit | `npx vitest run tests/decoration/rules.test.ts -t "placement guide"` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | PRICE-01 | unit | `npx vitest run tests/decoration/pricing.test.ts` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 1 | PRICE-01 | unit | `npx vitest run tests/decoration/pricing.test.ts -t "reference"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/decoration/rules.test.ts` — stubs for DECOR-01, DECOR-02
- [ ] `tests/decoration/pricing.test.ts` — stubs for PRICE-01
- [ ] `tests/decoration/category-map.test.ts` — covers category resolution

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Decoration rules written to sheet | DECOR-01 | Requires live Google Sheets API | Run `npx tsx scripts/enrich.ts --dry-run` and verify decoration columns populated |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
