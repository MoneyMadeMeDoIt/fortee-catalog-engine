# Comparison: Approaches for Generating Back/Side Views from Front Image

**Context:** 249 styles need back and/or side views. Existing pipeline uses OpenAI gpt-image-1 via images.edit(). What is the best approach to fill these gaps?
**Recommendation:** Upgrade to gpt-image-1.5 with improved prompts and garment-type validation, because it requires minimal engineering (near-drop-in), costs $35-75 for the full batch, and builds on the existing tested pipeline.

## Quick Comparison

| Criterion | OpenAI gpt-image-1.5 (Upgrade) | Fashion SaaS (HuHu/Uwear) | FLUX + IP-Adapter (Self-Hosted) | 3D Reconstruction (Zero123/SV3D) | Supplier Photography (Re-Source) |
|-----------|-------------------------------|---------------------------|-------------------------------|--------------------------------|-------------------------------|
| **Quality for garments** | Good (improved edit fidelity) | Best (trained on fashion data) | Excellent (photorealism) | Poor for fabric/soft goods | Best (real photos) |
| **Color consistency** | Good (hue check + improved model) | Very Good (fashion-aware) | Good (IP-Adapter forces reference) | Moderate | Perfect (real photos) |
| **Garment type accuracy** | Good with improved prompts + validation | Very Good (category-aware) | Good with ControlNet templates | Poor (rigid object bias) | Perfect |
| **Cost for 249 styles** | $35-75 | $250-500 | $160-320 + 2-3 weeks engineering | N/A (not production-ready) | Free (API calls already in pipeline) |
| **Engineering effort** | 1-2 days | 3-5 days | 2-3 weeks | Weeks (research-grade) | 0 (already built) |
| **API integration** | Already integrated (model swap) | New REST API + webhooks | ComfyUI server + custom workflow | Python + GPU infra | Already integrated |
| **Speed (249 styles)** | 2-4 hours (standard) | 4-8 hours (async) | 1-2 hours (GPU) | Days | Minutes |
| **Batch API available** | Yes (50% discount) | Varies | N/A | N/A | N/A |
| **Risk level** | Low | Medium (new vendor) | High (infra complexity) | Very High | None |
| **Future scalability** | Good to ~1,000 styles | Excellent | Best at high volume | Poor | Limited to supplier catalog |

## Detailed Analysis

### Option A: Upgrade to gpt-image-1.5 (RECOMMENDED)

**What changes:**
- Swap `model: 'gpt-image-1'` to `model: 'gpt-image-1.5'` in `callImagesEdit()`
- Update `COST_PER_IMAGE` from $0.042 to $0.034
- Improve prompt templates with structured garment descriptions
- Add post-generation garment-type validation via gpt-4o-mini
- Optionally use Batch API for 50% cost savings

**Strengths:**
- Near-zero engineering effort for the model swap itself
- Proven API, already tested in production
- Better instruction following = fewer wrong garment types
- Better edit fidelity = more consistent colors and details
- 20% cheaper per image, 4x faster generation
- Batch API halves costs further
- Full control over prompts, validation, retry logic

**Weaknesses:**
- Still a general-purpose model, not trained specifically on fashion
- Will still produce some wrong garment types (validation catches these)
- 1024x1024 output needs upscaling to 2000x2000
- Complex garments (jackets with zippers, multi-panel designs) may be challenging

**Best for:** This project. One-time batch of 249 styles. Existing integration. Low risk.

**Estimated cost:** $35-75 depending on retry rate and standard vs batch API.

### Option B: Fashion SaaS Platform (HuHu AI / Uwear AI)

**What changes:**
- New API client for the chosen SaaS platform
- Upload front images via REST API
- Handle webhook callbacks for completed generations
- Download results, run through existing quality validation
- Fallback to gpt-image-1.5 for failures

**Strengths:**
- Purpose-built for garment multi-view generation
- Trained on fashion data -- better understanding of fabric, draping, structural details
- Multi-angle support (front, back, side, detail) built in
- Batch processing built in (Uwear supports 10K items per CSV batch)
- Likely higher quality output than general-purpose models

**Weaknesses:**
- $0.10+/credit, 2-3 credits per product = $250-500 for 249 styles (3-7x more expensive)
- New vendor dependency and API integration
- Webhook infrastructure needs building
- Credits-based pricing lacks the transparency of token-based pricing
- Vendor lock-in risk for a one-time batch

**Best for:** Businesses with ongoing, high-volume garment image needs where quality is paramount and budget allows.

### Option C: Self-Hosted FLUX + IP-Adapter + ControlNet

**What changes:**
- Set up ComfyUI server on GPU cloud (A100 or 4090)
- Install FLUX model + IP-Adapter extension + ControlNet models
- Create pose templates per garment type per view (back/side silhouettes)
- Build custom workflow: front image -> IP-Adapter (style/color) + ControlNet (pose) -> FLUX generation
- Build TypeScript API client to trigger workflows

**Strengths:**
- Best photorealism (FLUX is rated highest for photorealistic output)
- Lowest per-image cost at scale ($0.01-0.02/image)
- IP-Adapter forces color/texture consistency from the reference image
- ControlNet forces correct silhouette/pose
- No vendor lock-in (open source)

