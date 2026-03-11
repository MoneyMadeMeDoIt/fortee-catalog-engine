---
phase: 07-size-guide-upload
verified: 2026-03-11T13:15:00Z
status: human_needed
score: 11/11 must-haves verified
human_verification:
  - test: "Push a real product to Shopify and inspect the resulting size_guides metaobject in the Shopify admin"
    expected: "A metaobject of type size_guides appears with handle 'size-guide-{productId}', containing sizes as a JSON array, variable fields encoded as {value, unit} objects, and a custom.size_guide metafield on the product referencing it"
    why_human: "End-to-end Shopify API behavior (metaobject type definition existence, linked metafield resolution) cannot be verified by static analysis"
  - test: "Push a product whose productId has NO matching row in the spec sheet"
    expected: "Product push completes successfully; log contains 'No spec data for productId ... -- skipping size guide'; no error is thrown"
    why_human: "Requires a live run with real spec sheet data; graceful-skip path is covered by source-level tests but not exercised against the real API"
  - test: "Push a product with SPEC_SHEET_GOOGLE_SPREADSHEET_ID unset in the environment"
    expected: "Product push completes without any size guide step; no warning or error logged about the size guide"
    why_human: "Env-var absence guard is verified via source text check but requires a real push to confirm the branch is truly silent"
---

# Phase 7: Size Guide Upload Verification Report

**Phase Goal:** Running pushProduct automatically creates a size_guides metaobject from spec sheet data and links it to the product via custom.size_guide metafield
**Verified:** 2026-03-11T13:15:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | buildSizeGuideMetaobjectFields() encodes sizes as JSON string array | VERIFIED | Line 128 of metaobjects.ts: `{ key: 'sizes', value: JSON.stringify(guide.sizes) }`. Test "encodes sizes as JSON string array" passes. |
| 2 | buildSizeGuideMetaobjectFields() encodes dimension values as list of {value, unit} objects | VERIFIED | Lines 144-148 of metaobjects.ts: `JSON.stringify(variable.values.map((v) => ({ value: v, unit: 'in' })))`. Test "encodes variable values as list of {value, unit} objects" passes. |
| 3 | buildSizeGuideMetaobjectFields() limits to 5 variables and warns on overflow | VERIFIED | Lines 132-139 of metaobjects.ts: `console.warn(...)` + `variables.slice(0, MAX_VARIABLES)`. Test "includes only first 5 variables and logs warning if >5" passes. |
| 4 | buildSizeGuideMetaobjectFields() includes empty rich text for description field | VERIFIED | Lines 105-113 of metaobjects.ts: EMPTY_RICH_TEXT constant with correct shape. Test "includes empty rich text for description field" passes. |
| 5 | upsertSizeGuideMetaobject() returns the metaobject GID | VERIFIED | Lines 209-245 of metaobjects.ts: function calls UPSERT_SIZE_GUIDE, checks userErrors, returns `metaobject.id`. |
| 6 | linkSizeGuideToProduct() uses metaobject_reference type (single, not list) | VERIFIED | Lines 251-275 of metaobjects.ts: type set to `'metaobject_reference'`, value is raw GID string. Test "calls METAFIELDS_SET with correct metafield input" asserts `mf.type === 'metaobject_reference'` and `mf.value === rawGid`. |
| 7 | readSpecSheetStructured() returns raw SizeSpec[] grouped by productId | VERIFIED | Lines 95-179 of spec-sheet.ts: function returns `Map<string, SizeSpec[]>` grouped by styleName. 5 tests covering grouping, sizeOrder sort, standard fallback sort, header-only empty, and null data empty. All pass. |
| 8 | Sizes are sorted by sizeOrder column with fallback to standard size ordering | VERIFIED | Lines 148-172 of spec-sheet.ts: `hasSizeOrder` branch sorts by `_sizeOrder`, else by `STANDARD_SIZE_ORDER.indexOf`. Two dedicated tests confirm both paths. |
| 9 | pushProduct creates a size guide metaobject when spec data exists | VERIFIED | Lines 324-345 of product-push.ts: `upsertSizeGuideMetaobject` called when `productSpecs.length > 0`. Source-verification test confirms presence of `upsertSizeGuideMetaobject` in file. |
| 10 | pushProduct links the size guide to the product via custom.size_guide | VERIFIED | Line 337 of product-push.ts: `await linkSizeGuideToProduct(client, productGid, sizeGuideGid)`. Source-verification test confirms `linkSizeGuideToProduct` import. |
| 11 | pushProduct skips size guide gracefully when no spec data or env var missing | VERIFIED | Lines 325-345 of product-push.ts: outer `if (specSpreadsheetId)` guard + inner `if (productSpecs && productSpecs.length > 0)` + try/catch with `logger.warn`. Source-verification tests confirm both guard strings present. |

