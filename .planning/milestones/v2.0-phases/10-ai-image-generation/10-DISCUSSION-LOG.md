# Phase 10: AI Image Generation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 10-ai-image-generation
**Areas discussed:** Prompt design, Candidate selection, Failed front handling, Cost controls

---

## Prompt Design

| Option | Description | Selected |
|--------|-------------|----------|
| Garment-type-aware prompts | Different prompts per category using template-map | ✓ |
| Generic prompt for all | One prompt for all garment types | |
| Let researcher experiment | Claude discretion on prompt strategy | |

**User's choice:** Garment-type-aware prompts

### Follow-up: Color in Prompt

| Option | Description | Selected |
|--------|-------------|----------|
| Include color name | Pull color from product data into prompt | ✓ |
| No, let image speak | Rely on input image for color matching | |

**User's choice:** Include color name

---

## Candidate Selection Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Retry once with adjusted prompt | Max 6 calls per view, return best of 6 on second failure | ✓ |
| Accept best of bad batch | Never retry, pick highest-scoring even if all fail | |
| Skip view entirely | Return null if all candidates fail | |

**User's choice:** Retry once with adjusted prompt

---

## Failed Front Image Handling

| Option | Description | Selected |
|--------|-------------|----------|
| AI-enhance existing front | Feed failing image to images.edit() with cleanup prompt | ✓ |
| Generate from product data only | Use images.generate() without reference image | |
| Skip front replacement | Flag but don't replace failing fronts | |

**User's choice:** AI-enhance existing front

---

## Cost and Rate Limiting

| Option | Description | Selected |
|--------|-------------|----------|
| Per-product cap, no global limit | Max 6 API calls per view, dry-run for estimates | |
| Global budget cap | Set max dollar amount, stop when hit | |
| No limits | Trust per-view retry cap as sufficient | |

**User's choice:** Per-product cap (max 6 calls/view) PLUS $200 global budget cap
**Notes:** User specifically requested a $200 global limit on top of the per-product cap.

---

## Claude's Discretion

- Specific prompt wording per garment type
- OpenAI model selection
- Image size/quality parameters
- Hue comparison algorithm
- Rate limiting strategy
- Cost tracking mechanism
- OpenAI API error handling

## Deferred Ideas

- Contextual on-model photos (carried from Phase 08)
