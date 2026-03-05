---
phase: 01-supplier-data-extraction
plan: 04
subsystem: integration
tags: [typescript, cli, validation, extraction]

# Dependency graph
requires: [01-02, 01-03]
provides:
  - Unified extraction entry point (extractAll, extractFromSupplier)
  - CLI script with --supplier and --style flags
  - Zod validation gate for all extracted products
affects: [02-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [validation gate pattern, CLI arg parsing, sequential supplier extraction]

# Key files
key-files:
  created:
    - src/suppliers/index.ts
    - scripts/scrape.ts
  modified: []

# Decisions
decisions:
  - Sequential extraction order (CSW first, then S&S) to avoid rate limit issues

# Metrics
metrics:
  duration: 1min
  completed: "2026-03-05T13:29:47Z"
  tasks_completed: 1
  tasks_total: 1
---

# Phase 1 Plan 4: Unified Extraction and CLI Summary

Unified entry point wiring both supplier adapters with Zod validation gate and CLI script for single-command extraction.

## What Was Built

### src/suppliers/index.ts
- `extractFromSupplier(supplier)`: Creates appropriate adapter, fetches products, validates each through Zod schema, returns ExtractionResult with valid products, validation errors, and summary counts.
- `extractAll()`: Runs both suppliers sequentially (CSW first since no rate limits, then S&S).
- `ExtractionResult` type exported for downstream consumers.

### scripts/scrape.ts
- CLI entry point with `--supplier` flag for single supplier, no flag for both.
- `--style <id>` support for single product extraction.
- `--help` flag with usage documentation.
- Prints per-supplier summary: total, valid, invalid counts.
- Lists each valid product on one line with style number, title, variant count, image count.
- Lists validation failures with specific field-path errors.
- Exit code 1 if any validation failures or errors; 0 if all valid.

## Verification

- Full test suite: 40 tests passing across 3 test files (validation, CSW, S&S).
- `--help` flag produces clean usage output with exit 0.
- Invalid arguments produce error message with exit 1.
- `--style` without `--supplier` produces helpful error.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 334d091 | Unified extraction entry point and CLI script |

## Deviations from Plan

None -- plan executed exactly as written.
