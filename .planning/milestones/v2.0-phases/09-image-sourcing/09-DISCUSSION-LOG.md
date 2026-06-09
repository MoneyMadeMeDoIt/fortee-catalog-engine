# Phase 09: Image Sourcing - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 09-image-sourcing
**Areas discussed:** Fallback chain order, Quality gating, Output shape and caching, Missing view handling

---

## Fallback Chain Order

| Option | Description | Selected |
|--------|-------------|----------|
| OMG first, then CSW, then S&S | Cheapest-first sequential fallback | |
| Try all sources, merge best | Hit all 3 in parallel, take highest-quality per view | ✓ |
| S&S first for back/side, OMG for front | Use S&S dedicated fields for back/side | |

**User's choice:** Try all sources, merge best
**Notes:** None

### Follow-up: Merge Rule

| Option | Description | Selected |
|--------|-------------|----------|
| Quality score picks winner | Run scoreImageQuality() on each candidate | ✓ |
| Highest resolution wins | Biggest dimensions wins | |
| Source priority as tiebreaker | Score first, OMG > CSW > S&S on ties | |

**User's choice:** Quality score picks winner

### Follow-up: Fetch Mode

| Option | Description | Selected |
|--------|-------------|----------|
| Parallel fetch all | Hit all suppliers simultaneously | ✓ |
| Sequential with early exit | Fetch one at a time, stop when all views filled | |

**User's choice:** Parallel fetch all

---

## Quality Gating Sourced Images

| Option | Description | Selected |
|--------|-------------|----------|
| Keep failing images as last resort | Accept best even if all fail scoring | |
| Reject all failing images | Only accept passing images | |
| Gate front only, accept any back/side | Strict on front, lenient on back/side | |

**User's choice:** Custom — "if a supplier image fails, we AI enhance it"
**Notes:** Failed-quality supplier images should be passed to AI enhancement (Phase 10) rather than discarded. A bad supplier image is useful as input for AI improvement.

---

## Output Shape and Caching

| Option | Description | Selected |
|--------|-------------|----------|
| URLs + quality scores | Return { url, score, verdict } per view | ✓ |
| Buffers + metadata | Return downloaded buffers directly | |
| URLs only, score separately | Caller runs scoring separately | |

**User's choice:** URLs + quality scores

### Follow-up: Caching

| Option | Description | Selected |
|--------|-------------|----------|
| No caching | Re-fetch each time, simple | ✓ |
| In-memory cache per run | Cache within single execution | |
| Persistent file cache | Write to JSON, skip on re-runs | |

**User's choice:** No caching

---

## Missing View Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Return null for missing views | null = needs AI generation | ✓ |
| Return front image as placeholder | Use front as stand-in | |
| Flag with needs_generation marker | Extra metadata for audit logging | |

**User's choice:** Return null for missing views

---

## Claude's Discretion

- Image view identification from supplier API responses
- S&S Canada field extraction approach
- CSW scraper strategy for image angles
- Error handling for individual supplier failures
- Internal function decomposition

## Deferred Ideas

None
