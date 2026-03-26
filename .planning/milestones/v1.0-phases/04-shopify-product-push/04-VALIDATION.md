---
phase: 04
slug: shopify-product-push
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-06
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x (already configured) |
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

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Created By | Status |
|---------|------|------|-------------|-----------|-------------------|-----------------|--------|
| 04-01-01 | 01 | 1 | SHOP-01, SHOP-06 | unit | `npx vitest run tests/shopify/template-map.test.ts` | Plan 01 Task 1 | ⬜ pending |
| 04-01-02 | 01 | 1 | SHOP-02, SHOP-07 | unit | `npx vitest run tests/shopify/variants.test.ts tests/shopify/handles.test.ts` | Plan 01 Task 2 | ⬜ pending |
| 04-02-01 | 02 | 1 | SHOP-03, SHOP-04 | unit | `npx vitest run tests/shopify/metaobjects.test.ts` | Plan 02 Task 1 | ⬜ pending |
| 04-03-01 | 03 | 2 | SHOP-01, SHOP-02, SHOP-05 | unit | `npx vitest run tests/shopify/product-push.test.ts` | Plan 03 Task 1 | ⬜ pending |
| 04-03-02 | 03 | 2 | ALL | integration | `npx tsx scripts/push-product.ts --help` | Plan 03 Task 2 | ⬜ pending |
| 04-03-03 | 03 | 2 | ALL | manual | Human verifies in Shopify admin | Plan 03 Task 3 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All test files are created inline by their respective plan tasks (TDD pattern). No separate Wave 0 scaffold needed.

- [ ] `tests/shopify/template-map.test.ts` — template suffix mapping tests (SHOP-06) — created by Plan 01 Task 1
- [ ] `tests/shopify/variants.test.ts` — variant generation tests (SHOP-02) — created by Plan 01 Task 2
- [ ] `tests/shopify/handles.test.ts` — handle determinism tests (SHOP-07) — created by Plan 01 Task 2
- [ ] `tests/shopify/metaobjects.test.ts` — metaobject handle/input/metafield tests (SHOP-03, SHOP-04) — created by Plan 02 Task 1
- [ ] `tests/shopify/product-push.test.ts` — product input building tests (SHOP-01, SHOP-02, SHOP-05) — created by Plan 03 Task 1

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Product appears in Shopify admin with correct data | SHOP-01 | Requires live Shopify store | Run push on test product, verify in admin |
| Images display correctly on product page | SHOP-05 | Visual verification needed | Check product page after push |
| Dawn template renders correctly per category | SHOP-06 | Template rendering is visual | View product in storefront |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
