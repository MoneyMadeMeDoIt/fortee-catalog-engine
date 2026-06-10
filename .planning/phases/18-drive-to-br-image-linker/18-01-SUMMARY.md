---
phase: 18-drive-to-br-image-linker
plan: "01"
subsystem: image-linker-parser
tags: [drive, image-linker, parser, brand-leak, tdd, pure-module]
dependency_graph:
  requires: []
  provides: [parseCanonicalFilename, normalizeColor, ROLE_TO_COLUMN, CANONICAL_ROLES]
  affects: [scripts/link-br-images.ts (18-02)]
tech_stack:
  added: []
  patterns: [pid-anchored-substring, role-anchored-regex, lowercase-alphanumeric-normalize]
key_files:
  created:
    - scripts/lib/br-image-parser.ts
    - tests/scripts/br-image-parser.test.ts
  modified: []
decisions:
  - "D-07: pid-anchored + role-anchored substring extraction — never split on every hyphen/underscore"
  - "D-04: LeftSide role maps to existing DirectSideImage column, not a new column"
  - "normalizeColor keeps Grey≠Gray distinct; a spelling mismatch is a miss, never a wrong match"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-10"
  tasks_completed: 2
  files_created: 2
---

# Phase 18 Plan 01: BR Image Parser Summary

Pure pid/role-anchored canonical filename parser + color normalizer + role→column map for the Drive→BR image linker, with a full regression suite including the Q-Tees/H08050 brand-leak case.

## What Was Built

`scripts/lib/br-image-parser.ts` — a pure, side-effect-free module exporting:

- `CANONICAL_ROLES` — 7-element const tuple: Front, Back, LeftSide, RightSide, ModelFront, ModelBack, ModelSide
- `ROLE_TO_COLUMN` — maps each role to its BR column: Front→FrontImage, Back→BackImage, LeftSide→DirectSideImage, RightSide→RightSide, ModelFront→ModelFront, ModelSide→ModelSide, ModelBack→ModelBack
- `normalizeColor(c)` — lowercase-alphanumeric collapse (`c.toLowerCase().replace(/[^a-z0-9]/g, '')`)
- `parseCanonicalFilename(name, pid)` — pid-anchored + role-anchored parser (D-07); never splits on every `-`/`_`

`tests/scripts/br-image-parser.test.ts` — 29-test regression suite covering all 7 roles, Q-Tees brand-leak, null cases, and normalizeColor edge cases.

## Test Results

```
✓ tests/scripts/br-image-parser.test.ts (29 tests) 10ms
Test Files  1 passed (1)
Tests       29 passed (29)
Duration    246ms
```

## TDD Gate Compliance

- RED commit `bb33cbf`: `test(18-01): add failing br-image-parser regression suite` — confirmed failing with "Cannot find module" error before implementation
- GREEN commit `4008e93`: `feat(18-01): pid/role-anchored br-image parser` — all 29 tests pass

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this module is pure logic with no data sources to wire.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check: PASSED

- `scripts/lib/br-image-parser.ts` exists and exports all 4 named symbols
- `tests/scripts/br-image-parser.test.ts` exists and all 29 tests pass
- RED commit `bb33cbf` confirmed in git log
- GREEN commit `4008e93` confirmed in git log
- No `.split(` calls anywhere in `scripts/lib/br-image-parser.ts` (manual grep: no matches)
- No type errors in the new module (pre-existing unrelated errors only)
