# Phase 17: Catalog Image Pollution Fix — Research

**Researched:** 2026-05-14
**Domain:** Production-hardening + scope expansion of the Phase 16 audit/fix toolchain after first real-world run revealed structural under-coverage (1 fully-fixed pid vs 36 dry-run estimate, 213 polluted pids across 453 detections in BR)
**Confidence:** HIGH on bug fixes (B-1..B-4 — read directly), HIGH on Phase 16 reuse mapping, HIGH on S&S API per-color shape (verified via existing code + official docs), MEDIUM on Model rebuild yield/cost (depends on Phase 15-style verifier behavior on Model* output — never tested), MEDIUM on D-12 scraper feasibility per brand (web search; no test fixtures yet)

## Summary

Phase 17 has one job: convert Phase 16's working-but-narrow audit/fix tooling into something that resolves the real pollution pattern. The first production run found 213 polluted pids (453 detections), and 72% of detections are in Model* columns that Tier 2 never touches. Tier 1 resolved 1 pid in production because (a) the audit hangs on a no-timeout Drive fetch, (b) supplier-canonical is style-level so 11+ canonicals were correctly rejected as "wrong color", and (c) 714 of 1012 Tier 1 attempts saw "no canonical" for brands without scrapers.

The fix is four engineering plans + three small bug patches:

1. **17-01 Drive timeout (B-1).** Add gaxios `timeout: 30_000` + 2-retry budget to the 4 Drive helpers in `src/sheets/drive.ts`. Unblocks all subsequent full-catalog runs. Required pre-requisite — any plan that follows would re-hit the hang.
2. **17-02 Per-color supplier-canonical.** Change `resolveSupplierCanonical(pid)` → `resolveSupplierCanonical(pid, colorName?)`. The S&S `/products/?style=` endpoint already returns ALL colors per call; filter client-side by `colorName` match. CSW's `/products/{handle}.json` images don't carry color tags directly — best-effort filename match. Backward-compatible: omit colorName = current behavior (first color).
3. **17-03 Model image rebuild.** Build `scripts/fix-model-images.ts`. Strategy per pid: (a) Tier 1 — fetch S&S `colorOnModel{Front,Side,Back}Image` for matching color; (b) Tier 2 — AI-generate via `generateModelImage` (already exists at `src/lib/ai-model-image.ts`, used by Phase 10 audit-runner — Phase 17 just calls it per polluted Model* slot); (c) Phase 16 verify-same-product gate post-fix. This is the biggest yield plan (312 detections of 453).
4. **17-04 D-12 scraper expansion.** Critical finding: **adidas is exclusively distributed via S&S Canada in the promo channel** [VERIFIED: ssactivewear.com/ps/adidas], so once 17-02 lands, all `CE520L`/`A702`/`A*` pids become resolvable for free (no new scraper). Same for some Bella+Canvas (S&S carries the full BELLA+CANVAS assortment). Only New Era (NE220, NE7xx) and anvil (9xx) need genuinely new scrapers. Re-rank: do nothing until 17-02 ships, then re-audit; the unreached prefixes will collapse from ~145 pids to <50.
5. **17-05 Manual triage.** Pure operator work after 17-01..17-04 reduce the residue. No new engineering.

Plus three patches (B-2 dry-run trash gap, B-3 cleanup script blind spot, B-4 OpenAI billing-hard-limit short-circuit) — each ≤1 hour.