**Weaknesses:**
- 2-3 weeks of engineering for infrastructure + workflow tuning
- GPU cloud costs (~$1-2/hr, need server running during processing)
- Pose templates need creation for each garment type x view
- IP-Adapter weight tuning is garment-type-specific (too high = copy artifacts, too low = ignore reference)
- Maintenance burden for ComfyUI + model updates

**Best for:** High-volume production (1,000+ styles regularly) where per-image cost matters and engineering time is available.

### Option D: 3D Reconstruction (Zero123 / SV3D / Wonder3D)

**What changes:**
- Implement 3D reconstruction pipeline from single image
- Render back/side views from reconstructed 3D model
- Post-process renders to match e-commerce photo style

**Strengths:**
- Perfect view consistency (rendering from actual 3D model)
- Can generate unlimited angles once model is reconstructed
- Physically accurate lighting and shadows

**Weaknesses:**
- Research-grade, not production-ready
- Designed for rigid objects, struggles with soft fabric deformation and draping
- Lower quality output than modern image generation for 2D product photos
- Requires significant GPU infrastructure
- No existing TypeScript integration

**Best for:** No current use case. Academic research only. Not recommended.

### Option E: Supplier Photography Re-Sourcing

**What changes:**
- Re-run `sourceImages()` for all 249 styles with broadened color matching
- Investigate S&S Activewear API for back/side image availability
- Check OneSource for additional supplier codes

**Strengths:**
- Real photographs -- highest quality, perfect accuracy
- Free (API calls already in pipeline)
- No AI quality concerns
- Zero engineering effort

**Weaknesses:**
- Many suppliers (especially CSW) only provide front views
- S&S Activewear API may have back images for some styles but not all
- Cannot fill gaps that don't exist in supplier catalogs
- Will likely only cover 10-30% of the 249 styles

**Best for:** Running as a pre-pass before AI generation. Free. Reduce the AI generation workload.

## Recommendation

**Choose Option A (gpt-image-1.5 upgrade) because:**

1. The pipeline already exists and works. The upgrade is a near-drop-in change.
2. Cost is proportional to the 249-style scope ($35-75, not $250-500).
3. Engineering effort is 1-2 days, not weeks.
4. Risk is minimal -- same API surface, same retry logic, same validation.
5. Quality improvements (better edit fidelity, instruction following) address the known issues.
6. Can always escalate to Option B (Fashion SaaS) if quality is insufficient after testing.

**Prepend with Option E (supplier re-sourcing)** to reduce the number of styles that need AI generation.

**Choose Option B (Fashion SaaS) when:**
- gpt-image-1.5 quality is tested and found insufficient for certain garment types
- The business regularly needs multi-view generation for new product launches (ongoing need, not one-time)
- Budget allows $250-500 for higher quality output

**Choose Option C (FLUX self-hosted) when:**
- Volume grows to 1,000+ styles regularly
- Per-image cost becomes the primary concern
- Engineering team has capacity for 2-3 weeks of infrastructure work

## Industry Context: How Competitors Handle This

| Company | Approach | Notes |
|---------|----------|-------|
| Printful | Professional photoshoot of blank products + mockup generator overlay | Traditional photography, not AI. They photograph every product from every angle. |
| Printify | AI Image Generator for custom designs, not product views | AI used for design creation, not multi-view product photography. |
| CustomInk | Professional photography + 3D mockup tools | Invest in real photography for their catalog. |
| Large fashion brands (Etro, Zara) | Increasingly using AI for e-commerce imagery (46% growth reported for Etro) | Moving to AI-generated on-model and multi-angle shots. Using platforms like Pixel Moda, Claid, Picjam. |
| Small print-on-demand | Supplier product images or single-view only | Most don't bother with back/side views at all. Having them is already a differentiator. |

The key insight: major players use real photography or specialized fashion AI platforms. For a 249-style custom apparel catalog, gpt-image-1.5 with proper validation is the pragmatic middle ground -- better than no back views, cheaper than professional photography, and simpler than specialized platforms.

## Sources

- [OpenAI API Pricing](https://openai.com/api/pricing/)
- [GPT Image 1 vs 1.5 Comparison](https://www.aifreeapi.com/en/posts/gpt-image-1-vs-gpt-image-1-5)
- [GPT Image 1.5 Pricing Calculator](https://www.aifreeapi.com/en/posts/gpt-image-1-5-pricing-calculator)
- [HuHu AI Product Photography Guide](https://huhu.ai/blog/ai-product-photography-ultimate-guide/)
- [Uwear AI](https://uwear.ai/)
- [AI Product Photography Tools 2026](https://claid.ai/blog/article/ai-product-photo-tools)
- [Printful Mockup Generators](https://www.printful.com/blog/product-photos-mockup-generators)
- [BoF: AI and Fashion E-Commerce](https://www.businessoffashion.com/articles/technology/bof-voices-ai-and-the-future-of-fashion-ecommerce-content/)
- [FLUX Models](https://bfl.ai/models)
- [SV3D Paper](https://sv3d.github.io/)
- [Zero123++](https://arxiv.org/abs/2310.15110)
- [Image2Garment](https://arxiv.org/html/2601.09658v3)
- Prior research: `.planning/research/ai-garment-image-generation-report.md`
