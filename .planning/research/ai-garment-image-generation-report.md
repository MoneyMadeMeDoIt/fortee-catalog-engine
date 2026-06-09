# AI-Generated Garment Images: Research Report

> **Date:** 2026-03-27
> **Scope:** Best practices for generating back/side views of apparel garments from front-view product photos
> **Current stack:** OpenAI `gpt-image-1` via `images.edit()` API
> **Known issues:** Wrong garment type in output, color drift, low quality/unrealistic outputs

---

## Table of Contents

1. [Best AI Models for Garment Image Generation](#1-best-ai-models-for-garment-image-generation)
2. [Prompt Engineering for Garment Views](#2-prompt-engineering-for-garment-views)
3. [Multi-View Garment Generation](#3-multi-view-garment-generation)
4. [Quality Control and Automated Validation](#4-quality-control-and-automated-validation)
5. [Production Pipeline Recommendations](#5-production-pipeline-recommendations)
6. [Prompt Templates](#6-prompt-templates)
7. [Recommendations for This Project](#7-recommendations-for-this-project)

---

## 1. Best AI Models for Garment Image Generation

### 1A. General-Purpose Image Generation Models

| Model | Strengths | Weaknesses | Cost | Best For |
|-------|-----------|------------|------|----------|
| **OpenAI gpt-image-1** | Good instruction following, multimodal understanding, decent edit capability | Color drift on garments, can hallucinate wrong garment type, $0.042/image at medium quality | $0.042/img (medium, 1024x1024) | Simple edits where broad world knowledge helps |
| **OpenAI gpt-image-1.5** | 4x faster than gpt-image-1, 20% cheaper, better image preservation in edits, stronger consistency across iterative edits | Still general-purpose (not garment-specialized) | ~$0.034/img (medium, 1024x1024) | **Recommended upgrade from gpt-image-1** — better edit fidelity |
| **FLUX (Black Forest Labs)** | Best photorealism of any model, DSLR-quality skin textures, fast (4.5s/image), stable compositions | Requires self-hosting or Replicate/fal.ai, less convenient API than OpenAI | ~$0.03/img on Replicate | Product photography where photorealism is critical |
| **Stable Diffusion XL + ControlNet + IP-Adapter** | Maximum control (pose, structure, style transfer), open-source, self-hostable, garment-specific workflows exist | Complex setup, requires ComfyUI or custom pipeline, tuning needed per garment type | Free (self-hosted) or ~$0.01-0.02/img on GPU cloud | High-volume production with strict consistency needs |
| **Midjourney** | Excellent aesthetics | No API, no img2img edit endpoint, manual-only | $30-120/mo | Not suitable for automated pipelines |

### 1B. Fashion-Specialized SaaS Platforms

These are purpose-built for exactly our use case (garment front-to-back/side generation):

| Platform | Multi-View Support | API Available | Batch Processing | Pricing | Notes |
|----------|-------------------|---------------|-------------------|---------|-------|
| **HuHu AI** | Front, side, back views | Yes (REST API with webhooks) | Yes (bulk uploads, batch try-on) | Credits-based, enterprise tier available | Best documented API for programmatic garment view generation. Supports SKU metadata in output. |
| **Uwear AI** | Front, side, back + video | Yes | Yes (up to 10,000 items per CSV batch) | $0.10/credit, credits never expire | Strongest batch pipeline. Chains multi-angle + upscaling in one run. |
| **Sellerpic AI** | Front, back, side, detail, bottom | Yes | Yes (up to 20 images per run) | Credits-based | Shopify integration built in. Pose variation for multiple angles. |
| **Vue.ai (VueModel)** | Multiple angles | Enterprise API | Yes | Enterprise pricing | Used by large fashion brands. Consistent output across garment types. |
| **Claid AI** | Multiple angles + backgrounds | Yes | Yes | Usage-based | Focus on e-commerce-ready output quality. |

**Key finding:** Fashion-specialized platforms like HuHu AI and Uwear AI are trained specifically on garment data and handle the front-to-back/side problem far better than general-purpose models. They preserve fabric drape, stitching details, and color fidelity because their training data is fashion-focused.

### 1C. Verdict on Model Choice

**For our 8,000+ product pipeline, ranked by recommendation:**

1. **Upgrade to gpt-image-1.5** (quick win) — 20% cheaper, 4x faster, better edit fidelity. Drop-in replacement via API model parameter change.
2. **Evaluate HuHu AI or Uwear AI** (medium-term) — Purpose-built for this exact problem. HuHu AI's API supports batch processing with webhook callbacks, which fits our pipeline. Uwear's CSV batch upload handles 10K items at once.
3. **FLUX + IP-Adapter pipeline on ComfyUI** (long-term, if SaaS doesn't meet quality) — Maximum control, lowest per-image cost at scale, but significant engineering investment.

---

## 2. Prompt Engineering for Garment Views

### 2A. Current Prompt Problems (Root Cause Analysis)

Our current prompts have three structural issues causing the reported problems:

**Problem 1: Wrong garment type generated**
- Root cause: The `images.edit()` API treats the input image as a *suggestion*, not a hard constraint. The text prompt can override visual input.
- Our current prompt for tops says "t-shirt" even when the input is a polo or long-sleeve.
- The `describeGarment()` Vision API call (line 35-64 in `ai-image-generator.ts`) helps, but the description may be vague.

**Problem 2: Color drift**
- Root cause: The model generates a *plausible* garment color rather than matching the input exactly. Saying "same color as input image" is too vague.
- The retry prompt doubles the color name but doesn't describe the actual color properties.

**Problem 3: Low quality / unrealistic output**
- Root cause: Missing photography-specific instructions (lighting, perspective, lens, shadows).
- The prompt doesn't specify studio conditions that would ground the model in photorealism.

### 2B. Prompt Structure Best Practices

Based on OpenAI's own gpt-image-1.5 prompting guide and community findings:

**Optimal prompt order:**
```
[Scene/Environment] -> [Subject with specifics] -> [Hard constraints/exclusions] -> [Style/Quality modifiers]
```

**Rules:**
1. **Be specific about garment type** — Don't say "t-shirt" when it's a "men's heavyweight cotton crew-neck t-shirt." Include sleeve length, collar type, fit, fabric weight.
2. **Describe the color with multiple terms** — Not just "Navy" but "Navy Blue (dark blue, #1B2A4A-range)." The model responds to color descriptions better than hex codes, but hex ranges help ground it.
3. **Specify what must NOT change** — "The EXACT same garment type as the input image. Do NOT change the garment to a different style."
4. **Include photography terms** — "Professional e-commerce product photography, studio lighting, soft shadow beneath garment, shot on white seamless background."
5. **Specify camera angle precisely** — "Photographed from directly behind, camera at chest height" vs. just "back view."
6. **Negative instructions work** — "Do NOT include: any person, model, mannequin, text, logo, print, tag, or hanger."

### 2C. Color Fidelity Techniques

1. **Name the color multiple ways:** "Heather Gray (medium gray with subtle texture, muted cool gray, not warm gray)"
2. **Reference the input explicitly:** "The output garment MUST be the identical color as the garment in the input image. Match the exact shade, saturation, and brightness."
3. **Describe what the color is NOT:** "The color is Navy Blue — NOT royal blue, NOT black, NOT teal."
4. **Lighting instruction to prevent color shift:** "Neutral white studio lighting (5500K daylight). No warm or cool color cast on the garment."

### 2D. Garment Type Preservation Techniques

1. **Use Vision API to describe the garment first** (already implemented in `describeGarment()`) — but make the description more specific by asking for collar type, sleeve type, and distinctive features.
2. **Include distinguishing features in prompt:** "This is a polo shirt with a 2-button placket and ribbed collar — NOT a t-shirt, NOT a henley."
3. **Reference structural elements:** "Hood attached at neckline, kangaroo pocket on front" for hoodies. "No hood, no pocket, crew neckline" for crewnecks.

### 2E. Improved describeGarment() Prompt

Current:
```
What type of garment is this? Reply with ONLY a short description...
```

Recommended:
```
Describe this garment precisely. Include:
1. Garment type (t-shirt, polo, hoodie, crewneck, jacket, etc.)
2. Collar/neckline type (crew neck, v-neck, polo collar, hood, quarter-zip, etc.)
3. Sleeve length (short, long, 3/4)
4. Fit (regular, slim, boxy, oversized)
5. Any distinctive features (pockets, placket, ribbing, drawstring, etc.)
Reply with ONLY a comma-separated list of these attributes. Example: "polo shirt, ribbed polo collar with 2-button placket, short sleeve, regular fit, side vents"
```

This richer description feeds directly into the generation prompt and prevents garment-type hallucination.

---

## 3. Multi-View Garment Generation

### 3A. Research Models (Academic)

| Model | What It Does | Garment Suitability | Status |
|-------|-------------|---------------------|--------|
| **Zero123 / Zero123++** | Single image to multi-view via diffusion | Designed for rigid objects. Struggles with soft fabric deformation. | Research, available on HuggingFace |
| **SyncDreamer** | Synchronized multi-view diffusion (joint probability across views) | Better consistency than Zero123 but still optimized for rigid objects. | Research |
| **Wonder3D** | Single image to textured 3D mesh in 2-3 minutes | Produces actual 3D model you can render from any angle. Overkill for 2D product photos but guarantees view consistency. | Research, GitHub available |
| **Garment3DGen** | 3D garment stylization and texture generation | Specifically designed for garments. Generates 3D garment meshes. | Research (2024 paper) |
| **Image2Garment** | Simulation-ready garment generation from single image | Creates garment meshes that can be rendered from any angle. Most garment-specific. | Research (2025 paper) |

### 3B. Practical Assessment

**None of the academic multi-view models are production-ready for our use case.** They are:
- Designed for 3D reconstruction, not 2D product photography
- Struggle with fabric deformation and draping
- Require significant GPU infrastructure
- Produce lower-quality output than modern image generation models

**The practical approaches for multi-view garment generation in production are:**

1. **Fashion SaaS platforms** (HuHu, Uwear) — trained specifically on garment multi-view data
2. **IP-Adapter + ControlNet in ComfyUI/Stable Diffusion** — use the front image as IP-Adapter input for style/color, ControlNet for pose/structure
3. **OpenAI images.edit() with strong prompts** — what we do now, but improved

### 3C. IP-Adapter + ControlNet Approach (If We Go Self-Hosted)

**How it works for garment views:**
1. **IP-Adapter** takes the front image and extracts style embeddings (color, texture, fabric, design)
2. **ControlNet (OpenPose or Depth)** provides the structural template for the target view (back/side silhouette)
3. **Stable Diffusion / FLUX** generates the image conditioned on both

**Advantages:**
- IP-Adapter forces color and texture consistency from the reference image
- ControlNet forces correct garment silhouette/pose
- Garment type is preserved because the silhouette template defines it
- Cost: ~$0.01-0.02/image on GPU cloud

**Disadvantages:**
- Requires maintaining ComfyUI infrastructure
- Needs a library of ControlNet pose templates per garment type per view
- Tuning IP-Adapter weight (0.0-1.0) is garment-type-specific
- More engineering than API call

---

## 4. Quality Control and Automated Validation

### 4A. Current Validation (What We Have)

Our pipeline already implements (in `image-scorer.ts` and `hue-utils.ts`):
- **Hue drift detection:** Extracts dominant hue from front and generated images, rejects if drift > 15 degrees
- **Achromatic bypass:** White/black/gray garments skip hue check
- **Quality scoring:** Blur detection, resolution check, proportion check, content suitability (print/logo detection, on-model detection, background whiteness, watermark detection)
- **Multi-candidate selection:** 3 candidates per call, picks best hue-passing + highest quality

### 4B. What's Missing: Garment Type Validation

**The biggest gap is automated garment-type verification.** Our pipeline checks color and quality but does not verify the generated image contains the correct garment type.

**Recommended approach: FashionCLIP classification**

FashionCLIP (available at `patrickjohncyh/fashion-clip` on HuggingFace) is a CLIP model fine-tuned on 800K fashion products. It can classify garment type with high accuracy.

**Implementation:**
```typescript
// Post-generation validation pseudocode
async function validateGarmentType(
  generatedBuffer: Buffer,
  expectedType: string, // e.g., "polo shirt", "hoodie", "t-shirt"
): Promise<{ match: boolean; confidence: number; detectedType: string }> {

  // Option A: Use OpenAI Vision (simplest, already have client)
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 30,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `What garment type is this? Reply with ONLY the garment type (e.g., "t-shirt", "polo shirt", "hoodie", "crewneck", "jacket").` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${generatedBuffer.toString('base64')}` } },
      ],
    }],
  });

  const detected = response.choices[0]?.message?.content?.trim().toLowerCase() ?? '';
  const expected = expectedType.toLowerCase();

  // Fuzzy match: "polo shirt" matches "polo", "t-shirt" matches "tee"
  const match = detected.includes(expected) || expected.includes(detected);

  return { match, confidence: match ? 1.0 : 0.0, detectedType: detected };
}
```

**Cost:** ~$0.001 per validation call with gpt-4o-mini. For 8,000 products x 2 views = 16,000 calls = ~$16.

**Option B: FashionCLIP (zero API cost, runs locally)**
```python
from transformers import CLIPModel, AutoProcessor
model = CLIPModel.from_pretrained("patrickjohncyh/fashion-clip")
processor = AutoProcessor.from_pretrained("patrickjohncyh/fashion-clip")