**Primary recommendation:** Build 17-01 first (it's blocking). Build 17-02 second and re-run the audit — this alone likely lifts Tier 1 yield from 1 pid to ~50+ pids by unlocking adidas + Bella+Canvas + Gildan via the existing S&S scraper. THEN scope 17-03 and 17-04 against the residue, since the residue will be much smaller and you'll have a real cost-baseline for the Model rebuild.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP fetch timeout + retry (B-1) | `src/sheets/drive.ts` helpers | gaxios (transitive via googleapis) | All Drive ops route through one module already — 4 functions to patch |
| Per-color supplier resolution (17-02) | `src/lib/supplier-canonical.ts` | S&S REST `/products/?style=` (color filtering is client-side) | Supplier API doesn't accept colorName as a filter; existing module is the natural site to add the loop |
| Model image detection (17-03 detect) | `scripts/fix-model-images.ts` | `verifySameProduct` (already exists, Phase 16) | Reuse Phase 16 audit's Model* detection rows verbatim — they're already in the audit TSV |
| Model image supplier fetch (17-03 tier 1) | `scripts/fix-model-images.ts` | S&S REST `colorOnModel{Front,Side,Back}Image` per color | S&S returns these alongside garment URLs; cheap reuse of `fetchSSProducts` shape |
| Model image AI synthesis (17-03 tier 2) | `src/lib/ai-model-image.ts` (existing) + `scripts/fix-model-images.ts` (caller) | OpenAI gpt-image-1 | `generateModelImage` already exists; needs caller for the 3 views and a verifier-after-fix wrapper |
| OpenAI billing-hard-limit detection (B-4) | `scripts/fix-image-pollution.ts` Tier 2 | OpenAI SDK `BadRequestError.code` | Single catch site in Tier 2's loop body; set a module-level boolean and short-circuit |
| `--dry-run` Drive-trash gate (B-2) | `scripts/fix-image-pollution-manual.ts` | — | Two call sites already exist (404 + 741); add gate at trash call (429 + 712) |
| Cleanup script MANUAL/ scan (B-3) | `scripts/cleanup-checkpoint-test-data.ts` | — | One-line: add a second `findSupplierFolderId('MANUAL')` pass scoped to CHECKPOINT-TEST pids |

<phase_requirements>
## Phase Requirements

Phase 17 has no formal SPEC.md yet — the discuss-phase will produce one. The expected requirements derived from `PRODUCTION-AUDIT-FINDINGS.md` are:

| ID | Description | Research Support |
|----|-------------|------------------|
| R17-01 | Drive helper calls (`downloadFromDrive`, `getDriveFileMetadata`, `uploadToDrive`, `trashDriveFile`) must time out at 30s and retry up to 2 times on timeout | gaxios `timeout` option documented; AbortController fallback pattern from `src/shopify/clone-pusher.ts:38-49` |
| R17-02 | `supplier-canonical.ts` returns the **per-color** canonical when `colorName` is provided; falls back to first color when omitted | S&S `/products/?style=` returns all variants per call — filter client-side. CSW images lack color metadata — best-effort filename match |
| R17-03 | A new script `scripts/fix-model-images.ts` rebuilds polluted Model* slots: detect → supplier-fetch (S&S only) → AI-fallback (`generateModelImage`) → verify-same-product gate → BR + Drive write | Reuse Phase 16 audit's model_pollution rows; existing `src/lib/ai-model-image.ts:generateModelImage` is the regenerator |
| R17-04 | `supplier-canonical` dispatches to existing S&S scraper for adidas + Bella+Canvas + Gildan + Next Level pids via prefix matching (since S&S carries all of them) | adidas exclusivity verified; Bella/Gildan multi-distributed but S&S has full catalog |
| R17-05 | Operator manual triage of the residue using Phase 16's `scripts/fix-image-pollution-manual.ts` | No engineering — pure operator work |
| R17-06 (B-2) | `--dry-run` gates the `trashDriveFile` call in the manual CLI delete path | `fix-image-pollution-manual.ts:429,712` — add same gate as Sheets writes |
| R17-07 (B-3) | `cleanup-checkpoint-test-data.ts` also scans `MANUAL/CHECKPOINT-TEST-*` folders | Reuse `findSupplierFolderId` + `listAllDescendantFiles` |
| R17-08 (B-4) | Tier 2 detects OpenAI billing-hard-limit (HTTP 400 + code `billing_hard_limit_reached`) once and aborts Tier 2 entirely; per-pid retry stops | `OpenAI.BadRequestError` shape; check `err.code` or `err.message.includes('Billing hard limit')` |
</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

**No CONTEXT.md exists yet** — Phase 17 is at research stage. The user has provided the following implicit constraints in the spawn prompt:

### Locked Decisions (implicit from spawn prompt)

- **D17-1** Phase 17 scope is the 5 plans + 3 cleanup items in `.planning/research/phase17-prep/PRODUCTION-AUDIT-FINDINGS.md`. Don't expand scope.
- **D17-2** v3.0 milestone is the parent but **hasn't been formally opened**. Don't assume v3.0 scope beyond these items.
- **D17-3** Operator is on a **personal-scale OpenAI budget**. Propose cost-efficient approaches for 17-03 (Model rebuild touches ~213 pids × 3 views = 600+ potential AI generations).
- **D17-4** Treat dry-run estimates with skepticism in recommendations. The 36-pid Tier 1 estimate yielded 1 pid in production — a 36× over-estimate.
- **D17-5** Reuse Phase 16's helpers (trail, supplier-canonical, verify-same-product, Drive helpers) verbatim. Phase 17 is incremental, not a redesign.

### Claude's Discretion

- Exact API surface for the per-color supplier-canonical change (colorName as second positional arg vs options object).
- Whether `fix-model-images.ts` is a new script or a Tier 4 inside `fix-image-pollution.ts`. (Recommend NEW — clearer ownership, easier to gate by `--model-only`.)
- Tier 1 vs Tier 2 ordering inside `fix-model-images.ts` — recommend supplier-first since S&S model images are free.
- Whether B-4 short-circuit also writes a sentinel row to the trail (recommend YES — operator should see Tier 2 was bypassed, not silently skipped).
- Whether 17-04 introduces a `BC_*` / `GIL_*` synthetic supplier prefix for adidas/Bella/Gildan dispatched-via-S&S pids, or just hardcodes the brand-pid map inside `resolveSupplierCanonical`. Recommend the latter — fewer moving parts.
- Test fixture strategy for the Model rebuild (mocked OpenAI image responses vs synthetic Buffers).

### Deferred Ideas (OUT OF SCOPE)

- Adding entirely new suppliers (anvil 9xx, New Era proprietary NE2xx codes) — these may need 17-04 follow-up only after the S&S-routable pids are cleared
- Phase 15 garment-type classifier extension to headwear (open issue from Phase 16 SUMMARY)
- Baseline category cleanup for the 1,494 CSW rows
- Sweep of Sheet1 (44k rows) — Phase 17 stays on BR like Phase 16
- Web UI for manual triage
- Automated weekly regression runs
- Migrating to PromoStandards SOAP API for any supplier — out of scope; existing custom REST clients are sufficient for the brands we care about
</user_constraints>

## Project Constraints (from CLAUDE.md)

Global `CLAUDE.md` (verified, user-level): security (no hardcoded secrets, validate input at boundaries, parameterized queries), code quality (simplest working solution, no over-engineering), error handling (handle at right level, don't swallow), verify it works before completing. No project-local `CLAUDE.md`.

User memory directives that bind Phase 17:

- **`feedback_drive_update_in_place`** — uploadToDrive returns SAME fileId for same filename; compare origFileId vs newFileId before trash. Already wired through Phase 16's tier1Fix + tier2Fix + manual CLI; Phase 17's `fix-model-images.ts` MUST inherit the same compare-before-trash pattern.
- **`feedback_strict_side_profile`** — AI side gens must be true 90° profile, NOT three-quarter showing front print. `supplier-canonical.ts` already enforces "only `colorFrontImage` is canonical" (never `colorSideImage`). Phase 17's Model rebuild does NOT touch DirectSideImage — Model* and DirectSide* are different columns.
- **`feedback_never_delete_sheets`** — merge into existing tabs, never delete+recreate. Phase 17 doesn't touch tab structure.
- **`feedback_concise_summaries`** — terse replies, no sectioned recap blocks. Applies to commit messages + PR descriptions, not RESEARCH.md.

## Integration Map

New files Phase 17 creates:

| Path | Purpose | Depends on |
|------|---------|------------|
| `scripts/fix-model-images.ts` | Detect + fix polluted Model* slots (Tier 1 S&S supplier fetch + Tier 2 AI synthesis via `generateModelImage`) | `src/sheets/drive.ts` (helpers), `src/lib/ai-model-image.ts` (existing — generator), `src/lib/verify-same-product.ts` (verifier-after-fix), `src/lib/supplier-canonical.ts` (S&S color resolver — needs 17-02 first), `src/lib/image-pollution-trail.ts` (trail) |
| `tests/scripts/fix-model-images.test.ts` | Unit tests for the new script (DI seam mirroring Phase 16 audit) | Vitest, OpenAI mock pattern from `tests/lib/verify-same-product.test.ts` |

Existing files Phase 17 modifies (extend only — no delete-and-rewrite):

| Path | Change | Plan |
|------|--------|------|
| `src/sheets/drive.ts` | Add per-call timeout option to all 4 helpers (`downloadFromDrive`, `getDriveFileMetadata`, `trashDriveFile`, `uploadToDrive`). Wrap retry-once around timeouts | 17-01 |
| `src/lib/supplier-canonical.ts` | Change signature: `resolveSupplierCanonical(pid, colorName?)`. S&S branch filters returned variants by `colorName`. CSW branch best-effort. Add adidas / Bella / Gildan / Next Level dispatch via S&S branch when pid matches `KNOWN_SUPPLIER_PREFIXES` | 17-02, 17-04 |
| `scripts/fix-image-pollution.ts` | (a) Pass `colorName` from BR row into `supplierCanonicalFn` call. (b) Wrap the Tier 2 OpenAI loop in a billing-hard-limit short-circuit (B-4). | 17-02, B-4 |
| `scripts/audit-image-pollution.ts` | Pass `colorName` into `supplierCanonicalFn` (audit also calls it for Pass 2 verifier-canonical). | 17-02 |
| `scripts/fix-image-pollution-manual.ts` | Gate `trashDriveFileFn` call at lines 429 + 712 behind `!deps.args.dryRun` (matching the Sheets-write gate). Pass `colorName` into supplierCanonicalFn for FrontImage SoT resolution. | B-2, 17-02 |
| `scripts/cleanup-checkpoint-test-data.ts` | After CHECKPOINT-TEST/ pass, also locate `MANUAL/` folder and trash any descendants whose names start with `CHECKPOINT-TEST-` | B-3 |
| `src/lib/image-pollution-trail.ts` | (Optional) Add a new operation type `TIER2_BUDGET_EXHAUSTED` for B-4's sentinel row. Existing TrailRow.operation is a string union; either widen it or use `MANUAL_SKIP` with notes. Recommend NEW operation. | B-4 |

Phase 16 surface fully reused (no changes needed):

| Component | Reuse | Notes |
|-----------|-------|-------|
| `src/lib/image-pollution-trail.ts:appendTrailRow + loadProcessedPids` | Yes | Phase 17's new model-fix script writes to the SAME trail TSV so resume-from-trail works across both fix scripts |
| `src/lib/verify-same-product.ts:verifySameProduct` | Yes | Used as verifier-after-fix in Phase 17's Model rebuild; same prompt, same color-blind semantics |
| `src/sheets/drive.ts:extractFileId` | Yes | No changes |
| `src/sheets/drive.ts:uploadToDrive` (after 17-01 timeout patch) | Yes | Compare-before-trash pattern inherited |
| `src/sheets/writer.ts:writeUpdates` | Yes | Atomic per-cell write — already works |
| `src/sheets/column-map.ts:columnToLetter` | Yes | No changes |

## Critical Architectural Findings

### Finding 1: adidas is exclusive to S&S in the promo channel

This is the **highest-leverage finding** in the research.

> "S&S Activewear is the exclusive wholesale distributor of adidas imprintable apparel for the promotional products and decorated apparel market." [VERIFIED: ssactivewear.com/ps/adidas]

**Impact:** Every `A702`, `A231`, `A267`, `CE520L`, `A*` pid in BR is resolvable through the existing S&S scraper once 17-02 lands. No new scraper required for adidas — it was always there, just blocked by the prefix dispatcher in `resolveSupplierCanonical` (line 246: `if (/^S/i.test(pid))`). Phase 17 needs to either widen the S&S branch to accept the `KNOWN_SUPPLIER_PREFIXES` adidas pids or hardcode an adidas-pid set.

S&S Canada's product search will resolve adidas style codes — verified via `scripts/fetch-ss-rest-sizes.ts:80-92` which already uses `/styles/?search=<pid>` as a generic resolver. The function does NOT require `pid` to start with `S` — that constraint exists only in `supplier-canonical.ts:246`. **Removing or widening that prefix check unlocks adidas for free.**

### Finding 2: Bella+Canvas, Gildan, Next Level distributed via multiple wholesalers including S&S

> "S&S carries the full BELLA+CANVAS wholesale assortment, including t-shirts, tanks, long sleeves, fleece hoodies, crewnecks, sweatpants, and youth styles."

[VERIFIED: ssactivewear.com — Bella+Canvas, Gildan, and Next Level all explicitly carried as full-line brands].

**Impact:** The numeric Bella pids (3001, 3911, 6110, 8882, 18500, etc.), Gildan (5000-series, 18000-series), and Next Level (1510, 3900, 3911, 9002) — all listed in `KNOWN_SUPPLIER_PREFIXES` — are resolvable via S&S's search-by-style-name endpoint. The path forward for 17-04 is: **dispatch them through the existing S&S branch**, not build separate Bella / Gildan / Next Level scrapers.

This is the same trick that adidas exploits. The `/styles/?search=3001` query returns Bella's 3001 in S&S's catalog. Verified pattern exists in `fetch-ss-rest-sizes.ts:80-94`.

### Finding 3: New Era and anvil need genuinely new scrapers

> [No public results for NE220 as a vendor styleID; vendor's own catalog (neweracap.com) uses different numbering than promo wholesalers.]

**Impact:** New Era's own product line (`NE220`, `NE7xx`, `NE2xx`) uses retail style numbers that don't appear in S&S Canada's catalog. SanMar [VERIFIED] carries some New Era SKUs but with their own SKU prefixes (`9489`, `3076`, `8701`) — NOT `NE220`. anvil 9xx is similar — anvil's own retail codes; S&S may or may not carry them.

**Recommendation for 17-04:** AFTER 17-02 ships and you re-run the audit, the actual pid set with no canonical is much smaller than 145. At that point:
- Spend manual triage on New Era / anvil residue (likely <15 pids)
- Skip building a true New Era scraper unless a follow-up phase needs it

### Finding 4: S&S `/products/?style=N` returns ALL colors in one call

Verified via `scripts/fetch-ss-images-fixed.ts:118-124`. The endpoint signature is:

```
GET /products/?style=<styleID>&fields=colorName,colorFrontImage,colorBackImage,...
```

Response is an array of variant objects, one per (color, size) combination. Filtering by colorName is **client-side** because the API doesn't accept a colorName query parameter [VERIFIED: api.ssactivewear.com/V2/Products.aspx — supports `style`, `styleid`, `partnumber`, `Warehouses`, `fields`; no colorName].

This means `resolveSupplierCanonical(pid, colorName)` is implemented as: fetch all variants → find the first whose `colorName.toUpperCase() === colorName.toUpperCase()` → return that variant's `colorFrontImage`. Cost: same as today (one /products/ call per pid). **Zero new API calls** — just better filtering.

CSW does NOT expose per-color image URLs. CSW's `/products/{handle}.json` returns one `images` array with filenames like `L00660-Black-front.jpg` — color is parsed from filename. Best-effort match for 17-02's CSW branch:

```typescript
// CSW branch — match images[].filename containing colorName
const colorLower = colorName.toLowerCase().replace(/\s+/g, '-');
const match = product.images.find(img =>
  img.filename.toLowerCase().includes(colorLower)
);
return match ? { url: match.src, source: 'csw', styleId: handle } : null;
```

This will sometimes fail (custom colors not in filename) and fall through to the existing "first image" behavior. That's correct — better to be conservative.

## Standard Stack

### Core (unchanged from Phase 16)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openai` | (project pinned) | Vision verifier (gpt-4o-mini) + image gen (gpt-image-1) | Existing — Phase 10 / 15 / 16 all use this |
| `googleapis` | (project pinned) | Drive + Sheets REST | Existing — service-account auth wired |
| `sharp` | (project pinned) | Image resize for gpt-image-1 input | Existing — used by `ai-model-image.ts:94-97` |
| `cheerio` | (project pinned) | CSW scraper HTML parse | Existing — unchanged |

### New utilities Phase 17 needs

None. All required utilities already exist:

| Need | Existing Provider | Notes |
|------|-------------------|-------|
| AbortController + timeout for `fetch()` | Native Node + verified pattern in `src/shopify/image-standardizer.ts:244-259`, `src/shopify/clone-pusher.ts:35-51` | 30s timeout + 2-retry, copy as-is |
| gaxios timeout option | Native to `googleapis` SDK | Passed via 2nd arg to `drive.files.get/.update/.list/.create` |
| OpenAI error code detection | `OpenAI.BadRequestError` class — already used in `ai-image-generator.ts:255` | Add `code === 'billing_hard_limit_reached'` check |

**Installation:** None required.

**Version verification:** Skipped — Phase 17 introduces no new dependencies. Phase 16's pins remain authoritative.

## Architecture Patterns

### System Architecture Diagram

```
Phase 17 entrypoint (operator command)
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Plan 17-01: Drive timeout (B-1 fix)                          │
│  src/sheets/drive.ts                                         │
│   - downloadFromDrive   ┐                                    │
│   - getDriveFileMetadata├── all wrapped with                 │
│   - trashDriveFile      │   { timeout: 30_000 } gaxios option│
│   - uploadToDrive       ┘   + retry-once on timeout error    │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Plan 17-02 + 17-04: Per-color + scraper expansion            │
│  src/lib/supplier-canonical.ts                               │
│   resolveSupplierCanonical(pid, colorName?)                  │
│     ├─ H08* → null (D-22)                                    │
│     ├─ /^S/i → S&S /products/?style=N → filter by colorName  │
│     ├─ /^L/i → CSW /products/{handle}.json → filename match  │
│     ├─ KNOWN_SUPPLIER_PREFIXES[pid] → DISPATCH TO S&S BRANCH │
│     │    (adidas, Bella, Gildan, Next Level, Comfort Colors, │
│     │     American Apparel — all carried by S&S Canada)      │
│     └─ else → null                                           │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Re-run Phase 16's audit (scripts/audit-image-pollution.ts)   │
│   - Reads BR (with timeout-protected Drive calls)            │
│   - Per-color canonical resolution → fewer color-mismatch    │
│     false positives                                          │
│   - More pids get canonical → more "tier 1 recommended"      │
│   - Same TSV format; same trail format                       │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Plan B-4 patch: scripts/fix-image-pollution.ts (Tier 2)      │
│   try {                                                      │
│     await generateGarmentView(...)                           │
│   } catch (err) {                                            │
│     if (err.code === 'billing_hard_limit_reached'            │
│         || err.message.includes('Billing hard limit')) {     │
│       moduleBillingExhausted = true;                         │
│       break Tier2Loop;  // abort, don't retry next pid       │
│     }                                                        │
│   }                                                          │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Plan 17-03: scripts/fix-model-images.ts (NEW — biggest yield)│
│                                                              │
│  For each model_pollution row in audit TSV:                  │
│   1. Read BR row (raw); extract pid, colorName, currentUrl   │
│   2. Tier 1: try supplier-canonical for model view           │
│      (S&S returns colorOnModel{Front,Side,Back}Image)        │
│   3. If supplier returned: download → verifySameProduct vs   │
│      currentFront (verifier-after-fix)                       │
│       - match=true → uploadToDrive + writeUpdates + trail    │
│       - match=false → fall through to Tier 2                 │
│   4. Tier 2: generateModelImage(frontBuf, gender, tracker)   │
│      then verifySameProduct(generated, currentFront)         │
│       - match=true → uploadToDrive + writeUpdates + trail    │
│       - match=false → cascade to Tier 3                      │
│   5. If both tiers fail: append manual queue                 │
│                                                              │
│  Cost budgeting: --max-cost flag (e.g., --max-cost=20) gates │
│  generateModelImage spend; CostTracker passed through.       │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Plan 17-05: operator manual triage (no engineering)          │
│   npx tsx scripts/fix-image-pollution-manual.ts              │
│   (after B-2 patch — --dry-run gate trash too)               │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Re-audit (scripts/audit-image-pollution.ts --re-audit)       │
│   R10: 0 unresolved pids?                                    │
│     yes → Phase 17 closes                                    │
│     no  → operator triage residue                            │
└──────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/
├── lib/
│   ├── supplier-canonical.ts   # MODIFIED — colorName param + KNOWN_PREFIXES dispatch
│   ├── ai-model-image.ts       # existing — Phase 10 — Phase 17 just calls it
│   ├── image-pollution-trail.ts # existing — Phase 16 — unchanged
│   ├── verify-same-product.ts  # existing — Phase 16 — unchanged
│   └── …
├── sheets/
│   └── drive.ts                # MODIFIED — timeout + retry on 4 helpers
└── …

scripts/
├── audit-image-pollution.ts        # MODIFIED — pass colorName into canonical
├── fix-image-pollution.ts          # MODIFIED — pass colorName + B-4 short-circuit
├── fix-image-pollution-manual.ts   # MODIFIED — pass colorName + B-2 dry-run gate
├── fix-model-images.ts             # NEW — Plan 17-03
├── cleanup-checkpoint-test-data.ts # MODIFIED — also scan MANUAL/ (B-3)
└── …
```

### Pattern 1: gaxios timeout per request

**What:** Pass `timeout` option to the request config (2nd argument of Drive client method calls).

**When to use:** Every Drive API call in `src/sheets/drive.ts` after Phase 17.

**Example:**

```typescript
// Source: gaxios README (githubcom/googleapis/gaxios — verified)
// Phase 17 17-01 — add to all 4 helpers in src/sheets/drive.ts

const DRIVE_TIMEOUT_MS = 30_000;
const DRIVE_RETRY = 2;

export async function downloadFromDrive(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DRIVE_RETRY; attempt++) {
    try {
      const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer', timeout: DRIVE_TIMEOUT_MS },
      );
      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      lastErr = err;
      // Retry only on timeouts / aborts; rethrow on permanent errors (404, 403, 5xx)
      const code = (err as { code?: string | number })?.code;
      const message = (err as Error)?.message ?? '';
      const isTimeout =
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        message.includes('aborted') ||
        message.includes('timeout');
      if (!isTimeout) throw err;
      logger.warn(
        `[drive] downloadFromDrive timeout (attempt ${attempt + 1}/${DRIVE_RETRY + 1}) on ${fileId}`,
      );
    }
  }
  throw lastErr ?? new Error(`downloadFromDrive failed after ${DRIVE_RETRY + 1} attempts`);
}
```

**Notes:**

- gaxios uses an internal `AbortSignal` when `timeout` is set; this is documented in the gaxios README and is the standard googleapis pattern.
- `drive.files.get`, `.update`, `.list`, `.create` all accept this options object as their second positional argument.
- Retry is bounded — if the call hung once for 2.5 hours, retrying twice with 30s timeouts costs at most 60s of extra latency.

### Pattern 2: Per-color supplier-canonical signature

**What:** Optional second parameter; backward-compatible.

**When to use:** Replaces every call site of `resolveSupplierCanonical(pid)` to pass the row's colorName when available.

**Example:**

```typescript
// Source: Phase 17 17-02 — extends src/lib/supplier-canonical.ts

export async function resolveSupplierCanonical(
  pid: string,
  colorName?: string,
): Promise<CanonicalResult | null> {
  // Headwear exclusion unchanged.
  if (/^H08/i.test(pid)) return null;

  // Determine if we route this pid through the S&S branch.
  //  - Native S* pids
  //  - KNOWN_SUPPLIER_PREFIXES pids (adidas/Bella/Gildan/Next Level/Comfort Colors/American Apparel
  //    — all carried by S&S Canada per 17-RESEARCH Finding 1+2)
  const routeViaSS =
    /^S/i.test(pid) ||
    /^A/i.test(pid) ||      // adidas
    /^CE/i.test(pid) ||     // adidas alt prefix
    KNOWN_SUPPLIER_PREFIXES[pid] !== undefined;

  if (routeViaSS) {
    await throttle('ss');
    const auth = getSSAuth();
    const ssId = await resolveSSStyleId(pid, auth);
    if (ssId === null) return null;

    await throttle('ss');
    const products = await ssGet<Array<{ colorName?: string; colorFrontImage?: string }>>(
      `/products/?style=${ssId}&fields=colorName,colorFrontImage`,
      auth,
    );
    if (!products || products.length === 0) return null;

    // 17-02: filter by colorName if provided. Best-effort case-insensitive match.
    let match: typeof products[0] | undefined;
    if (colorName) {
      const target = colorName.toUpperCase().trim();
      match = products.find(
        (p) => p.colorFrontImage && String(p.colorName ?? '').toUpperCase().trim() === target,
      );
    }
    // Fall back to first front-image-bearing variant (preserves existing behavior).
    if (!match) {
      match = products.find((p) => p.colorFrontImage);
    }
    if (!match || !match.colorFrontImage) return null;

    return { url: makeSSLargeUrl(match.colorFrontImage), source: 'ss', styleId: ssId };
  }

  // CSW unchanged (best-effort filename match — see below).
  if (/^L/i.test(pid)) {
    // … as in current code, with optional colorName filename-match overlay
  }

  return null;
}
```

**Tradeoffs:**

- **Cost stable.** Same number of S&S API calls (one resolve + one /products/) — just smarter filtering on the response.
- **No breaking changes.** Existing callers that pass only `pid` continue to work (colorName undefined → falls back to first-front behavior).
- **CSW limitation surfaced honestly.** The CSW images array has no first-class color metadata. Filename match is fragile — document it in the JSDoc as best-effort.

### Pattern 3: Model image rebuild flow

**What:** Per-pid, per-Model-column reconstruction with supplier-first / AI-fallback.

**When to use:** `scripts/fix-model-images.ts` (Plan 17-03 main loop).

**Example (skeleton, ~150 lines once expanded):**

```typescript
// Source: Phase 17 17-03 — scripts/fix-model-images.ts

const MODEL_COLUMNS = ['ModelFrontImage', 'ModelSideImage', 'ModelBackImage'] as const;
type ModelColumn = (typeof MODEL_COLUMNS)[number];

interface ModelFixResult {
  pid: string;
  column: ModelColumn;
  status: 'tier1_supplier' | 'tier2_ai' | 'verifier_rejected' | 'manual_cascade' | 'skipped';
  newUrl?: string;
  cost?: number;
}

async function fixModelImage(
  pid: string,
  column: ModelColumn,
  brEntry: BrRow,
  deps: ModelFixDeps,
  runId: string,
  costTracker: CostTracker,
): Promise<ModelFixResult> {
  const colorName = String(brEntry.row[brIndex.headerMap['colorName'] ?? -1] ?? '');
  const currentUrl = String(brEntry.row[brIndex.headerMap[column] ?? -1] ?? '');
  const frontUrl = String(brEntry.row[brIndex.headerMap['FrontImage'] ?? -1] ?? '');
  const frontFid = extractFileId(frontUrl);
  if (!frontFid) return { pid, column, status: 'skipped' };

  let frontBuf: Buffer;
  try {
    frontBuf = await deps.downloadFromDriveFn(deps.driveClient, frontFid);
  } catch {
    return { pid, column, status: 'skipped' };
  }

  // -------------------------------------------------------------------------
  // Tier 1: Try the S&S supplier-canonical for this MODEL view.
  // (Phase 16's supplier-canonical only returns the garment Front URL — we need
  //  a model URL here. So this script makes its own /products/ call directly
  //  and asks for colorOnModelFrontImage / colorOnModelSideImage / colorOnModelBackImage.)
  // -------------------------------------------------------------------------
  const view: 'front' | 'side' | 'back' =
    column === 'ModelFrontImage' ? 'front' :
    column === 'ModelSideImage' ? 'side' : 'back';

  const supplierModelUrl = await deps.fetchSSModelImageFn(pid, colorName, view);
  if (supplierModelUrl) {
    let supplierBuf: Buffer;
    try {
      supplierBuf = await deps.downloadImageFn(supplierModelUrl);
    } catch {
      supplierBuf = Buffer.alloc(0);
    }
    if (supplierBuf.length > 0) {
      // Verifier-after-fix: supplier model image must be SAME PRODUCT as current Front.
      const verify = await deps.verifySameProductFn(deps.openai, supplierBuf, frontBuf);
      await deps.appendTrailRowFn({
        timestamp_iso: new Date().toISOString(),
        pid,
        operation: verify.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
        column_or_path: column,
        old_value: currentUrl,
        new_value: supplierModelUrl,
        tier: 1,
        run_id: runId,
        notes: `phase17-model-rebuild tier1: ${verify.reason}`,
      });
      if (verify.match) {
        const newUrl = await commitFix(pid, column, supplierBuf, currentUrl, 'SS', brEntry, deps, runId, 1);
        return { pid, column, status: 'tier1_supplier', newUrl };
      }
      // verifier rejected → fall through to Tier 2
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2: AI synthesis via generateModelImage.
  // generateModelImage uses describeGarment(front) to label the garment, then
  // images.edit() with the editorial e-commerce prompt. ~$0.03 per call.
  // -------------------------------------------------------------------------
  if (!deps.args.allowAi) {
    // Operator opted out of Tier 2 — cascade to manual.
    return { pid, column, status: 'manual_cascade' };
  }
  const gender = inferGender(brEntry.row, brIndex.headerMap);
  const regen = await deps.generateModelImageFn(frontBuf, gender, costTracker, deps.openai);
  if (!regen) {
    // Either budget exhausted or content policy. Cascade.
    return { pid, column, status: 'manual_cascade', cost: 0 };
  }
  // Verify the AI-generated model image is still the same garment as the front.
  const verify = await deps.verifySameProductFn(deps.openai, regen.buffer, frontBuf);
  await deps.appendTrailRowFn({
    timestamp_iso: new Date().toISOString(),
    pid,
    operation: verify.match ? 'VERIFIER_PASS' : 'VERIFIER_FAIL',
    column_or_path: column,
    old_value: currentUrl,
    new_value: '<ai-buffer>',
    tier: 2,
    run_id: runId,
    notes: `phase17-model-rebuild tier2: ${verify.reason}`,
  });
  if (!verify.match) {
    return { pid, column, status: 'verifier_rejected', cost: regen.cost };
  }
  const newUrl = await commitFix(pid, column, regen.buffer, currentUrl, 'AI', brEntry, deps, runId, 2);
  return { pid, column, status: 'tier2_ai', newUrl, cost: regen.cost };
}
```

**Key design points:**

1. **Tier 1 (supplier) is always cheaper** than Tier 2 (AI synthesis), so try it first. S&S's `colorOnModel{Front,Side,Back}Image` fields are FREE (covered by existing API quota).
2. **Tier 2 has a `--allow-ai` flag** (operator opts in). Default OFF for the personal-scale budget guardrail per D17-3.
3. **Verifier-after-fix is mandatory** on BOTH tiers. Phase 16's `verifySameProduct` is exactly the right check — "is this model photo of the same garment as the front?"
4. **CostTracker is honored.** `generateModelImage` already accepts a CostTracker (`src/lib/ai-model-image.ts:127-155`) and respects it.

### Pattern 4: Cost-efficient Model rebuild strategy

This addresses D17-3 directly. **600 generations × $0.03/call ≈ $18-20 worst case** if every Model* slot needs AI fallback. Realistic numbers given Finding 1 + 2:

| Tier | Estimated pids | Per-pid cost | Subtotal |
|------|----------------|--------------|----------|
| Tier 1 (S&S supplier — adidas/Bella/Gildan included) | ~100 of 213 polluted pids | $0 | $0 |
| Tier 2 (AI) for remaining | ~100 pids × ~2 views avg | $0.03/view = $0.06/pid | ~$6 |
| Tier 3 (manual cascade) | ~13 pids | $0 | $0 |
| **Total** | ~213 pids | | **~$6 AI** |

**Recommendations:**

1. **Run Tier 1 alone first** (`--tier1-only`). Free. Surfaces actual residue size.
2. **Sample-test Tier 2 on 10 pids** before unleashing the full set. $0.30 of evidence before $6 commitment.
3. **Cap Tier 2 budget** at `--max-cost=10` so the operator can't get surprised.
4. **Skip ModelSideImage AI generation** if a `--skip-side` flag is set. Phase 15's verifier explicitly says "strict 90° profile" is hard to generate — model side views with editorial framing per `buildModelImagePrompt` are even harder. Recommend the operator iterate on front + back AI; manually triage sides.

### Anti-Patterns to Avoid

- **Don't use Phase 15's `verifyGarmentTypeMatch` for Model rebuild verification.** That verifier returns true for "both are hoodies" — but a Model image might be the right product on the wrong model (different garment color or print). Use `verifySameProduct` (Phase 16) instead — it's stricter and color-blind by default.
- **Don't pass the polluted Model* image as the reference** in `verifySameProduct`. The reference must be the **current FrontImage** (assumed correct unless 17-02 Tier 1 already fixed it). Phase 16's pattern of "front is the source of truth for back/side/model" applies directly.
- **Don't retry per-pid on OpenAI billing-hard-limit.** The error is account-level; retry will fail the same way 213 times. Detect it once, set a module flag, abort the loop, exit with a clear summary.
- **Don't blanket the `KNOWN_SUPPLIER_PREFIXES` dispatch.** Headwear pids (Richardson 168, 112) ARE in the allowlist but are out-of-scope per D-22. Confirm `/^H08/i` check fires FIRST before the prefix dispatch.
- **Don't try to ship a Bella+Canvas / Gildan / anvil scraper.** Per Finding 2 the brands you care about are all in S&S. Per Finding 3 the brands NOT in S&S (New Era proprietary codes, anvil) are <15 pids and better handled via manual triage than a new scraper.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP fetch timeout | Custom timer + manual abort | Existing pattern in `src/shopify/image-standardizer.ts:244-259` (AbortController + setTimeout) for raw fetch; gaxios `timeout` option for googleapis | Both already proven in repo |
| Model image generator | Custom prompt + images.edit() loop | `src/lib/ai-model-image.ts:generateModelImage` (existing, used by audit-runner) | Already has Vision-describe + retry + content-policy handling |
| Same-product verifier | New prompt | `src/lib/verify-same-product.ts:verifySameProduct` (Phase 16) | Already color-blind + JSON-mode + fallback |
| OpenAI error code detection | String-match every error | `err instanceof OpenAI.BadRequestError && err.code === 'billing_hard_limit_reached'` | SDK exposes typed codes; do not parse messages |
| Supplier resolver dispatch | New script per brand | Extend `resolveSupplierCanonical` per-pid via KNOWN_SUPPLIER_PREFIXES | One dispatcher, easier to test |
| Trail logging | New TSV format | `src/lib/image-pollution-trail.ts:appendTrailRow` (Phase 16) — same trail file, same ops vocab | Cross-script resume works automatically |
| Atomic BR cell update | Custom REST | `src/sheets/writer.ts:writeUpdates` | Already chunks, RAW input, auth handled |
| Drive upload + compare-before-trash | Reimplement | `uploadToDrive` + `extractFileId` + `trashDriveFile` (Phase 16 wired) | Compare-before-trash pattern proven in Phase 16 production |
| Cell address conversion | Manual base-26 | `src/sheets/column-map.ts:columnToLetter` | Existing |
| Adidas / Bella / Gildan scrapers | Custom HTTP clients per brand | Dispatch via existing S&S branch | All carried by S&S Canada — same scraper, different prefix routing |

**Key insight:** Phase 17 is a **wiring + filtering** phase, not a code-generation phase. Almost every problem has an existing solution in the Phase 14/15/16 codebase; the work is connecting them with smarter dispatch and filtering.

## Runtime State Inventory

Phase 17 is not a rename/refactor/migration — it's a feature addition on top of Phase 16's audit/fix tooling. The state inventory categories below are checked explicitly per gsd-research-phase methodology.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None requiring migration. Trail TSV format (Phase 16) is unchanged. The `tmp/image-pollution-fix-trail-{date}.tsv` is append-only and Phase 17's new model-fix script writes the same schema. | None |
| Live service config | None. Drive folder structure (`<supplier>/<pid>/`) is unchanged. S&S API base URL unchanged. CSW Shopify URL unchanged. | None |
| OS-registered state | None. No Windows Task Scheduler / pm2 / launchd / systemd registrations. | None |
| Secrets/env vars | All Phase 16 env vars unchanged: `OPENAI_API_KEY`, `SS_ACCOUNT_NUMBER`, `SS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DRIVE_IMAGES_FOLDER_ID`. No new secrets needed. | None |
| Build artifacts / installed packages | None. No new npm deps introduced. No build step changes. | None |

**Nothing found in any category requiring migration. The Phase 17 changes are purely code + test additions on top of Phase 16's stable surface.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All scripts | ✓ | v24.x (per `feedback_node_v24_tls` global memory + Phase 14 notes) | — |
| `OPENAI_API_KEY` env | 17-03 Tier 2 + Phase 16 inheritance | ✓ when topped up; ✗ if billing hard-limit | — | B-4 short-circuit detects + aborts Tier 2 gracefully |
| `SS_ACCOUNT_NUMBER` + `SS_API_KEY` | 17-02 + 17-03 Tier 1 | ✓ (operator-provided per Phase 9 setup) | — | None — supplier fetch can't run without these |
| `GOOGLE_*` Drive/Sheets creds | All scripts | ✓ | — | None |
| `NODE_OPTIONS=--use-system-ca` | Node v24 Google OAuth TLS | (operator must set per invocation) | — | Documented in Phase 14 runbook + Phase 16 RESEARCH |
| `openai` SDK | Verifiers + image gen | ✓ (existing) | (project pinned) | — |
| `googleapis` SDK | Drive + Sheets | ✓ | (project pinned) | — |
| `sharp` | Image resize | ✓ | (project pinned) | — |
| `cheerio` | CSW scraper (no Phase 17 changes) | ✓ | (project pinned) | — |

**Critical operational note:** `NODE_OPTIONS=--use-system-ca` must be set when running ANY Phase 17 script that calls Google APIs on Node v24, otherwise `UNABLE_TO_VERIFY_LEAF_SIGNATURE` against `oauth2.googleapis.com`. Phase 17 inherits this from Phase 14 + 16 runbook.

**No new dependencies. No new env vars. No new infrastructure.**

## Validation Architecture (Nyquist Dim 8 evidence map)

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (verified — Phase 16 ships 80 tests against this framework) |
| Config file | `vitest.config.*` (Phase 16 pattern) |
| Quick run command | `npx vitest run tests/{lib|scripts}/<file>.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| R17-01 | Drive helpers timeout at 30s + retry once | unit (mocked drive.files.get throwing AbortError) | `npx vitest run tests/sheets/drive.test.ts` | ❌ Wave 0 — `tests/sheets/drive.test.ts` (new file) |
| R17-02 | `resolveSupplierCanonical(pid, colorName)` returns matching color variant | unit (mocked fetch returning multi-color products) | `npx vitest run tests/lib/supplier-canonical.test.ts -t "per-color"` | ✓ extend existing `tests/lib/supplier-canonical.test.ts` |
| R17-03 | `fix-model-images.ts` tier 1 path: supplier model image fetched + verifier passes + BR written | unit + DI seam (mock openai, supplierFn, driveClient) | `npx vitest run tests/scripts/fix-model-images.test.ts` | ❌ Wave 0 — `tests/scripts/fix-model-images.test.ts` (new file) |
| R17-04 | adidas/Bella/Gildan pids route via S&S branch in canonical | unit | `npx vitest run tests/lib/supplier-canonical.test.ts -t "known-prefix routing"` | ✓ extend existing |
| R17-06 (B-2) | `--dry-run` blocks `trashDriveFileFn` in manual CLI delete path | unit (mock trashDriveFileFn, assert NOT called when args.dryRun=true) | `npx vitest run tests/scripts/fix-image-pollution-manual.test.ts -t "dry-run blocks trash"` | ✓ extend existing |
| R17-07 (B-3) | Cleanup script walks MANUAL/ folder | unit (mock drive.files.list) | `npx vitest run tests/scripts/cleanup-checkpoint-test-data.test.ts` | ❌ Wave 0 — new test file |
| R17-08 (B-4) | Tier 2 short-circuits on first billing-hard-limit, skips remaining pids | unit (mock generateGarmentView throwing BadRequestError with code) | `npx vitest run tests/scripts/fix-image-pollution.test.ts -t "billing hard limit"` | ✓ extend existing |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/<modified-area>/*.test.ts`
- **Per wave merge:** `npx vitest run tests/lib/ tests/scripts/ tests/sheets/`
- **Phase gate:** Full suite green (`npx vitest run`) before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/sheets/drive.test.ts` — covers R17-01 (Drive helper timeout + retry). NEW file.
- [ ] `tests/scripts/fix-model-images.test.ts` — covers R17-03 (model rebuild flow). NEW file. Mirror the DI-seam pattern from `tests/scripts/fix-image-pollution.test.ts`.
- [ ] `tests/scripts/cleanup-checkpoint-test-data.test.ts` — covers R17-07 (MANUAL/ folder scan). NEW file, small.
- [ ] Extend `tests/lib/supplier-canonical.test.ts` with per-color + known-prefix-routing test groups (R17-02, R17-04).
- [ ] Extend `tests/scripts/fix-image-pollution.test.ts` with billing-hard-limit short-circuit test (R17-08).
- [ ] Extend `tests/scripts/fix-image-pollution-manual.test.ts` with `--dry-run blocks trash` test (R17-06).
- [ ] No framework install needed — vitest already in package.json (Phase 15 + 16 work).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (Google service account, S&S Basic auth, OpenAI bearer — all unchanged from Phase 16) | env vars only; verified — no hardcoded creds |
| V3 Session Management | no | (no user sessions; CLI scripts) |
| V4 Access Control | yes | Drive scope `drive` + sheet edit scope (existing); operator runs CLI from controlled machine |
| V5 Input Validation | yes | colorName from BR row is trusted (read from operator-controlled Google Sheet). New input surface: operator's `--max-cost` flag (parse as number, reject NaN/negative) |
| V6 Cryptography | no | (no new crypto; relies on TLS) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| BR row has a colorName containing tabs/newlines → corrupts trail TSV | Tampering | `sanitize()` in `image-pollution-trail.ts` already collapses `[\t\n\r]+`. Phase 17's new fields inherit the sanitizer. |
| Drive timeout retry exposes service-account creds in error message | Information Disclosure | Existing `logger.warn` formats don't log raw credentials. New timeout retry path logs only fileId + attempt count — no creds. Verify in unit test. |
| OpenAI billing-limit error message contains account-id or unauthorized info | Information Disclosure | OpenAI BadRequestError exposes `code` (machine-readable). Phase 17 logs the code, not the raw message. |
| Compromised colorName field could inject a different supplier's product image | Tampering | Trail logs old_value + new_value; verifier-after-fix gates the write. If a malicious colorName routes to wrong S&S color, verifier rejects (different product). |
| Force-confirm bypass on `MANUAL/` cleanup | Repudiation | Phase 17 B-3 patch is non-destructive in extension (only adds to scan scope; doesn't change what gets trashed). Operator still must run explicitly. |

## Code Examples

### Pattern A: Drive timeout helper (17-01)

```typescript
// Source: gaxios README + src/shopify/image-standardizer.ts:244-259 (verified)
// Phase 17 17-01 — add to src/sheets/drive.ts

const DRIVE_TIMEOUT_MS = 30_000;
const DRIVE_RETRY = 2;

function isTimeoutError(err: unknown): boolean {
  const code = (err as { code?: string | number })?.code;
  const message = (err as Error)?.message ?? '';
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    message.includes('aborted') ||
    message.includes('timeout') ||
    message.includes('canceled')
  );
}

export async function downloadFromDrive(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DRIVE_RETRY; attempt++) {
    try {
      const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer', timeout: DRIVE_TIMEOUT_MS },
      );
      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      lastErr = err;
      if (!isTimeoutError(err)) throw err;
      logger.warn(
        `[drive] downloadFromDrive timeout (attempt ${attempt + 1}/${DRIVE_RETRY + 1}) on ${fileId}`,
      );
    }
  }
  throw lastErr ?? new Error('downloadFromDrive failed after retries');
}

