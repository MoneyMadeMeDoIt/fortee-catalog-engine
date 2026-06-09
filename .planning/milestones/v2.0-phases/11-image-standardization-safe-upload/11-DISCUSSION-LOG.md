# Phase 11: Image Standardization & Safe Upload - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 11-image-standardization-safe-upload
**Areas discussed:** Uniform garment scale, GID-based safe upload, Image format

---

## Uniform Garment Scale

| Option | Description | Selected |
|--------|-------------|----------|
| Single fixed target for all | Replace per-category ratios with one universal 85% target | ✓ |
| Keep categories, normalize range | Tighten range to 80-85% | |
| Max dimension target | Use max(width, height) instead of height-only | |

**User's choice:** Single fixed target for all

### Follow-up: Target Percentage

| Option | Description | Selected |
|--------|-------------|----------|
| 85% max height | 1700px garment on 2000px canvas | ✓ |
| 80% max height | 1600px on 2000px | |
| 90% max height | 1800px on 2000px | |

**User's choice:** 85% max height

---

## GID-Based Safe Upload

| Option | Description | Selected |
|--------|-------------|----------|
| Replace matching views only | Fetch GIDs, replace by view match | |
| Replace all product images | Delete all, upload fresh set | |
| Append only, never replace | Only add new images | |

**User's choice:** Initially selected "Replace matching views only"

### Follow-up: View Matching

| Option | Description | Selected |
|--------|-------------|----------|
| Match by alt text convention | Match on Front/Back/Side keywords in alt text | |
| Match by position only | 1st=front, 2nd=back, 3rd=side | |
| Always append | Never try to match | |

**User's choice:** Custom — "the alt text can not be changed for the image on my Shopify store"

### Follow-up: Position-Based Matching

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, position-based matching | Replace GID at position 1/2/3 | |
| Just replace all images | Delete all, upload fresh | |

**User's choice:** Custom — "please don't change my store images, only change the images in the Google Sheets"

**Result:** Shopify upload DEFERRED. Phase 11 only standardizes images and updates Google Sheets.

---

## Image Format and Quality

| Option | Description | Selected |
|--------|-------------|----------|
| PNG | Lossless, matches existing pipeline | ✓ |
| JPEG at 90% | Lossy, smaller files | |
| WebP | Modern format, best compression | |

**User's choice:** PNG

---

## Claude's Discretion

- Refactor approach for standardizeImage() (how to replace per-category ratios)
- Backward compatibility of REFERENCE_RATIOS
- Storage/hosting for standardized images
- Google Sheets update mechanism
- Error handling for failed standardization

## Deferred Ideas

- Shopify GID-based media replacement (originally in phase scope, deferred by user)
- Contextual on-model photos (from Phase 08)
