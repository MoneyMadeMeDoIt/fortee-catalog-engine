# Feature Landscape: Multi-View Garment Generation

**Domain:** Generating back and side views of garments from front images for e-commerce catalog
**Researched:** 2026-03-31

## Table Stakes

Features users expect. Missing = product feels incomplete in the catalog.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Back view image | Shoppers expect to see the back of a garment before purchase. Standard in apparel e-commerce. | Med | Core requirement. 249 styles need this. |
| Color consistency between views | Back/side must match front color exactly. Mismatched colors look unprofessional. | Med | Existing hue-drift check handles this. Improve with color histogram comparison. |
| Correct garment type in generated view | A polo front must produce a polo back, not a t-shirt back. | Med | Currently failing. Needs post-generation validation + improved prompts. |
| White/clean background | All product images on consistent white background. Industry standard. | Low | Already handled by existing prompts and quality scoring. |
| 2000x2000px resolution | Standard Shopify product image size for zoom capability. | Low | Already handled by sharp resize in standardizer. |
| No logos/prints on generated views | Back/side of blank garments should be blank. AI sometimes hallucinates logos. | Low | Addressed in prompts with negative constraints. |

## Differentiators

Features that set the catalog apart. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Side view image | Most competitors only show front and back. Side profile adds perceived quality. | Med | Same generation pipeline as back view. Worth doing for all 249 styles. |
| Garment detail preservation (collar, pockets, zippers) | Structural details visible in back/side increase buyer confidence. | Med | Improved prompts with garment description from Vision API. |
| Batch processing with cost optimization | Processing 249 styles efficiently with Batch API saves 50% vs real-time. | Med | New capability. Requires async job handling but halves cost. |
| Automated quality gate before publish | Only publish images that pass garment-type, color, and quality validation. | Med | Prevents bad images from reaching Shopify. Reduces manual review burden. |
| Supplier image priority over AI | Real supplier photos used when available, AI only fills gaps. | Low | Already in pipeline via `sourceImages()`. Re-run with broader matching. |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| On-model/mannequin views | Inconsistent with existing catalog style (flat lay / ghost mannequin). AI-generated models look uncanny. | Generate flat product views only. Match existing front image style. |
| 3D reconstruction pipeline | Academic models (Zero123, Wonder3D, SV3D) are not production-ready for garments. Fabric deformation is poorly handled. GPU infrastructure overkill. | Use 2D image generation with reference-based editing. |
| Fashion SaaS integration (for now) | HuHu AI / Uwear AI add vendor dependency, webhook infrastructure, and higher per-image cost for a one-time 249-style batch. | Stay with OpenAI API. Evaluate SaaS only if gpt-image-1.5 quality is insufficient. |
| Self-hosted FLUX/ComfyUI pipeline | 2-3 weeks engineering for GPU infrastructure, pose templates, workflow tuning. Not justified for 249 styles. | Use OpenAI API. Consider FLUX only if volume grows to thousands of styles regularly. |
| Real-time generation on user request | Latency (5-20s per image) is unacceptable for real-time. | Pre-generate all views in batch. Store results. Serve from CDN. |
| AI-generated lifestyle/scene images | Off-brand for a blank apparel catalog. Adds complexity without value. | Keep clean white-background product photos only. |

## Feature Dependencies

```
Supplier Image Re-sourcing --> Identifies which of 249 styles still need AI generation
                |
                v
Prompt Template Improvement --> Better garment descriptions feed into generation
                |
                v
gpt-image-1.5 Upgrade --> Drop-in model swap, must happen before batch run
                |
                v
Garment-Type Validation --> Post-generation check, must exist before batch run
                |
                v
Batch API Integration --> Async job handling for cost-efficient bulk run
                |
                v
Batch Generation Run --> Process all remaining styles
                |
                v
Human Review Pipeline --> Review flagged images before publishing
```

## MVP Recommendation

Prioritize (minimum to ship 249 styles with acceptable quality):

1. **gpt-image-1.5 upgrade** - One-line model change + cost constant update. Immediate quality and cost improvement.
2. **Improved prompt templates** - Richer garment descriptions from Vision API, photography-specific instructions, explicit negative constraints. Already researched in prior report.
3. **Garment-type validation** - Post-generation check using gpt-4o-mini Vision. Prevents wrong garment type from shipping.
4. **Batch run of 249 styles** - Execute with standard API (Batch API is nice-to-have optimization).

Defer:
- **Batch API integration**: Nice-to-have for cost savings (~$17 saved), but adds async complexity. Use standard API if time is constrained.
- **Color histogram comparison**: Current hue-drift check is adequate for most garments. Histogram is an incremental improvement.
- **Supplier image re-sourcing**: Worth trying but may yield few additional images. Don't block the AI generation on this.
- **Fashion SaaS evaluation**: Only pursue if gpt-image-1.5 results are unacceptable after the batch run.

## Sources

- [OpenAI GPT Image 1.5 Prompting Guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide)
- [AI Product Photography Tools 2026](https://claid.ai/blog/article/ai-product-photo-tools)
- [HuHu AI Product Photography Guide](https://huhu.ai/blog/ai-product-photography-ultimate-guide/)
- [Printful Mockup Generator Approach](https://www.printful.com/blog/product-photos-mockup-generators)
- Prior research: `.planning/research/ai-garment-image-generation-report.md`
