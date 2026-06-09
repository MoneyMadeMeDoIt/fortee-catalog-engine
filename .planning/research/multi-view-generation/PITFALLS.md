# Domain Pitfalls: Multi-View Garment Generation

**Domain:** AI-generated back/side views of apparel garments for e-commerce catalog
**Researched:** 2026-03-31

## Critical Pitfalls

Mistakes that cause rewrites, waste budget, or ship bad images to customers.

### Pitfall 1: Wrong Garment Type Generation
**What goes wrong:** AI generates a different garment type from the input. Example: front image is a polo shirt, but the generated back view is a plain t-shirt (no collar). Or a crewneck sweatshirt gets a hood added.
**Why it happens:** `images.edit()` treats the input image as a suggestion, not a hard constraint. The text prompt can override visual input. The current prompts use generic category labels ("garment", "hoodie") that don't capture distinguishing details.
**Consequences:** Shoppers see mismatched front/back views. Erodes trust. Particularly bad for polos (collar disappears from back), hoodies (hood disappears or appears on crewnecks), and jackets (zipper details change).
**Prevention:**
1. Enhance `describeGarment()` to capture structured attributes (collar type, sleeve length, features)
2. Include explicit garment-type constraints in prompts: "This is a polo with a ribbed collar -- NOT a t-shirt"
3. Add post-generation garment-type validation using gpt-4o-mini Vision
4. Reject and retry when garment type doesn't match
**Detection:** Garment-type mismatch between input description and generated image classification. Add as a hard gate in candidate scoring.

### Pitfall 2: Color Drift Between Views
**What goes wrong:** The generated back view is a noticeably different shade from the front. Navy appears as royal blue. Heather gray shifts to solid gray.
**Why it happens:** The model generates "plausible" colors rather than exact matches. Saying "same color" is vague. The model doesn't pixel-match -- it interprets the color semantically.
**Consequences:** Product page shows front and back in different colors. Customers will think it's a defective product or scam listing.
**Prevention:**
1. Include color name + description in prompt: "Navy Blue (dark blue, cool-toned, not royal blue, not teal)"
2. Existing hue-drift check (15-degree threshold) catches most cases
3. Consider adding LAB color space comparison for more perceptually accurate matching
4. Achromatic bypass for white/black/gray is already implemented
**Detection:** Hue drift > 15 degrees (existing). Could enhance with color histogram comparison.

### Pitfall 3: Budget Overrun on Large Batches
**What goes wrong:** 249 styles x 2 views x 3 candidates x possible retries = potentially 3,000+ API calls. With retries and failures, costs spiral past the $200 budget.
**Why it happens:** Each failed round triggers a retry with 3 more candidates. High failure rates on certain garment types (especially complex ones like jackets) can double the expected cost.
**Consequences:** Budget exhaustion mid-batch. Some styles get views, others don't.
**Prevention:**
1. Use the existing `CostTracker` with a realistic budget (the current $200 default is adequate for 249 styles)
2. Process styles in priority order (highest-traffic products first)
3. Use Batch API for 50% cost reduction
4. Monitor cost per style during the run; abort or switch strategies if average cost exceeds expectations
**Detection:** CostTracker alerts when budget is nearing exhaustion. Log cost-per-style averages.

### Pitfall 4: Content Policy Rejections
**What goes wrong:** OpenAI's content policy rejects certain garment generation requests, returning 0 candidates. The code handles this gracefully (returns empty array) but the style gets no generated views.
**Why it happens:** Certain garment colors, shapes, or combinations trigger safety filters. Skin-tone colors, certain camouflage patterns, or images that look like body parts can trigger rejections.
**Consequences:** Styles silently get no back/side views. If not tracked, these gaps go unnoticed.
**Prevention:**
1. Already handled in `callImagesEdit()` (catches content policy errors, returns empty array)
2. Track which styles fail due to content policy separately from quality failures
3. For content-policy-rejected styles, try alternative prompts or source from supplier photography
**Detection:** Log content policy rejections separately. Review list after batch run.

## Moderate Pitfalls

### Pitfall 5: Hallucinated Graphics/Logos on Back View
**What goes wrong:** AI adds a logo, text, or graphic design to the back of a blank garment. Or it puts the front design on the back.
**Why it happens:** Training data includes garments with back prints. The model "completes" the garment by adding expected back designs.
**Prevention:**
1. Explicit negative constraint in prompt: "No print, no text, no logo, no graphic, no design. This is a BLANK garment."
2. Existing quality scorer checks for content/print detection
3. gpt-image-1.5 has better instruction following for negative constraints than gpt-image-1