// Same wrapper applied to:
//  - getDriveFileMetadata(drive, fileId)        — drive.files.get({fields})
//  - trashDriveFile(drive, fileId)              — drive.files.update({trashed:true})
//  - uploadToDrive(drive, buffer, ...)          — drive.files.create + drive.files.update
//  AND the internal findOrCreateFolder helper   — drive.files.list + drive.files.create
```

### Pattern B: Per-color supplier-canonical (17-02 + 17-04)

```typescript
// Source: Phase 17 17-02 + 17-04 — src/lib/supplier-canonical.ts

// Top-of-file: widen the dispatcher to also accept brand-prefix pids via S&S.
const SS_ROUTABLE_PREFIXES = new Set<string>([
  // adidas (exclusive to S&S in promo channel — Finding 1)
  'A', 'CE',
  // KNOWN_SUPPLIER_PREFIXES entries also route via S&S (Finding 2)
  // — they're listed below as a Set<string> of pid values for O(1) lookup.
]);

const SS_ROUTABLE_PIDS = new Set<string>(Object.keys(KNOWN_SUPPLIER_PREFIXES));

function routesViaSS(pid: string): boolean {
  if (/^S/i.test(pid)) return true;
  // Adidas A* and CE* (CE520L) — exclusive to S&S
  if (/^A\d/i.test(pid) || /^CE\d/i.test(pid)) return true;
  // Bella+Canvas, Gildan, Next Level, Comfort Colors, American Apparel — all in S&S
  if (SS_ROUTABLE_PIDS.has(pid)) return true;
  return false;
}

