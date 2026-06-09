# Architecture: Multi-View Garment Generation Pipeline

**Domain:** Generating back/side views for 249 apparel styles from front images
**Researched:** 2026-03-31

## Recommended Architecture

### Pipeline Overview

```
[249 Styles with Front Image]
         |
         v
[1. Supplier Image Re-Source] -- Try OneSource + S&S APIs for back/side views
         |
         v  (styles still missing views)
[2. Garment Description]      -- gpt-4o-mini Vision describes garment details
         |
         v
[3. Prompt Construction]      -- Build view-specific prompt with garment desc + color
         |
         v
[4. AI Generation]            -- gpt-image-1.5 images.edit() with front as reference
         |                        3 candidates per call, retry on failure
         v
[5. Validation Gate]          -- Garment-type check + Hue drift + Quality score
         |
    pass |        | fail (all candidates)
         v        v
[6a. Accept]  [6b. Flag for Review]
         |        |
         v        v
[7. Resize to 2000x2000] --> [8. Upload to Shopify]
```

### Component Boundaries

| Component | Responsibility | Communicates With | Existing? |
|-----------|---------------|-------------------|-----------|
| `image-sourcer.ts` | Fetch supplier images (OneSource, S&S API, CSW) | OneSource SOAP, S&S REST, CSW storefront | YES |
| `ai-image-generator.ts` | Generate views via OpenAI `images.edit()` | OpenAI API | YES (needs model upgrade) |
| `prompt-templates.ts` | Build generation prompts per garment type/view | Called by `ai-image-generator.ts` | YES (needs richer templates) |
| `ai-image-types.ts` | Types, cost constants, thresholds | Imported by generator + pipeline | YES (needs cost constant update) |
| `hue-utils.ts` | Extract dominant hue, compute hue drift | Called by generator for color validation | YES |
| `image-scorer.ts` | Score image quality (blur, resolution, content) | Called by generator + sourcer | YES |
| `cost-tracker.ts` | Track API spend against budget cap | Called by generator before each API call | YES |
| Garment-type validator | Verify generated image matches expected garment type | OpenAI gpt-4o-mini Vision API | NEW |
| Batch runner (CLI) | Orchestrate the 249-style batch run | All above components | NEW |
| Review dashboard / report | Flag images for human review | Batch runner output | NEW (simple) |

### Data Flow

1. **Input:** Style ID + front image buffer + garment type + color name
2. **Source check:** `sourceImages(styleId, colorName)` returns any supplier back/side views
3. **For missing views:** `generateGarmentView(frontBuffer, view, garmentType, colorName, costTracker)` generates candidates
4. **Validation:** Each candidate passes through garment-type check (new) + hue drift check (existing) + quality score (existing)
5. **Selection:** Best passing candidate is selected. If none pass, best-scoring candidate is flagged for human review
6. **Output:** Generated image buffer, resized to 2000x2000, ready for Shopify upload

## Patterns to Follow

### Pattern 1: Describe-Then-Generate

**What:** Use Vision API to describe the garment before generating views, so the generation prompt includes accurate garment details.
**When:** Every generation call. Already partially implemented in `describeGarment()`.
**Why:** Prevents the model from generating the wrong garment type. A richer description (collar type, sleeve length, features) gives the model stronger constraints.

**Enhancement to existing `describeGarment()`:**
```typescript
// Current prompt (too vague):
"What type of garment is this? Reply with ONLY a short description..."

// Improved prompt (structured attributes):
"Describe this garment precisely. Include:
1. Garment type (t-shirt, polo, hoodie, crewneck, jacket, etc.)
2. Collar/neckline type (crew neck, v-neck, polo collar, hood, quarter-zip)
3. Sleeve length (short, long, 3/4)
4. Fit (regular, slim, boxy, oversized)
5. Distinctive features (pockets, placket, ribbing, drawstring)
Reply with ONLY a comma-separated list."
```

### Pattern 2: Multi-Candidate with Hard Gates

**What:** Generate multiple candidates (n=3), apply hard validation gates, select best passing candidate.
**When:** Every generation. Already implemented.
**Enhancement:** Add garment-type validation as a new hard gate alongside hue drift.

```
Candidates --> [Gate: Garment Type Match?] --> [Gate: Hue Drift <= 15 deg?] --> [Rank by Quality Score] --> Best
                     |                              |
                     v (fail)                       v (fail)
              [Reject candidate]             [Reject candidate]
```

