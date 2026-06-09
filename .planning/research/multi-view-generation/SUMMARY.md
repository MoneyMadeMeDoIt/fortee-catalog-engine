# Research Summary: Multi-View Garment Image Generation

**Domain:** AI-assisted e-commerce product image generation (back/side views from front photo)
**Researched:** 2026-03-31
**Overall confidence:** MEDIUM-HIGH

## Executive Summary

The Fortee Catalog Engine needs to generate back and side views for 249 styles that currently have only front images. The project already has a working AI image generation pipeline using OpenAI `gpt-image-1` via `images.edit()`, with hue-drift checking, quality scoring, multi-candidate selection, and budget tracking. Prior research (2026-03-27) identified the key issues: wrong garment type generation, color drift, and unrealistic output quality.

The most impactful immediate improvement is upgrading from `gpt-image-1` to `gpt-image-1.5` -- a near-drop-in change that delivers 20% cheaper images ($0.034 vs $0.042 per medium-quality image), 4x faster generation, and meaningfully better edit fidelity. Combined with improved prompt templates that include structured garment descriptions, photography-specific instructions, and explicit negative constraints, this should resolve the majority of current quality issues.

For the 249-style batch, the upgraded OpenAI pipeline is the right approach. Fashion-specialized SaaS platforms (HuHu AI, Uwear AI) offer potentially higher quality but add integration complexity and cost ($0.10+/credit) that is hard to justify for a one-time batch of 249 styles. Self-hosted FLUX + IP-Adapter offers the lowest per-image cost but requires 2-3 weeks of infrastructure work -- overkill for this volume. The OpenAI Batch API at 50% cost reduction makes the upgraded pipeline even more attractive for a bulk run.

A critical addition is post-generation garment-type validation using `gpt-4o-mini` Vision, which costs approximately $0.001/call and catches the wrong-garment-type issue before images reach the catalog. The existing hue-drift and quality scoring already handle color and quality validation. Also important: **try sourcing supplier back/side images first** from S&S Activewear and OneSource APIs before generating with AI -- the existing `image-sourcer.ts` already fetches from these sources but some views may have been missed due to API availability or color matching issues.

## Key Findings

**Stack:** Upgrade to `gpt-image-1.5` (drop-in model parameter change) + improved prompts + garment-type validation with `gpt-4o-mini`. Use Batch API for the 249-style run.

**Architecture:** Three-tier pipeline: (1) Source from suppliers, (2) Generate missing views with AI, (3) Validate with garment-type + hue + quality checks. Human review on flagged items only.

**Critical pitfall:** The `images.edit()` API treats the input image as a suggestion, not a constraint. Without explicit garment-type instructions in the prompt, the model frequently generates the wrong garment (e.g., hoodie instead of crewneck). Post-generation validation is mandatory.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Source Supplier Images First** - Re-run supplier image sourcing for the 249 styles with expanded color matching
   - Addresses: Avoid AI generation cost for styles where supplier images exist
   - Avoids: Unnecessary API spend and quality risk from AI generation

2. **Upgrade Pipeline** - Switch to gpt-image-1.5, improve prompts, add garment-type validation
   - Addresses: Wrong garment type, color drift, unrealistic output
   - Avoids: Premature SaaS integration before validating the cheaper approach

3. **Batch Generate** - Run 249 styles through upgraded pipeline using Batch API
   - Addresses: All remaining missing back/side views
   - Avoids: Budget overrun (Batch API = 50% discount)

4. **Human Review** - Review flagged images (low quality score, hue drift, garment type mismatch)
   - Addresses: Catching edge cases AI validation misses
   - Avoids: Shipping bad images to Shopify

**Phase ordering rationale:**
- Sourcing first reduces the AI generation workload (some styles may have supplier back/side views not previously captured)
- Pipeline upgrade before batch run ensures best quality per dollar
- Batch API requires the pipeline to produce async jobs, a slight architectural addition
- Human review is last because the automated pipeline handles the majority of cases

**Research flags for phases:**
- Phase 2: Needs testing with a 10-style sample before committing to the full batch
- Phase 3: Batch API integration is straightforward but needs error handling for async results

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | gpt-image-1.5 is well-documented, 20% cheaper, confirmed drop-in upgrade |
| Features | HIGH | Pipeline already exists; improvements are incremental |
| Architecture | MEDIUM-HIGH | Batch API pattern is documented but not yet tested in this codebase |
| Pitfalls | HIGH | Prior research + community reports confirm garment-type and color issues |
| Cost estimates | MEDIUM | Token-based pricing means edit operations cost slightly more than output-only estimates |

## Gaps to Address

- Exact cost-per-image for `images.edit()` with gpt-image-1.5 (includes input tokens, not just output)
- Whether S&S Activewear API currently returns back/side view URLs for the specific 249 styles (needs live testing)
- Batch API latency for image generation (documented as "up to 24 hours" but typically faster)
- Quality comparison between gpt-image-1.5 and fashion SaaS on actual catalog garments (would require paid trial)