export async function resolveSupplierCanonical(
  pid: string,
  colorName?: string,
): Promise<CanonicalResult | null> {
  if (/^H08/i.test(pid)) return null;

  if (routesViaSS(pid)) {
    await throttle('ss');
    const auth = getSSAuth();
    const ssId = await resolveSSStyleId(pid, auth);
    if (ssId === null) return null;

    await throttle('ss');
    const products = await ssGet<Array<{ colorName?: string; colorFrontImage?: string }>>(
      `/products/?style=${ssId}&fields=colorName,colorFrontImage`,
      auth,
    );
    if (!products || products.length === 0) return null;

    // Per-color filter (17-02)
    let match: typeof products[0] | undefined;
    if (colorName) {
      const target = colorName.toUpperCase().trim();
      match = products.find(
        (p) =>
          p.colorFrontImage &&
          String(p.colorName ?? '').toUpperCase().trim() === target,
      );
    }
    if (!match) {
      match = products.find((p) => p.colorFrontImage);
    }
    if (!match || !match.colorFrontImage) return null;

    return { url: makeSSLargeUrl(match.colorFrontImage), source: 'ss', styleId: ssId };
  }

  if (/^L/i.test(pid)) {
    // CSW path — same shape, with optional filename-color overlay
    await throttle('csw');
    const handle = await findCSWHandle(pid);
    if (!handle) return null;
    await throttle('csw');
    const product = await fetchCSWProduct(handle);
    if (!product || product.images.length === 0) return null;

    // 17-02 CSW best-effort: prefer the image whose filename contains colorName.
    let chosen: { src: string; filename?: string } | undefined;
    if (colorName) {
      const colorSlug = colorName.toLowerCase().trim().replace(/\s+/g, '-');
      chosen = product.images.find((img) => {
        const fn = String((img as { filename?: string }).filename ?? img.src.split('/').pop() ?? '').toLowerCase();
        return fn.includes(colorSlug);
      });
    }
    if (!chosen) chosen = product.images[0];
    return { url: chosen.src, source: 'csw', styleId: handle };
  }

  return null;
}
```

### Pattern C: OpenAI billing-hard-limit short-circuit (B-4)

```typescript
// Source: Phase 17 B-4 — scripts/fix-image-pollution.ts Tier 2 loop

