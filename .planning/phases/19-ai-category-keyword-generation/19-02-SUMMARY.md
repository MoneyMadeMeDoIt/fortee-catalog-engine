---
phase: 19-ai-category-keyword-generation
plan: "02"
subsystem: gen-categories-keywords
tags: [claude-haiku, structured-output, zod, dry-run, checkpoint, idempotent, fan-out]
dependency_graph:
  requires: [scripts/lib/category-schema.ts, src/sheets/writer.ts, src/shopify/variants.ts, src/sheets/column-map.ts]
  provides: [scripts/gen-categories-keywords.ts]
  affects: [scripts/gen-categories-keywords.test.ts]
tech_stack:
  added: ["@anthropic-ai/sdk@^0.104.1"]
  patterns: [zodOutputFormat, DI pure-core, checkpoint/resume, dry-run-default, backup-before-apply]
key_files:
  created:
    - scripts/gen-categories-keywords.ts
    - scripts/gen-categories-keywords.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "Entry-point guard: main() only runs when import.meta.url matches process.argv[1], so vitest imports the module without triggering the ANTHROPIC_API_KEY check"
  - "Concurrency: simple hand-rolled CONCURRENCY=8 worker pool (runNext promises) — no external library needed"
  - "Quota detection: checks for 'quota'/'credit'/'exceeded' in the error message (case-insensitive) plus error.type=invalid_request_error to distinguish monthly cap from transient 429"
metrics:
  duration: "~20 min"
  completed: "2026-06-10"
  tasks_completed: 3
  files_created: 2
---

# Phase 19 Plan 02: gen-categories-keywords.ts Summary

Per-productId Claude Haiku 4.5 structured-output categorizer with dry-run/apply, per-product checkpoint/resume, idempotent skip-if-filled, backup-before-apply, and 20 DI'd unit tests — no live API calls at test time.

## Tasks Completed

| Task | Name | Commit |
|------|------|--------|
| 1 | Install @anthropic-ai/sdk + classifyProduct scaffold | 82e494d, 402c92f |
| 2 | Pure buildUpdatesForProduct fan-out + groupRowsByProductId + unit tests | ae127f5 |
| 3 | CLI wiring (dry-run/apply/checkpoint/backup/stats) — typechecks | (same file as Task 1 commit, typecheck verified) |

## Artifacts

- `scripts/gen-categories-keywords.ts` (830 lines)
  - Exports: `buildUpdatesForProduct`, `groupRowsByProductId`, `classifyProduct`, `Checkpoint`, `BuildUpdatesInput`, `BuildUpdatesResult`, `PreviewRow`, `UpdateStats`
  - classifyProduct: ONE `client.messages.parse()` call per product, `zodOutputFormat(categorySchema)`, model `claude-haiku-4-5`, max_tokens=512, no `effort` param
  - Full CLI: `--apply` / `--force` / `--limit N` / `--pid X`
  - Checkpoint: `tmp/gen-categories-keywords-checkpoint.json`, written after each product
  - Dry-run preview: `tmp/gen-cat-kw-preview-{ts}.tsv` with CHANGED flag on baseCategory changes
  - Apply backup: `tmp/gen-cat-kw-backup-{ts}.tsv` before any sheet write
  - Stats: `written_new / overwritten_changed / skipped_already_current / flagged_unsafe_basecat / products_called / products_skipped`
- `scripts/gen-categories-keywords.test.ts` (504 lines) — 20 tests, all passing

## Test Output

```
 ✓ scripts/gen-categories-keywords.test.ts (20 tests) 2016ms
 Test Files  1 passed (1)
       Tests  20 passed (20)
    Duration  3.66s
```

## Verification

- `node -e "require('@anthropic-ai/sdk'); require('@anthropic-ai/sdk/helpers/zod'); console.log('sdk+zod-helper ok')"` → PASSED
- `npx tsx --check scripts/gen-categories-keywords.ts` → typecheck-ok
- `npx vitest run scripts/gen-categories-keywords.test.ts` → 20/20 PASSED

## Safety Invariants Implemented

| Invariant | Decision | Implementation |
|-----------|----------|----------------|
| Dry-run default | D-14 | `applyMode = args.includes('--apply')`; default does NOT write |
| Backup before apply | D-14 | `writeBackupTsv` called before `writeUpdates` |
| Null-resolving baseCategory never written | D-07 | `getCategoryGroup()` post-validation gate; `flagged_unsafe_basecat++` |
| Row-1 guard | P5 | `sheetRow = rowIndex + 2; if (sheetRow < 2) throw` |
| One call per product | D-03 | `classifyProduct` called once per pid in the worker pool |
| Fan-out to all variant rows | D-11 | `buildUpdatesForProduct` iterates all `rowsForPid` |
| Idempotent skip-if-filled | OPS-02 | Skip-if-filled before API call + delta-only cell skipping |
| Checkpoint/resume | OPS-01 | `tmp/gen-categories-keywords-checkpoint.json` written after each product |
| 429 quota vs rate-limit | Pitfall 12 | Quota → `isQuotaExhausted=true` + clean exit; rate-limit → retry with backoff |
| Header from live values.get | D-12 | `sheetsApi.spreadsheets.values.get` for header, NOT `readAllRows` |
| KW-02 belt-and-suspenders | D-10 | `isCleanKeyword()` applied to all model keywords before fan-out |

## Deviations from Plan

**1. [Rule 2 - Missing] Entry-point guard for test imports**

- **Found during:** Running vitest — main() executed at import time, triggering ANTHROPIC_API_KEY check and process.exit(1)
- **Fix:** Added `isEntryPoint` check comparing `import.meta.url` to `process.argv[1]` so main() only runs as a script, not during test imports
- **Files modified:** scripts/gen-categories-keywords.ts (last 8 lines)
- **Commit:** ae127f5 (included in the same test commit since it was the fix that made tests pass cleanly)

## Known Stubs

None. The script is feature-complete for build+test. Live execution (--apply against the real sheet) is gated by the 19-03 human-verify checkpoint per plan design.

## Threat Flags

None. All T-19-04 / T-19-05 / T-19-06 mitigations are implemented:
- T-19-04: getCategoryGroup() post-validation gate on baseCategory writes
- T-19-05: per-product checkpoint + quota-clean-exit
- T-19-06: dry-run default + backup before apply + row-1 guard + delta-only writes

## Self-Check: PASSED

- scripts/gen-categories-keywords.ts — FOUND
- scripts/gen-categories-keywords.test.ts — FOUND
- package.json contains @anthropic-ai/sdk — FOUND
- commit 82e494d — FOUND
- commit 402c92f — FOUND
- commit ae127f5 — FOUND
- min_lines 250 satisfied (830 lines) — PASSED
- exports buildUpdatesForProduct — PASSED (exported function)
- 20 unit tests passing — PASSED