# Compare image against candidate labels
labels = ["t-shirt", "polo shirt", "hoodie", "crewneck sweatshirt", "jacket", "long sleeve shirt"]
inputs = processor(text=labels, images=generated_image, return_tensors="pt", padding=True)
outputs = model(**inputs)
probs = outputs.logits_per_image.softmax(dim=1)
# probs[0] gives confidence for each label
```

### 4C. Enhanced Color Validation

Current hue-drift check (dominant hue comparison) is good but can miss saturation/lightness drift. Add:

1. **Color histogram comparison** using OpenCV's `cv2.compareHist()` with Bhattacharyya distance
2. **LAB color space comparison** — more perceptually uniform than RGB/HSL. Delta-E (CIE2000) < 5 means visually indistinguishable.
3. **Segmented comparison** — compare only the garment region (exclude background) by masking with the garment bounds from `detectGarmentBounds()`.

**Practical enhancement for our pipeline:**
```typescript
// Add to scoreCandidates() — compare garment-region color histograms
async function colorHistogramDistance(
  frontBuffer: Buffer,
  candidateBuffer: Buffer,
): Promise<number> {
  // 1. Extract garment regions from both images
  // 2. Convert to LAB color space
  // 3. Compute 3D color histogram for each
  // 4. Return Bhattacharyya distance (0 = identical, 1 = completely different)
  // Reject if distance > 0.3
}
```

### 4D. Full Validation Pipeline (Recommended)

For each generated candidate, run in parallel:
1. **Garment type check** (Vision API or FashionCLIP) — reject if wrong type
2. **Hue drift check** (existing) — reject if > 15 degrees
3. **Color histogram distance** (new) — reject if Bhattacharyya > 0.3
4. **Quality score** (existing) — blur, resolution, proportion, content
5. **Background whiteness** (existing) — reject non-white backgrounds

Score = weighted combination. Only accept candidates passing all hard gates (garment type, hue, background).

---

## 5. Production Pipeline Recommendations

### 5A. Option 1: Upgrade Current Pipeline (Lowest Effort)

**Changes:**
1. Switch `gpt-image-1` to `gpt-image-1.5` — better edit fidelity, 20% cheaper, 4x faster
2. Improve prompts (see Section 6) — fix garment type and color drift issues
3. Enhance `describeGarment()` to capture more garment details
4. Add garment-type validation post-generation
5. Add color histogram comparison to candidate scoring

**Cost estimate for 8,000 products:**
- 2 views per product = 16,000 views
- 3 candidates per view, ~50% retry rate = ~24,000 API calls
- At ~$0.034/image (gpt-image-1.5 medium) = ~$816
- Plus validation calls (~$16 for gpt-4o-mini)
- **Total: ~$832**

**Timeline:** 1-2 days of engineering

### 5B. Option 2: Fashion SaaS Platform (Best Quality/Effort Ratio)

**Use HuHu AI or Uwear AI for view generation:**
1. Upload front images via API
2. Request back and side views
3. Download results with webhook callbacks
4. Run our existing quality validation on results
5. Fall back to gpt-image-1.5 for any failures

**Cost estimate for 8,000 products:**
- Uwear: $0.10/credit, ~2-3 credits per product (front+back+side) = ~$1,600-2,400
- HuHu: Similar credits-based pricing, enterprise tiers available
- Significantly higher quality and consistency than general-purpose models

**Timeline:** 3-5 days (API integration + webhook handling + fallback logic)

### 5C. Option 3: Self-Hosted FLUX + IP-Adapter (Lowest Cost at Scale)

**Infrastructure:**
- ComfyUI server on GPU cloud (A100 or 4090)
- FLUX model + IP-Adapter + ControlNet pose templates
- Custom workflow per garment type

**Cost estimate for 8,000 products:**
- GPU time: ~$0.01-0.02/image x 16,000 = ~$160-320
- GPU server: ~$1-2/hr, processing ~100 images/hr = ~$160-320
- **Total: ~$320-640**

**Timeline:** 2-3 weeks (infrastructure + workflow tuning + testing)

### 5D. Recommended Approach: Staged Rollout

| Phase | Action | Timeline | Expected Improvement |
|-------|--------|----------|---------------------|
| **Week 1** | Upgrade to gpt-image-1.5, improve prompts, add garment-type validation | 2 days | 40-60% reduction in wrong garment type |
| **Week 2** | Evaluate HuHu AI / Uwear AI on 100 sample products | 3 days | Benchmark quality vs. current approach |
| **Week 3** | If SaaS quality is better: integrate as primary, gpt-image-1.5 as fallback | 3 days | Best overall quality |
| **Month 2** | If volume justifies: evaluate self-hosted FLUX pipeline | 2 weeks | Lowest cost at scale |

---

## 6. Prompt Templates

### 6A. Improved Template Structure

All prompts follow this structure:
```
[Camera angle and subject] [Garment-specific details from Vision API] [Color specification] [Environment] [Hard exclusions] [Photography style]
```

### 6B. Templates for gpt-image-1 / gpt-image-1.5 images.edit()

**Important:** These prompts are designed for the `images.edit()` endpoint where the front image is provided as input. The model can see the input image, so we reference it.

---

#### Template 1: T-Shirt Back View
```
Back view of this exact garment — a {color_name} short-sleeve crew-neck t-shirt. The garment
is rotated 180 degrees to show the back. Same fabric, same fit, same color as the input image.
The color is {color_name} ({color_description}), NOT any other shade.
Plain white seamless background. Professional e-commerce product photography with soft,
even studio lighting (5500K neutral daylight). Subtle drop shadow beneath the garment.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT change the garment type — this is a t-shirt, not a hoodie or sweatshirt.
```

#### Template 2: T-Shirt Side View
```
Side/profile view of this exact garment — a {color_name} short-sleeve crew-neck t-shirt,
rotated approximately 90 degrees to show the side profile. Same fabric, same fit, same
color as the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography with soft,
even studio lighting. Subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
```

#### Template 3: Polo Shirt Back View
```
Back view of this exact garment — a {color_name} polo shirt with ribbed collar and button
placket. Rotated 180 degrees to show the back. The collar is visible from behind. Same
fabric, same fit, same color as the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting (5500K), subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT change this to a t-shirt — it must have a polo collar visible from the back.
```

#### Template 4: Polo Shirt Side View
```
Side profile view of this exact garment — a {color_name} polo shirt. Rotated ~90 degrees
to show the side. The ribbed collar and sleeve should be visible in profile. Same fabric,
same fit, same color as the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting, subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
```

#### Template 5: Hoodie Back View
```
Back view of this exact garment — a {color_name} pullover hoodie. Rotated 180 degrees to
show the back. The hood is DOWN and resting flat against the upper back. Same fabric, same
fit, same color as the input image. The color is {color_name} ({color_description}).
Kangaroo pocket visible from behind if applicable.
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting (5500K), subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT change this to a crewneck — the hood MUST be visible.
```

#### Template 6: Hoodie Side View
```
Side profile view of this exact garment — a {color_name} pullover hoodie. Rotated ~90 degrees
to show the side. The hood profile should be visible. Same fabric, same fit, same color as
the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting, subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
```

#### Template 7: Crewneck Sweatshirt Back View
```
Back view of this exact garment — a {color_name} crewneck sweatshirt (NO HOOD). Rotated 180
degrees to show the back. Ribbed crew neckline visible from behind. Same heavier sweatshirt
fabric, same fit, same color as the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting (5500K), subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT add a hood — this is a CREWNECK, not a hoodie.
```

#### Template 8: Crewneck Sweatshirt Side View
```
Side profile view of this exact garment — a {color_name} crewneck sweatshirt (NO HOOD).
Rotated ~90 degrees to show the side. Same heavier sweatshirt fabric, same fit, same color
as the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting, subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT add a hood.
```

#### Template 9: Jacket/Quarter-Zip Back View
```
Back view of this exact garment — a {color_name} {garment_subtype} (e.g., "quarter-zip
pullover" or "full-zip jacket"). Rotated 180 degrees to show the back. Same fabric, same
fit, same color as the input image. The color is {color_name} ({color_description}).
Zipper line NOT visible from back (only zipper pull tab at collar if quarter-zip).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting (5500K), subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
```

#### Template 10: Long Sleeve Shirt Back View
```
Back view of this exact garment — a {color_name} long-sleeve shirt/tee. Rotated 180 degrees
to show the back. Full-length sleeves visible. Same fabric weight, same fit, same color as
the input image. The color is {color_name} ({color_description}).
Plain white seamless background. Professional e-commerce product photography, soft even
studio lighting (5500K), subtle drop shadow.
Do NOT include any person, model, mannequin, hanger, text, logo, print, or tag.
Do NOT shorten the sleeves — this is a LONG-sleeve garment.
```

### 6C. Retry Prompt Pattern

When the initial prompt fails validation, the retry adds stronger constraints:

```
CRITICAL: Generate the {view} view of this EXACT {garment_description}.

GARMENT IDENTITY (DO NOT CHANGE):
- Type: {garment_type} — NOT a {common_confusion} (e.g., "NOT a hoodie" for crewnecks)
- Collar: {collar_type}
- Sleeves: {sleeve_type}
- Features: {features}

COLOR (MUST MATCH INPUT EXACTLY):
- Color name: {color_name}
- Description: {color_description}
- This is NOT {wrong_color_1}, NOT {wrong_color_2}
- Match the EXACT shade from the input image

REQUIREMENTS:
- Plain white seamless background
- Professional studio photography, neutral 5500K lighting
- No person, model, mannequin, hanger, text, logo, print, or tag
- Subtle drop shadow only
```

### 6D. Color Description Helper

To improve color fidelity, generate a richer color description from the dominant color:

```typescript
function describeColor(colorName: string, rgb: { r: number; g: number; b: number }): string {
  const { r, g, b } = rgb;
  const brightness = (r + g + b) / 3;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);

  let warmth = '';
  if (r > b + 20) warmth = 'warm-toned';
  else if (b > r + 20) warmth = 'cool-toned';
  else warmth = 'neutral-toned';

  let lightness = '';
  if (brightness > 200) lightness = 'light/pale';
  else if (brightness > 140) lightness = 'medium';
  else if (brightness > 80) lightness = 'dark';
  else lightness = 'very dark/deep';

  return `${colorName} (${lightness}, ${warmth}, approximately RGB ${r},${g},${b})`;
}
```

---

## 7. Recommendations for This Project

### 7A. Immediate Actions (This Week)

1. **Switch to `gpt-image-1.5`** in `callImagesEdit()`. Change `model: 'gpt-image-1'` to `model: 'gpt-image-1.5'`. Update `COST_PER_IMAGE` to ~$0.034. This is a one-line change with immediate quality and cost improvement.

2. **Enhance `describeGarment()`** to request structured garment attributes (collar type, sleeve length, distinctive features). Feed the full description into prompts.

3. **Replace prompt templates** with the richer versions from Section 6 that include photography terms, explicit garment-type constraints, and color descriptions.

4. **Add garment-type validation** as a post-generation check using gpt-4o-mini Vision (cheapest option, ~$0.001/call). Reject candidates where the detected garment type doesn't match the expected type.

5. **Add `describeColor()` helper** to generate richer color descriptions from the dominant RGB values extracted by `extractDominantHue()`.

### 7B. Short-Term Actions (Next 2 Weeks)

6. **Benchmark HuHu AI or Uwear AI** on 50-100 sample products across all garment types. Compare quality, color fidelity, and garment-type accuracy against our improved gpt-image-1.5 pipeline. If the SaaS quality is significantly better, integrate it as the primary generation path.

7. **Add color histogram validation** using sharp's histogram comparison. Compare garment-region color distributions between front and generated images.

8. **Expand `CategoryGroup` type** beyond just `tops` and `hoodies` to include `polos`, `crewnecks`, `jackets`, `long-sleeves` with garment-specific prompts and reference ratios for each.

### 7C. Architectural Note

The current `prompt-templates.ts` only has templates for `tops` and `hoodies`. The `buildPromptFromName()` function (which uses the Vision-described garment name) is the right direction but needs the richer prompt structure from Section 6. Consider making the prompt a template function that takes the full garment description object rather than just a category string.

---

## Sources

- [OpenAI Image Generation Guide](https://developers.openai.com/api/docs/guides/image-generation)
- [GPT-Image-1.5 Prompting Guide (OpenAI Cookbook)](https://cookbook.openai.com/examples/multimodal/image-gen-1.5-prompting_guide)
- [GPT Image 1.5 Prompt Guide (fal.ai)](https://fal.ai/learn/devs/gpt-image-1-5-prompt-guide)
- [GPT Image 1.5 vs GPT Image 1 Comparison (Appaca)](https://www.appaca.ai/resources/llm-comparison/gpt-image-1.5-vs-gpt-image-1)
- [GPT Image 1.5 Complete Guide (ALM Corp)](https://almcorp.com/blog/chat-gpt-image-1-5-complete-guide/)
- [GPT Image 1.5 Feature Comparison (Evolink)](https://evolink.ai/blog/gpt-image-1-5-guide-features-comparison-access)
- [Best AI Image Models 2026 (TeamDay)](https://www.teamday.ai/blog/best-ai-image-models-2026)
- [FLUX vs Stable Diffusion Comparison 2026 (pxz.ai)](https://pxz.ai/blog/flux-vs-stable-diffusion:-technical-&-real-world-comparison-2026)
- [HuHu AI - Product Photography Guide](https://huhu.ai/blog/ai-product-photography-ultimate-guide/)
- [HuHu AI Studio](https://huhu.ai/studio/)
- [Uwear AI](https://uwear.ai/)
- [Sellerpic AI - Pose Generator](https://www.sellerpic.ai/tools/ai-pose-generator)
- [Best AI Fashion Generators 2026 (Wearview)](https://www.wearview.co/blog/best-ai-fashion-model-generators)
- [AI Clothing Transfer: ControlNet and IP-Adapter Guide (Toolify)](https://www.toolify.ai/ai-news/ai-clothing-transfer-controlnet-and-ipadapter-guide-3510430)
- [ComfyUI IP-Adapter Plus (GitHub)](https://github.com/cubiq/ComfyUI_IPAdapter_plus)
- [IP-Adapter (HuggingFace Diffusers)](https://huggingface.co/docs/diffusers/main/en/using-diffusers/ip_adapter)
- [FashionCLIP (HuggingFace)](https://huggingface.co/patrickjohncyh/fashion-clip)
- [CLIP Score (PyPI)](https://pypi.org/project/clip-score/)
- [Zero123++ Multi-View Diffusion (Unite.AI)](https://www.unite.ai/zero123-a-single-image-to-consistent-multi-view-diffusion-base-model/)
- [SyncDreamer (arXiv)](https://arxiv.org/abs/2309.03453)
- [Wonder3D (GitHub)](https://github.com/xxlong0/Wonder3D)
- [Garment3DGen (arXiv)](https://arxiv.org/html/2403.18816v1)
- [Image2Garment (arXiv)](https://arxiv.org/html/2601.09658v3)
- [Color Histogram Comparison (PyImageSearch)](https://pyimagesearch.com/2014/07/14/3-ways-compare-histograms-using-opencv-python/)
- [OpenAI Developer Community - Prompting Tips](https://community.openai.com/t/collection-of-gpt-4o-images-prompting-tips-issues-and-bugs/1201440)
- [Prompt Engineering Best Practices (gpt-image-1.app)](https://www.gpt-image-1.app/blog/prompt-engineering-best-practices)