// Module-scope flag so subsequent pids in the same run also short-circuit.
let __billingExhausted = false;

function isBillingHardLimit(err: unknown): boolean {
  if (!(err instanceof OpenAI.BadRequestError)) return false;
  // OpenAI exposes the error code on err.code (typed string field).
  // Fallback to message-substring check for older SDK versions.
  const code = (err as unknown as { code?: string }).code;
  if (code === 'billing_hard_limit_reached') return true;
  if (typeof err.message === 'string' && err.message.includes('Billing hard limit has been reached')) {
    return true;
  }
  return false;
}

// Inside the Tier 2 loop:
for (const pid of cascadedToTier2) {
  if (__billingExhausted) {
    // Append sentinel row so trail makes the cause visible.
    await deps.appendTrailRowFn({
      timestamp_iso: new Date().toISOString(),
      pid,
      operation: 'TIER2_BUDGET_EXHAUSTED',  // NEW operation type — see image-pollution-trail.ts
      column_or_path: '',
      old_value: '',
      new_value: '',
      tier: 2,
      run_id: runId,
      notes: 'OpenAI billing hard limit reached — Tier 2 aborted',
    });
    tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
    continue;
  }
  try {
    const result = await tier2Fix(pid, polluted, brIndex, deps, runId, costTracker);
    tier2Results.push(result);
  } catch (err) {
    if (isBillingHardLimit(err)) {
      logger.warn('[fix-image-pollution] OpenAI billing hard limit — aborting Tier 2');
      __billingExhausted = true;
      // Don't retry this pid; mark it as cascaded.
      tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
      continue;
    }
    logger.warn(`[fix-image-pollution] Tier 2 crashed for ${pid}: ${err}`);
    tier2Results.push({ pid, tier: 2, status: 'verifier_rejected', cascade: true });
  }
}
```

### Pattern D: `--dry-run` Drive-trash gate (B-2)

```typescript
// Source: Phase 17 B-2 — scripts/fix-image-pollution-manual.ts:429 (delete path), :712 (replace path)