### Pitfall 6: Inconsistent Lighting/Shadow Between Views
**What goes wrong:** Front image has specific lighting and shadow patterns. Generated back/side has different lighting, making the images look like they're from different photo sessions.
**Why it happens:** The model generates a "generic studio photo" rather than matching the specific lighting of the input.
**Prevention:**
1. Include photography-specific instructions: "Professional e-commerce product photography, soft even studio lighting (5500K neutral daylight), subtle drop shadow beneath garment"
2. gpt-image-1.5 is better at preserving lighting context from the input image
3. Post-processing with sharp to normalize brightness/contrast if needed

### Pitfall 7: Resolution Mismatch in Final Output
**What goes wrong:** Generated images are 1024x1024 (API limit) but catalog needs 2000x2000. Upscaling introduces blur or artifacts.
**Why it happens:** OpenAI's image generation API caps at 1024x1024. The existing pipeline already resizes input to 1024x1024.
**Prevention:**
1. Already handled: images are standardized to 2000x2000 by the image standardizer with white padding
2. For AI-generated images, the 1024x1024 output is the source of truth. Upscaling to 2000x2000 uses sharp's lanczos resampling
3. The quality difference between native 2000x2000 (supplier photos) and upscaled 1024x1024 (AI) is noticeable but acceptable for e-commerce

### Pitfall 8: Batch API Timeout or Failure
**What goes wrong:** Batch API jobs can take up to 24 hours. Jobs may fail silently or partially complete.
**Why it happens:** Batch processing is asynchronous. No real-time feedback. OpenAI processes in their own queue.
**Prevention:**
1. Implement polling for batch job status
2. Handle partial completions (some images generated, others failed)
3. Have a fallback to standard API for failed items in the batch
4. Set reasonable expectations: batch is for cost savings, not speed

## Minor Pitfalls

### Pitfall 9: Garment Proportions in Side View
**What goes wrong:** Side views look stretched or have incorrect proportions compared to the front view. Sleeves appear different lengths. Torso seems wider or narrower.
**Prevention:** Include "same proportions and fit as the input image" in prompts. Accept that side-view proportions are inherently less constrained than back views.

### Pitfall 10: Edge Cases -- Bags, Caps, and Non-Standard Garments
**What goes wrong:** The pipeline is optimized for standard garments (t-shirts, polos, hoodies). Bags and caps have fundamentally different back/side views that require different prompting strategies.
**Prevention:** Create garment-type-specific prompt templates for non-standard categories. Consider whether bags and caps need AI generation at all (supplier photos may be sufficient).

### Pitfall 11: Rate Limiting During Batch Run
**What goes wrong:** Hitting OpenAI rate limits causes 429 errors and delays.
**Prevention:**
1. Cap concurrent requests at 3-5 (well below rate limits)
2. Implement exponential backoff on 429 responses
3. Use Batch API to avoid rate limit concerns entirely (batch processing is off-peak)

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Model upgrade (gpt-image-1 to 1.5) | Output drift -- prompts tuned for 1.0 may behave differently on 1.5 | Test on 10 sample styles before full batch. Compare side-by-side. |
| Prompt improvement | Over-constraining -- too many instructions cause model to ignore some | Keep prompts under ~150 words. Prioritize garment type and color constraints. |
| Garment-type validation | False positives -- Vision API misclassifies a valid image | Use fuzzy matching (e.g., "polo" matches "polo shirt"). Allow human override on flagged items. |
| Batch run | Partial failures leave catalog in inconsistent state | Track completion per style. Don't publish until all views for a style are ready. |
| Human review | Review fatigue on 50+ flagged images | Sort by severity. Show front + generated side-by-side. Allow quick accept/reject. |
| Non-standard garments (bags, caps) | Generic garment prompts produce poor results | Use separate prompt templates or skip AI generation for these categories. |

## Sources

- Existing codebase analysis: `src/lib/ai-image-generator.ts` (content policy handling, D-04 fallback)
- [OpenAI Content Policy](https://openai.com/policies/usage-policies/)
- [GPT Image 1.5 Prompting Guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide) - instruction following improvements
- Prior research: `.planning/research/ai-garment-image-generation-report.md` - prompt engineering findings
- [OpenAI Developer Community](https://community.openai.com/t/collection-of-gpt-4o-images-prompting-tips-issues-and-bugs/1201440) - community-reported issues
