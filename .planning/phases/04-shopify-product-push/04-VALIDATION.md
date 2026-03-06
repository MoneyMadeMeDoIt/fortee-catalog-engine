---
phase: 04
slug: shopify-product-push
status: draft
nyquist_compliant: false
wave_0_complete: false
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

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | SHOP-01 | unit | `npx vitest run tests/shopify/client.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | SHOP-02 | unit | `npx vitest run tests/shopify/variants.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | SHOP-03, SHOP-04 | unit | `npx vitest run tests/shopify/metaobjects.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | SHOP-05 | unit | `npx vitest run tests/shopify/images.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-02 | 03 | 2 | SHOP-06 | unit | `npx vitest run tests/shopify/template.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-03 | 03 | 2 | SHOP-07 | integration | `npx vitest run tests/shopify/idempotent.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/shopify/client.test.ts` — Shopify GraphQL client tests (SHOP-01)
- [ ] `tests/shopify/variants.test.ts` — variant generation tests (SHOP-02)
- [ ] `tests/shopify/metaobjects.test.ts` — metaobject creation and linking tests (SHOP-03, SHOP-04)
- [ ] `tests/shopify/images.test.ts` — image upload tests (SHOP-05)
- [ ] `tests/shopify/template.test.ts` — template assignment tests (SHOP-06)
- [ ] `tests/shopify/idempotent.test.ts` — idempotent push tests (SHOP-07)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Product appears in Shopify admin with correct data | SHOP-01 | Requires live Shopify store | Run push on test product, verify in admin |
| Images display correctly on product page | SHOP-05 | Visual verification needed | Check product page after push |
| Dawn template renders correctly per category | SHOP-06 | Template rendering is visual | View product in storefront |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