// At line 429 (replace handler trash):
if (
  origFileId &&
  newFileIdFromUpload &&
  origFileId !== newFileIdFromUpload
) {
  if (!deps.args.dryRun) {                          // NEW gate
    try {
      await deps.trashDriveFileFn(deps.driveClient, origFileId);
    } catch (err) {
      logger.warn(`...`);
    }
    await deps.appendTrailRowFn({
      ...
      operation: 'DRIVE_DELETE',
      ...
    });
  } else {
    logger.info(
      `[fix-image-pollution-manual] dry-run: would have trashed ${origFileId} (origFileId)`,
    );
  }
}

// At line 712 (delete handler trash):
if (origFileId) {
  if (!deps.args.dryRun) {                          // NEW gate
    try {
      await deps.trashDriveFileFn(deps.driveClient, origFileId);
    } catch (err) {
      logger.warn(`...`);
    }
    await deps.appendTrailRowFn({ operation: 'DRIVE_DELETE', ... });
  } else {
    logger.info(
      `[fix-image-pollution-manual] dry-run: would have trashed ${origFileId}`,
    );
  }
}
```

### Pattern E: Cleanup MANUAL/ blind-spot fix (B-3)

```typescript
// Source: Phase 17 B-3 — scripts/cleanup-checkpoint-test-data.ts