### Pattern 3: Graceful Degradation

**What:** When all candidates fail validation, return the best-scoring candidate but flag it for human review rather than silently accepting or silently dropping.
**When:** Both rounds (initial + retry) produce no passing candidates.
**Already implemented:** D-04 fallback in `generateGarmentView()`. Enhance by adding a `flaggedForReview: boolean` field to the result.

### Pattern 4: Source Before Generate

**What:** Always try to source supplier photographs before spending money on AI generation.
**When:** Before any generation call for a style.
**Why:** Real supplier photos are higher quality, free, and don't require validation.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Generating Without Reference Image
**What:** Using `images.generate()` (text-to-image) instead of `images.edit()` (image-to-image)
**Why bad:** Without the front image as reference, the model has no way to match the specific garment's color, fabric, and style. Results will be generic.
**Instead:** Always use `images.edit()` with the front image as input. This is already the case.

### Anti-Pattern 2: Over-Complex Prompts
**What:** Stuffing dozens of constraints into a single prompt, hoping the model follows all of them.
**Why bad:** Models have limited instruction-following capacity. Too many constraints leads to the model ignoring some. Diminishing returns past ~100 words.
**Instead:** Keep prompts focused on the most critical constraints (garment type, color, view angle, exclusions). Let the reference image do the heavy lifting for fabric/style details.

### Anti-Pattern 3: Trusting AI Output Without Validation
**What:** Accepting generated images without automated quality checks.
**Why bad:** The model regularly produces wrong garment types, color-shifted results, and artifacts. These degrade catalog quality.
**Instead:** Multi-gate validation (garment type + hue + quality) with flagging for human review on failures.

### Anti-Pattern 4: Real-Time Generation
**What:** Generating views on-demand when a user requests them.
**Why bad:** 5-20 second latency per image is unacceptable for user experience. API rate limits would throttle concurrent users.
**Instead:** Pre-generate all views in batch. Store in Shopify CDN. Serve pre-computed images.

## Batch Runner Architecture

The new batch runner orchestrates the full pipeline for 249 styles:

```typescript
interface BatchConfig {
  styles: StyleInput[];          // 249 styles with front image URLs
  budget: number;                // Dollar cap (default $200)
  concurrency: number;           // Parallel API calls (default 3, respect rate limits)
  outputDir: string;             // Where to save generated images
  reviewReportPath: string;      // Where to write the review report
}

interface StyleInput {
  styleId: string;
  productName: string;
  colorName: string;
  garmentType: CategoryGroup;
  frontImageUrl: string;
  missingViews: ('back' | 'side')[];
}

interface BatchResult {
  styleId: string;
  view: 'back' | 'side';
  source: 'supplier' | 'ai-generated';
  imagePath: string;
  score: number;
  verdict: 'pass' | 'fail';
  flaggedForReview: boolean;
  cost: number;
}
```

### Concurrency Strategy

- OpenAI rate limits: ~50 RPM for image generation on standard tiers
- Use p-limit or similar to cap concurrent generation at 3-5 parallel calls
- Process styles sequentially within a style (back first, then side) to share the Vision API description
- Process styles in parallel across the batch (up to concurrency limit)

## Scalability Considerations

| Concern | At 249 styles (current) | At 1,000 styles | At 8,000+ styles |
|---------|------------------------|-----------------|-------------------|
| Cost | ~$50-75 (standard) or ~$35 (batch) | ~$200-300 | ~$1,600-2,400. Consider FLUX or SaaS. |
| Time | ~2-4 hours (standard) or ~24hr (batch) | ~8-16 hours | Days. Must use Batch API. |
| Rate limits | No issue at 3 concurrent | May need higher tier | Definitely need higher tier or Batch API |
| Storage | ~500 images, ~1GB | ~2,000 images, ~4GB | ~16,000 images, ~32GB |
| Review burden | ~50 flagged for review (est.) | ~200 flagged | ~1,600 flagged. Need reviewer tooling. |

## Sources

- Existing codebase: `src/lib/ai-image-generator.ts`, `src/lib/ai-image-types.ts`, `src/lib/image-sourcer.ts`, `src/lib/prompt-templates.ts`
- [OpenAI Image Generation Guide](https://developers.openai.com/api/docs/guides/image-generation)
- [GPT Image 1.5 Model Docs](https://developers.openai.com/api/docs/models/gpt-image-1.5)
- Prior research: `.planning/research/ai-garment-image-generation-report.md`
