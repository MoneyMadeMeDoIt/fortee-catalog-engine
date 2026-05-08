# Phase 14: Imagery Cleanup — Context

**Gathered:** 2026-05-08 (--auto mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Reconcile BR ↔ Drive ↔ store imagery consistency for the curated bestseller catalog so that `audit-product-imagery.ts` reports zero unjustified issues. No new product imports, no curation work — pure reconciliation.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**6 requirements are locked.** See `14-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `14-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- All issues currently flagged by `scripts/audit-product-imagery.ts` for the curated bestseller catalog (~460 pids)
- 5000 BR↔store reconciliation
- Audit script extensions for legitimate non-canonical patterns (Richardson prefix, decoration-zone alts)
- Reusable `resolveStoreProduct(pid)` helper that prevents silent-pick-from-multiple bugs

**Out of scope (from SPEC.md):**
- Catalog curation (descriptions, size charts, categories) — separate v2.0 track
- New product imports — reconciliation only
- Performance optimizations — only correctness matters
- v3.0 features (curation filtering, missing-image generation)
- Pids not in BR-Ready

</spec_lock>

<decisions>
## Implementation Decisions

### Order of operations (D-01 through D-05)
- **D-01:** Build the `scripts/lib/resolve-store-product.ts` helper FIRST, before any further reconciliation work. It must enumerate all matches via `products(first: 50, query: "handle:*{pid}*")`, filter by handle ending in `-{pid}` or exact `{pid}`, and throw with the full match list if more than one survives the filter. All later scripts in this phase use it. Reason: every other fix risks repeating tonight's silent-pick mistake without it.
- **D-02:** 5000 reconciliation uses the FORWARD path — delete the 15 orphan colors from `unisex-heavy-cotton-t-shirt-5000` on store. Reason: matches original "drop low-priority colors" intent, doesn't require user manual Sheets version-history work, is consistent with what was already shipped for 3001 and 64000.
- **D-03:** 168 cross-pollution uses the AUDIT EXTENSION path — extend audit's allowed-prefix list to include `Richardson_` (and other supplier prefixes already in BR's `supplierCode` column), rather than renaming Drive files. Reason: renaming risks breaking BR URLs that point to those files. The audit's current "filename must start with pid" check is the wrong invariant.
- **D-04:** CROSS-POLLUTION sweep is per-pid triage with a checked-in resolution TSV (`tmp/cross-pollution-resolution.tsv`). Each row gets one of: MOVE (to correct folder), KEEP (legitimate, audit allowlist), TRASH (orphan). The script reads the TSV and applies actions; it does NOT auto-classify.
- **D-05:** DUPE-DRIVE round 2 is an EXTENSION of `dedupe-drive-duplicates.ts` — add new entries to STRAY_PATTERNS for the 3 documented patterns. Reason: keeps a single source of truth for "what counts as a stray supplier-original," easier than maintaining a parallel script.

### 5000 forward-resolve specifics (D-06)
- **D-06:** Reuse the existing `productDeleteMedia` mutation pattern from `scripts/drop-br-colors.ts`. The 15 colors to delete on store: Aquatic, Antique Jade Dome, Antique Orange, Berry, Blackberry, Blue Dusk, Brown Savana, Cobalt, Dusty Rose, Electric Green, Lilac, Midnight, Neon Blue, Neon Green, Russet. After delete, run `fix-store-drift.ts --handles 5000` to backfill any partial views the freed slots can now hold.

### Sibling helper API (D-07 through D-09)
- **D-07:** `resolveStoreProduct(client, pid)` returns `{ id, handle, ... }` on exactly-one-match, throws `MultipleStoreProductsError` listing all matches on >1, throws `NoStoreProductError` on 0.
- **D-08:** Caller-supplied query constructor is allowed (`resolveStoreProduct(client, pid, { handlePattern: 'custom' })`) but defaults to `handle:*{pid}*` with post-fetch filter for handles ending in `-{pid}`.
- **D-09:** Helper writes its match-count to a per-call audit log line (logger.info) so duplicate-product surprises are visible in any script's output.

### Audit extension (D-10)
- **D-10:** `audit-product-imagery.ts` cross-pollution check gains a `KNOWN_SUPPLIER_PREFIXES` allowlist mapping `pid → [allowed prefix strings]`. Initial entry: `'168' → ['Richardson_168_']`. Future suppliers added as discovered. The check passes if filename starts with the pid OR any allowed prefix for that pid.

### Verification (D-11)
- **D-11:** End-of-phase verification re-runs the audit and asserts STORE-DRIFT == 0, CROSS-POLLUTION == 0 OR all rows in `tmp/cross-pollution-resolution.tsv` marked ACCEPTED, DUPE-DRIVE == 0, BAD-ALT == 0 OR matches the user-approved whitelist regex. Verifier writes `14-VERIFICATION.md` with the audit summary embedded.