async function findManualFolderId(drive: ReturnType<typeof createDriveClient>): Promise<string | null> {
  const q = `'${ROOT_FOLDER_ID}' in parents and name = 'MANUAL' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q, fields: 'files(id,name)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id ?? null;
}

async function trashCheckpointArtifactsInManualFolder(
  drive: ReturnType<typeof createDriveClient>,
): Promise<number> {
  const manualId = await findManualFolderId(drive);
  if (!manualId) return 0;
  // List MANUAL/<pid>/ subfolders matching CHECKPOINT-TEST-*
  let count = 0;
  for (const pid of TEST_PIDS) {  // ['CHECKPOINT-TEST-001', 'CHECKPOINT-TEST-002']
    const r = await drive.files.list({
      q: `'${manualId}' in parents and name = '${pid}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const pidFolder = r.data.files?.[0]?.id;
    if (!pidFolder) continue;
    const descendants = await listAllDescendantFiles(drive, pidFolder);
    for (const f of descendants) {
      try { await trashDriveFile(drive, f.id); count++; } catch { /* logged */ }
    }
    try { await trashDriveFile(drive, pidFolder); } catch { /* logged */ }
  }
  return count;
}

// In main(), AFTER the CHECKPOINT-TEST/ cleanup:
console.log('[cleanup] also scanning MANUAL/<pid>/ for checkpoint leftovers...');
const manualTrashed = await trashCheckpointArtifactsInManualFolder(drive);
console.log(`  MANUAL/ leftover files trashed: ${manualTrashed}`);
```

## State of the Art

| Old Approach (Phase 16 first prod run) | Current Approach (Phase 17) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Drive helpers: no fetch timeout (hung 2.5h on 1 file) | gaxios `timeout: 30_000` + retry-once | This phase (17-01) | Audit completes in bounded time; no manual kill required |
| Supplier-canonical: style-level (first color always) | Per-color match (S&S) + filename match (CSW) | This phase (17-02) | Eliminates the 11+ "right product, wrong color" verifier rejects per audit run |
| Supplier dispatch: only S* + L* | S* + L* + brand-prefix routed to S&S (adidas, Bella, Gildan, Next Level, etc.) | This phase (17-04) | ~145 pids → ~50 pids without canonical (estimated) |
| Tier 2 only handles BackImage + DirectSideImage | New Tier 1.5 + Tier 2 for Model* via `fix-model-images.ts` | This phase (17-03) | Addresses 312/453 (69%) of detected pollution |
| OpenAI billing-hard-limit retried per-pid | Detected once, Tier 2 aborts, sentinel trail row | This phase (B-4) | Saves wall-clock + log noise; clear operator signal |
| `--dry-run` gated Sheets only | Now also gates `trashDriveFile` in manual CLI | This phase (B-2) | Closes a destructive footgun |
| Cleanup script scanned CHECKPOINT-TEST/ only | Also scans `MANUAL/CHECKPOINT-TEST-*` | This phase (B-3) | No more manual orphan cleanup after each checkpoint run |

**Deprecated/outdated:**

- None. Phase 16 architecture stands. Phase 17 is purely additive.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A17-1 | gaxios `timeout` option works for all 4 Drive helper calls (`get`, `update`, `list`, `create`) | Pattern A | LOW — gaxios is the documented HTTP layer of googleapis; option is documented in README. If wrong, use AbortController wrapping (already-proven pattern from `image-standardizer.ts`). |
| A17-2 | S&S API will return all colorName variants from `/products/?style=N` (one call) — colorName filtering is client-side | Findings 4, Pattern B | LOW — verified via existing `fetch-ss-images-fixed.ts:120-124` (already iterates `items` to build `colorMap`). Also `[CITED: api.ssactivewear.com/V2/Products.aspx]` documentation lists no colorName filter parameter. |
| A17-3 | adidas pids (A*, CE*) resolve through S&S's `/styles/?search=` endpoint by passing the literal pid as search term | Finding 1, Pattern B | MEDIUM — `[CITED: ssactivewear.com/ps/adidas]` confirms adidas is in S&S Canada's catalog, but the actual style-name format S&S uses for adidas may differ from the brand pid. Test on 1 pid (e.g., A702) before claiming victory. If wrong, fall back to manual brand-pid → S&S-styleID mapping table. |
| A17-4 | Bella+Canvas, Gildan, Next Level pids in `KNOWN_SUPPLIER_PREFIXES` resolve via S&S `/styles/?search=` | Finding 2, Pattern B | MEDIUM — same as A17-3; resolveSSStyleId may need adjustment per brand. Verify by running 17-02 in dry-run against 6110, 8882, 5200 first. |
| A17-5 | The 312 Model* fail counts in `PRODUCTION-AUDIT-FINDINGS.md` came from the Phase 16 `verifySameProduct` verifier on Model* vs FrontImage comparisons — i.e., they ARE genuinely polluted, not verifier false-positives | Plan 17-03 sizing | MEDIUM — Phase 16 audit pass 2b runs Model* vs FrontImage. False-positive rate could be ~5-10% (verifier is gpt-4o-mini, not perfect). Mitigation: re-verify in Phase 17 before AI-regenerating. Cost of double-verify: ~$0.0003 × 312 = $0.10 — trivial. **Recommend Phase 17 17-03 always re-verifies each polluted Model* before invoking AI Tier 2.** |
| A17-6 | `generateModelImage` returns model images that pass `verifySameProduct` against the source front image at a reasonable rate (>50%) | Pattern 4 cost estimate | MEDIUM — Phase 10's audit-runner uses `generateModelImage` and never empirically tested it against `verifySameProduct`. Phase 15's `verifyGarmentTypeMatch` is family-coarse; `verifySameProduct` is stricter. Unknown failure rate. **Sample-test on 10 pids before committing to full run** per Pattern 4 recommendation. |
| A17-7 | Operator's personal OpenAI budget allows ~$10-20 for 17-03 Tier 2 AI fallback | D17-3 + Pattern 4 | LOW-MEDIUM — D17-3 explicitly states "personal-scale OpenAI budget"; Pattern 4's $6 estimate is well under that. If the verifier-after-fix reject rate is higher than 50%, costs scale (each rejection = wasted call). Cap via `--max-cost=10`. |
| A17-8 | The B-4 billing-hard-limit `code` field is set on `OpenAI.BadRequestError` by the openai-node SDK | Pattern C | LOW — search results confirm the error JSON has `"code": "billing_hard_limit_reached"`. The Node SDK typically exposes this as `err.code` on its typed error classes. If wrong, the message-substring fallback catches it. |
| A17-9 | The 213-pid polluted count from `PRODUCTION-AUDIT-FINDINGS.md` is stable — i.e., a re-run after 17-01 + 17-02 won't surface MORE pollution (e.g., from completed Drive metadata calls that previously timed out and were skipped) | Phase 17 sizing | MEDIUM — the audit hung at 435/449 pids; ~14 pids never got the full Pass 1+2+3 treatment. Post 17-01 fix, those 14 pids could surface additional pollution. Expected delta: +5-10 detections, no structural change. |
| A17-10 | `KNOWN_SUPPLIER_PREFIXES` covers the high-volume pids in BR; the BR pids NOT in the allowlist (A* anvil, NE* New Era, M786, QTB6000, etc.) genuinely require manual triage | Finding 3 + scope | MEDIUM — allowlist was last updated for Phase 14. New high-volume brands could exist in BR that aren't allowlisted. **Mitigation:** Phase 17 plan's first task should `grep -o '^[A-Z]\+' br_pids.txt | sort -u` to verify the prefix distribution before committing to the dispatcher widening logic. |

**All claims tagged `[ASSUMED]` above need verification in the discuss-phase or first task of the plan.**

## Open Questions

1. **Should `fix-model-images.ts` be a standalone script or a Tier 4 inside `fix-image-pollution.ts`?**
   - What we know: Phase 16's `fix-image-pollution.ts` has Tier 1 + Tier 2; Tier 3 is the manual CLI in a separate script.
   - What's unclear: Is "Model rebuild" structurally different enough to merit a new script, or is it just "Tier 4 inside the existing orchestrator"?
   - Recommendation: NEW script. Reasons: (a) different verifier-after-fix semantics (model vs front comparison); (b) different cost profile (`generateModelImage` is ~3× cost of `generateGarmentView` per call); (c) operator wants to run it separately (smaller scope, easier to budget). The trail TSV is shared, so resume-from-trail works across scripts.

2. **What's the `--re-audit` behavior after Phase 17? Does it need to be updated to ignore Phase 17's trail entries?**
   - What we know: `--re-audit` re-runs Passes 1+2+3 and reports polluted pids.
   - What's unclear: If Phase 17's Model rebuild updates a Model* cell, Pass 2 re-running model_pollution check would either pass (if rebuild worked) or fail again (if it didn't). The trail-based `BR_WRITE` denominator works the same way Phase 16 has it.
   - Recommendation: No changes to re-audit. The trail-based R10 OR-path naturally captures Model rebuild fixes (they emit BR_WRITE rows with tier=1 or tier=2). Verify with a single re-audit run after 17-03 ships.

3. **For the per-color CSW match (17-02): if `colorName` is something like "Heather Gold" but the CSW filename uses "heather-gold-melange", does the substring match work?**
   - What we know: CSW filenames are based on Shopify variant names; spelling varies.
   - What's unclear: Substring match (`fn.includes('heather-gold')`) works for some but not all. False negatives mean falling back to first-image (current behavior — no regression).
   - Recommendation: Accept the imperfect substring match. Document as best-effort. If color-mismatch rejects remain after 17-02 for CSW pids, escalate as a separate follow-up.

4. **Should `routesViaSS` cover ALL the `KNOWN_SUPPLIER_PREFIXES` entries (including Richardson 168, 112)?**
   - What we know: Richardson 168/112 ARE in the allowlist BUT are headwear (H08* family); they're scoped out by D-22.
   - What's unclear: After the `/^H08/i` early-return, do Richardson pids still hit the dispatcher? Probably not (pid `168` doesn't match `/^H08/`). So they'd route via S&S — fine because S&S carries Richardson too.
   - Recommendation: Let them route via S&S. The early-return on `/^H08/` already filters the headwear-class pids; Richardson 168/112 are caps but NOT H08-prefixed, so they'd land in BR with non-headwear category and get treated normally.

5. **For 17-03 Tier 1, when S&S returns model URLs, what's the "verifier reference" — the source FrontImage (Phase 16 SoT) OR the supplier canonical front for the same color (which is what produced the model)?**
   - What we know: Phase 16's `verifySameProduct` is "candidate vs reference" where reference is assumed correct.
   - What's unclear: If the BR FrontImage is itself polluted (caught by 17-02 in this run), using it as the reference is wrong. But if Phase 17 17-03 runs AFTER 17-02 Tier 1 fixes have committed, FrontImage has just been re-fetched from supplier — it's the correct color now.
   - Recommendation: Run 17-03 AFTER 17-02 Tier 1 in the same orchestration. Phase 16's existing `front-first ordering` (sortedCols puts FrontImage first) supports this naturally. Use the (now-fixed) BR FrontImage as the reference for `verifySameProduct`.

6. **Should B-4's sentinel `TIER2_BUDGET_EXHAUSTED` row count toward `loadProcessedPids`?**
   - What we know: `loadProcessedPids` includes `BR_WRITE, MANUAL_SKIP, MANUAL_ACCEPT`. These are "operator/system finished with this pid".
   - What's unclear: If billing limit kills Tier 2, should the pid be retry-able on the next run (after budget tops up) or considered "processed"?
   - Recommendation: DO NOT include `TIER2_BUDGET_EXHAUSTED` in terminal-ops. Next run with budget should retry the pid. Add a unit test verifying this.

7. **Tier 1 yield estimate after 17-02: optimistic ~100 of 213, but the dry-run estimate was 36× off in production. What's the disciplined estimate?**
   - What we know: 213 polluted pids, of which ~100 are S* or L* (Phase 16 ranges); ~50 more are KNOWN_SUPPLIER_PREFIXES allowlist; ~60 are adidas/anvil/NewEra/etc.
   - What's unclear: Of those ~150 newly-routable, what's the verifier-pass rate? Production data: 1 of ~50 S*/L* pids passed verifier (1/50 = 2%). Why so low? Because supplier-canonical was style-level (wrong color). Post-17-02 with per-color matching, expect 50-80% verifier-pass rate.
   - Recommendation: Plan for 50-100 Tier 1 fixes after 17-02. Plan for ~50 Tier 2 fixes after 17-03 Tier 1 (S&S model fetch). Plan for ~50 manual cascades to Tier 3. Total: ~200 of 213 resolved automatically, ~13 manual. WELL under R6 cap of 20.

## Sources

### Primary (HIGH confidence)

- `.planning/research/phase17-prep/PRODUCTION-AUDIT-FINDINGS.md` — the authoritative brief for Phase 17. Contains live audit hang evidence, real pollution counts, fix orchestrator yield analysis, latent bugs.
- `src/sheets/drive.ts` (lines 1-263) — Phase 16 Drive helpers (4 exports + uploadToDrive update-in-place semantics). Direct read.
- `src/lib/supplier-canonical.ts` (lines 1-291) — Phase 16 resolver, style-level today. Direct read.
- `src/lib/ai-model-image.ts` (lines 1-181) — Phase 10 model image generator + CLI. Direct read. Used by audit-runner.
- `src/lib/ai-image-generator.ts` (lines 129-265) — verifyGarmentTypeMatch + content-policy handling pattern (template for B-4 billing-hard-limit detection). Direct read.
- `src/lib/verify-same-product.ts` — Phase 16 same-product verifier (gpt-4o-mini, color-blind). Listed by directory.
- `src/lib/image-pollution-trail.ts` — Phase 16 trail writer. Listed by directory.
- `src/shopify/image-standardizer.ts:244-259` — verified AbortController + setTimeout pattern for fetch timeout (the proven repo pattern Phase 17 17-01 can adopt for non-gaxios fetch sites).
- `src/shopify/clone-pusher.ts:35-51` — same pattern with retry budget (template for retry-on-timeout in 17-01).
- `scripts/fetch-ss-images-fixed.ts` (lines 1-241) — verified S&S `/products/?style=` call returning all colors per call (basis of Finding 4).
- `scripts/fetch-ss-rest-sizes.ts:74-95` — verified generic `resolveStyleId` pattern that works for ANY pid (not constrained to S* prefix).
- `scripts/fetch-model-images.ts:90-117` — verified S&S `colorOnModel{Front,Side,Back}Image` field shapes.
- `scripts/scrape-csw-product.ts` (lines 1-172) — verified CSW image array shape; filename includes color but is not a first-class field.
- `scripts/fix-image-pollution.ts:498-661` — Phase 16 Tier 2 implementation (the call site B-4 needs to patch).
- `scripts/fix-image-pollution-manual.ts:361-460, 661-730` — Phase 16 manual CLI delete + replace paths (the call sites B-2 needs to patch).
- `scripts/cleanup-checkpoint-test-data.ts` (lines 1-191) — Phase 16 checkpoint cleanup (B-3 patch target).
- `.planning/phases/16-catalog-image-pollution-audit-fix/16-PHASE-SUMMARY.md` — Phase 16 shipped state + known leftovers (B-2, B-3 explicitly flagged here).
- `.planning/phases/16-catalog-image-pollution-audit-fix/16-RESEARCH.md` — Phase 16 conventions (DI seam pattern, code style, validation architecture format).

### Secondary (MEDIUM confidence)

- [api.ssactivewear.com/V2/Products.aspx](https://api.ssactivewear.com/V2/Products.aspx) — official S&S Products endpoint documentation. Confirms supported query parameters (style, styleid, partnumber, Warehouses, fields, mediatype). Confirms NO colorName filter parameter (basis of Finding 4 / Pattern B client-side filtering).
- [ssactivewear.com/ps/adidas](https://www.ssactivewear.com/ps/adidas) — verified adidas exclusivity to S&S in the promo channel (Finding 1).
- [github.com/googleapis/gaxios — README](https://github.com/googleapis/gaxios) — gaxios `timeout` option semantics. Per-request timeout via second arg. AbortSignal support documented.
- [github.com/openai/openai-node — README](https://github.com/openai/openai-node) — `OpenAI.BadRequestError` shape (status, request_id, name, headers). Code property exposed for typed error inspection.
- [community.openai.com — Billing hard limit reached api error](https://community.openai.com/t/billing-hard-limit-reached-api-error/572481) — confirms HTTP 400 status, code `billing_hard_limit_reached`, type `invalid_request_error` (basis of Pattern C).
- WebSearch: "Bella Canvas S&S Activewear SanMar AlphaBroder distributor wholesale" — multiple confirmations that Bella+Canvas is distributed across all three major US wholesalers; S&S Activewear carries the full assortment (Finding 2).

### Tertiary (LOW confidence)

- Verifier-pass-rate estimate for the per-color canonical match (50-80%) — extrapolation from Phase 16 prod data; no fixture data yet. To be validated by 17-02 first task (run on a sample of 10 pids).
- Cost estimate for 17-03 ($6 AI worst case) — relies on A17-6 (verifier-pass-rate ≥ 50%) being roughly accurate. Sample-test required.
- Adidas A* and CE* pids resolvable via S&S `/styles/?search=A702` — confirmed adidas is in S&S but not verified the exact search syntax works for adidas codes specifically.
- Brand-distribution facts (anvil, New Era proprietary code mapping) — based on WebSearch with limited results; treat as suggestive, not authoritative.

## Metadata

**Confidence breakdown:**

- Bug fixes (B-1, B-2, B-3, B-4): HIGH — direct code reads, well-scoped patches, proven patterns elsewhere in repo.
- Plan 17-01 (Drive timeout): HIGH — gaxios option is documented; fallback AbortController pattern is proven in repo (`image-standardizer.ts`).
- Plan 17-02 (per-color canonical): HIGH — S&S API response shape verified via existing code; CSW best-effort match is honestly documented as limited.
- Plan 17-03 (Model rebuild): MEDIUM — `generateModelImage` exists and works, but verifier-pass-rate against `verifySameProduct` is empirically untested. Sample-test recommended before full run.
- Plan 17-04 (D-12 scraper expansion): HIGH on the design (route via S&S for known brands) — MEDIUM on the actual unlock count (depends on S&S `/styles/?search=` accepting brand pids).
- Plan 17-05 (manual triage): N/A — no engineering.
- Real pollution distribution data: HIGH — from production audit log.
- Cost projections: MEDIUM — based on Phase 10/15 baseline costs; could be off by 2× if verifier rejects more often than expected.
- Architectural responsibility map: HIGH — direct read of all involved files.

**Research date:** 2026-05-14
**Valid until:** 2026-06-13 (30 days for the stack; sooner if S&S or CSW API changes, or if OpenAI changes its error code semantics).
