# Phase 08: Image Quality Scorer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 08-image-quality-scorer
**Areas discussed:** Calibration approach, Blank garment criteria

---

## Gray Area Selection

User was presented with 4 gray areas: Score output shape, Quality dimensions, Calibration approach, Proportion criteria.

**User response:** "you tell me if you need more info" — deferred most decisions to Claude's discretion, willing to discuss only what's genuinely ambiguous.

---

## Calibration Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Existing Shopify products | Pull current product images from Shopify store — real supplier images already in use | |
| Supplier URLs from sheet | Fetch directly from supplier image URLs stored in Google Sheet | |
| Both sources | Mix of Shopify product images and raw supplier URLs | |
| Manual folder | User prepares a curated folder of 50+ images | |

**User's initial question:** "Should I prepare a special folder with 50 images that are spot on to feed to you?"

**Claude's suggestion:** Auto-fetch from Shopify products, score them, output a report, user reviews and flags wrong verdicts.

**User's choice:** Yes, auto-fetch from Shopify (Recommended)
**Notes:** No manual curation needed — iterative review of automated scoring results.

---

## Blank Garment Criteria (QUAL-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Garments with existing prints/logos | T-shirts/hoodies with existing graphics | ✓ |
| Watermarked images | Supplier images with visible watermark overlays | ✓ |
| On-model photos | Photos of person wearing garment vs flat/ghost mannequin | ✓ |
| Non-white backgrounds | Colored, gradient, or patterned backgrounds | ✓ |

**User's choice:** All four options selected
**Notes:** User also suggested generating contextual on-model mannequin photos (e.g., construction vest on construction worker) — captured as deferred idea for future phase.

---

## Claude's Discretion

- Score output shape (numeric score + verdict + reasons + sub-scores)
- Specific quality dimension algorithms (Laplacian variance for blur, etc.)
- Proportion criteria tolerance bands
- Internal module structure and function decomposition
- All threshold values (determined during calibration)

## Deferred Ideas

- Contextual on-model photo generation: 1 on-model image per product with context-appropriate model (construction vest → construction worker, chef coat → chef). New capability beyond scoring — future phase.