### Claude's Discretion
- Specific batch sizes for `productDeleteMedia` calls (Shopify supports up to 100 per call — pick whatever's safe with retries)
- Exact regex syntax for STRAY_PATTERNS additions (as long as they correctly catch the 3 documented patterns)
- File naming for the audit acceptance TSV (current proposal: `tmp/audit-acceptance.tsv`)
- Whether to write the resolveStoreProduct helper as a `.ts` lib file or inline reusable function (lib file preferred for reuse)

### Folded Todos
None — no pending todos matched this phase scope.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements
- `.planning/phases/14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap/14-SPEC.md` — Locked requirements, boundaries, acceptance criteria

### Existing scripts (read before extending)
- `scripts/audit-product-imagery.ts` — Imagery audit; will be extended with KNOWN_SUPPLIER_PREFIXES allowlist
- `scripts/fix-store-drift.ts` — Backfills missing per-color media; idempotent, safe to re-run
- `scripts/dedupe-drive-duplicates.ts` — Deletes hyphenated supplier dupes; STRAY_PATTERNS will be extended
- `scripts/drop-br-colors.ts` — Removes BR rows + optional store media for specified (pid, color); DROP map is hardcoded per phase
- `scripts/redetect-unknown-side-cache.ts` — Re-runs vision on cached `unknown` side detections (already shipped this phase)
- `scripts/swap-mislabeled-store-sides.ts` — Swaps L/R alts based on redetect output (already shipped this phase)
- `scripts/cleanup-all-drive-orphans.ts` — Trash orphan files in Drive

### Memory references
- `memory/project_imagery_audit_handoff_2026_05_07.md` — Tonight's session state and partial-rollback context
- `memory/feedback_use_gsd_for_multi_step.md` — Why this phase exists (the lesson from tonight's mistakes)
- `memory/feedback_drive_update_in_place.md` — Drive uploadToDrive update-in-place gotcha
- `memory/feedback_drive_cleanup_rules.md` — Drive image management rules

### Source data
- `tmp/imagery-audit.tsv` — Latest audit output (2026-05-07 23:47Z); regenerate before any fix work begins
- `tmp/redetect-changes.tsv` — Side-pair redetect changes (historical reference)
- `tmp/side-pair-cache.backup-2026-05-07.json` — Cache backup before redetect

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`createShopifyClient('DEST_SHOPIFY_')`** (src/shopify/client.ts) — Standard dest store client; use everywhere
- **`createSheetsClient()`** (src/sheets/client.ts) — Google Sheets client for BR mutations
- **`logger`** (src/lib/logger.ts) — Use throughout, do NOT use console.log in scripts/

### Established Patterns
- **Idempotency**: Every fix script (drift, drop, dedupe) is idempotent and safe to re-run. New scripts in this phase MUST preserve this.
- **Dry-run flag**: All destructive scripts accept `--dry-run`. Mandatory for new scripts.
- **Logging shape**: `logger.info('[handle/color] action message')` — keep this consistent.
- **Bottom-up sheet row deletion**: When deleting BR rows, sort indices descending so deleteDimension calls don't invalidate later indices (pattern in scripts/prune-missing-info.ts).

### Integration Points
- **BR-Ready tab** (Sheets, MAIN_ID `1GcsOwEy96Y8P8cLKafTl-KdkhP9cTY1jLm-9CL_0tPs`): Source of truth for what should exist on store
- **Dest Shopify store** (DEST_SHOPIFY_*): Mirror of BR-Ready
- **Drive** (GOOGLE_DRIVE_IMAGES_FOLDER_ID): Image source for both BR and store

### Anti-patterns to avoid (lessons from tonight)
- ❌ `products(first: 1, query: "handle:*{pid}*")` — silently picks one when multiple exist. Always use `first: 10+` and filter post-fetch.
- ❌ `--pids` flag on push-bestsellers-to-store.ts — doesn't exist; correct flag is `--handles`.
- ❌ Running mutations without dry-run first — every destructive operation must dry-run first.
- ❌ Writing scripts that read `tmp/imagery-audit.tsv` without confirming it's fresh — re-audit first if more than ~30 minutes old.

</code_context>

<specifics>
## Specific Ideas

The user (founder) cares about three concrete user-facing outcomes:
1. The store doesn't have orphan colors not in BR (consistency)
2. Cap-bound products use their 250 slots on real per-color media, not stale orphan alts
3. Future audit runs surface only legitimate issues, not phantom drift from pattern mismatches

Tonight's frustration ("all this time wasted") was specifically about ad-hoc work without a plan. This phase exists to demonstrate that GSD framework prevents that recurrence.

</specifics>

<deferred>
## Deferred Ideas

- **Variant trimming for cap-bound products**: deciding which colors to drop on each product as suppliers add new ones — this is an ongoing curation activity, not a one-shot phase. Defer to ongoing maintenance.
- **Per-product side-view policy**: some products (caps, vests, totes) don't need both left+right sides. Could reduce to 1 side per color and free 25% media. Defer — scope creep here.
- **Drive folder reorganization** (e.g., normalizing supplier folder naming): broader hygiene project. Defer.
- **Bandit / sales data integration** for "low-priority color" picking: would let drop decisions be data-driven instead of industry-knowledge picks. Defer.
- **L01210 / L01250 BAD-ALT decoration zones**: spec includes these as in-scope decisions but the resolution depends on user product-design intent. Will be a brief decision point during execute-phase.

</deferred>

---

*Phase: 14-imagery-cleanup-reconcile-br-drive-store-consistency-for-cap*
*Context gathered: 2026-05-08*