**Score:** 11/11 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/shopify/mutations.ts` | UPSERT_SIZE_GUIDE mutation string | VERIFIED | Lines 90-104: identical shape to UPSERT_PRINT_AREA, generic metaobjectUpsert |
| `src/shopify/metaobjects.ts` | buildSizeGuideMetaobjectFields, upsertSizeGuideMetaobject, linkSizeGuideToProduct, transformSpecsToSizeGuide, SizeGuideFields | VERIFIED | All 4 functions and 1 interface exported; 276 lines, substantive implementation throughout |
| `src/sheets/spec-sheet.ts` | readSpecSheetStructured returning Map<string, SizeSpec[]> | VERIFIED | Lines 95-179; original readSpecSheet() untouched |
| `src/shopify/product-push.ts` | Size guide integration in pushProduct flow | VERIFIED | Lines 324-345, step 13b placed after MOQ metafields, before media query |
| `tests/shopify/size-guide.test.ts` | Unit tests for size guide field encoding and spec sheet reading | VERIFIED | 17 tests, all passing — covers grouping, sort, empty-data, field encoding, 5-var limit, float parsing, linkage metafield shape, userErrors |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| src/shopify/metaobjects.ts | src/shopify/mutations.ts | import UPSERT_SIZE_GUIDE | WIRED | Line 1 of metaobjects.ts: `import { METAOBJECT_BY_HANDLE, METAFIELDS_SET, UPSERT_SIZE_GUIDE } from './mutations.js'` |
| src/shopify/metaobjects.ts | src/shopify/mutations.ts | import METAFIELDS_SET for linking | WIRED | Same import line; METAFIELDS_SET used in linkSizeGuideToProduct at line 256 |
| src/shopify/product-push.ts | src/shopify/metaobjects.ts | import upsertSizeGuideMetaobject, linkSizeGuideToProduct | WIRED | Line 6 of product-push.ts; both functions called at lines 331-337 |
| src/shopify/product-push.ts | src/sheets/spec-sheet.ts | import readSpecSheetStructured | WIRED | Line 7 of product-push.ts; called at line 328 |

---

### Requirements Coverage

The SG-01 through SG-06 requirement IDs used throughout the phase plans are phase-local identifiers defined in `07-RESEARCH.md` — they do not appear in `.planning/REQUIREMENTS.md`. This is a documentation gap: REQUIREMENTS.md has no traceability row for Phase 7, and SG-* IDs are not registered in the requirements catalogue.

The underlying behaviors those IDs represent are fully implemented and tested. The gap is purely documentary.

| Requirement | Defined In | Description | Implementation Status |
|-------------|-----------|-------------|----------------------|
| SG-01 | 07-RESEARCH.md | buildSizeGuideMetaobjectFields encodes sizes as JSON array | SATISFIED — metaobjects.ts line 128 + test |
| SG-02 | 07-RESEARCH.md | buildSizeGuideMetaobjectFields encodes dimension list correctly | SATISFIED — metaobjects.ts lines 144-148 + test |
| SG-03 | 07-RESEARCH.md | buildSizeGuideMetaobjectFields limits to 5 variables | SATISFIED — metaobjects.ts lines 132-139 + test |
| SG-04 | 07-RESEARCH.md | buildSizeGuideMetaobjectFields includes empty rich text for description | SATISFIED — metaobjects.ts EMPTY_RICH_TEXT constant + test |
| SG-05 | 07-RESEARCH.md | linkSizeGuideToProduct uses metaobject_reference (single, not list) | SATISFIED — metaobjects.ts line 263 + test asserts raw GID value |
| SG-06 | 07-RESEARCH.md | readSpecSheetStructured returns raw SizeSpec[] per product | SATISFIED — spec-sheet.ts lines 95-179 + 5 tests |
| REQUIREMENTS.md traceability | .planning/REQUIREMENTS.md | Phase 7 row in traceability table | NOT PRESENT — no SG-* IDs in REQUIREMENTS.md, no Phase 7 row in traceability table |

**Note:** REQUIREMENTS.md traceability table ends at Phase 5. Phase 7 has no entry. The SG-* identifiers exist only in RESEARCH.md and plan frontmatter. This does not block the goal — the code works — but REQUIREMENTS.md should be updated to register these IDs and add a Phase 7 traceability row.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/shopify/product-push.ts | 36 | `return null` | Info | Intentional early exit for unsupported categories (documented, tested) — not a stub |

No TODO/FIXME/PLACEHOLDER comments found. No empty implementations. No stub handlers.

---

### Human Verification Required

#### 1. End-to-end size guide creation via real Shopify API

**Test:** Run `npx tsx scripts/push-product.ts <styleID>` with a product that has rows in the spec sheet and `SPEC_SHEET_GOOGLE_SPREADSHEET_ID` set.

**Expected:** In the Shopify admin, the product has a `custom.size_guide` metafield referencing a `size_guides` metaobject whose handle matches `size-guide-{productId}`. The metaobject fields contain the correct sizes array and dimension variables.

**Why human:** Requires the `size_guides` metaobject type definition to exist in the Shopify store. If that type was never created in the admin, `metaobjectUpsert` will fail with a type-not-found error. This cannot be verified by static analysis.

#### 2. Graceful skip when no spec data exists for the product

**Test:** Run `npx tsx scripts/push-product.ts <styleID>` with a styleID whose productId is NOT present in the spec sheet.

**Expected:** Push completes without error. Log contains: `No spec data for productId "..." -- skipping size guide`.

**Why human:** The graceful-skip path is proven by source-level text checks but the real Shopify push flow cannot be exercised without live credentials and a real sheet.

#### 3. Silent skip when SPEC_SHEET_GOOGLE_SPREADSHEET_ID is unset

**Test:** Unset `SPEC_SHEET_GOOGLE_SPREADSHEET_ID` from the environment and run a product push.

**Expected:** Push completes normally with no mention of size guide in logs.

**Why human:** Requires a live push run to confirm the env-var guard branch is truly silent and does not inadvertently log anything.

---

### Summary

All 11 observable truths are verified against actual source code. All 5 required artifacts exist and are substantively implemented (not stubs). All 4 key links are wired — imports are present and callers use the imported functions at runtime. 212/212 tests pass including 17 new size-guide unit tests and 4 source-verification tests for the pushProduct integration.

The only items requiring human attention are live-API behaviors that cannot be checked statically:
1. The `size_guides` metaobject type must exist in the Shopify store before upsert will succeed.
2. The graceful-skip and silent-skip paths need a real push run to confirm end-to-end.

One documentation gap exists: REQUIREMENTS.md has no Phase 7 traceability row and the SG-* IDs are not registered in the requirements catalogue. This is a record-keeping gap, not a functional one.

---

_Verified: 2026-03-11T13:15:00Z_
_Verifier: Claude (gsd-verifier)_
