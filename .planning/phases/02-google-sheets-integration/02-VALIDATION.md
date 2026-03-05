---
phase: 02
slug: google-sheets-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/sheets/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/sheets/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SHEET-01 | unit (mock API) | `npx vitest run tests/sheets/client.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | SHEET-01 | unit (mock API) | `npx vitest run tests/sheets/reader.test.ts -t "read"` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | SHEET-02, SHEET-03 | unit | `npx vitest run tests/sheets/merge.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | SHEET-02, SHEET-03 | unit (mock API) | `npx vitest run tests/sheets/writer.test.ts -t "write"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/sheets/client.test.ts` — stubs for SHEET-01 (auth, client creation)
- [ ] `tests/sheets/reader.test.ts` — stubs for SHEET-01 (row parsing, ragged row padding)
- [ ] `tests/sheets/merge.test.ts` — stubs for SHEET-03 (fill-gaps logic, skip non-empty cells)
- [ ] `tests/sheets/writer.test.ts` — stubs for SHEET-02 (batchUpdate, RAW mode)
- [ ] `tests/sheets/column-map.test.ts` — column letter conversion and field mapping

*Test files will be created as part of plan execution tasks.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Service account auth against real Google Sheets | SHEET-01 | Requires real credentials + shared sheet | Set env vars, run `npx tsx scripts/enrich.ts --dry-run` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
