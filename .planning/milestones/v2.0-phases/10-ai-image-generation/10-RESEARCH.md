# Phase 10: AI Image Generation - Research

**Researched:** 2026-03-26
**Domain:** OpenAI images API (gpt-image-1), image hue comparison, cost tracking
**Confidence:** MEDIUM-HIGH (API actively evolving; key pitfalls verified via community sources)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Use garment-type-aware prompts. Different prompt templates per garment category (t-shirt, hoodie, polo, etc.) using the existing template-map categories. Example: "Back view of this [navy blue] [t-shirt] on a plain white background, blank garment, no print, no model."
- **D-02:** Include the garment's color name in the prompt to help prevent color drift. Pull color from product data.
- **D-03:** Generate 3 candidates per view. Pick the highest quality-scored candidate that passes the 15-degree hue drift check.
- **D-04:** If ALL 3 candidates fail (color drift or quality), retry once with an adjusted prompt (stronger color instruction). Max 6 API calls per view. If still all fail after retry, return the best of the 6 candidates regardless.
- **D-05:** AI-enhance the existing front image via `images.edit()` with a cleanup prompt (e.g., "Clean up this garment photo: remove blur, fix lighting, plain white background"). Use the real garment as reference — do not generate from scratch.
- **D-06:** Per-product cap: max 6 API calls per view (3 initial + 3 retry). This is a hard limit.
- **D-07:** Global budget cap: $200 total across all products. Track cumulative cost per API call. Stop generating and report when budget is exhausted.
- **D-08:** Dry-run mode should estimate cost before actual generation (count views needing generation, multiply by estimated cost per view).

### Claude's Discretion
- Specific prompt wording per garment type (researcher should experiment)
- OpenAI model selection (gpt-image-1 vs dall-e-3 vs whatever is current)
- Image size/quality parameters for images.edit()
- Hue comparison algorithm implementation (HSL conversion approach)
- Rate limiting strategy (concurrent requests, delays between calls)
- Cost tracking storage mechanism (in-memory vs file)
- How to handle OpenAI API errors (timeout, rate limit, content policy rejection)

### Deferred Ideas (OUT OF SCOPE)
- **Contextual on-model photos** (from Phase 08): Generate 1 on-model mannequin photo per product where the model is contextually appropriate to the garment type. Not in scope for Phase 10.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AIGEN-01 | System generates missing back and side views from a front image using OpenAI images.edit API | Confirmed: images.edit() with gpt-image-1 works; SDK install procedure documented |
| AIGEN-02 | System generates 2-3 candidates per view and selects the best match via color-distance and quality scoring | Confirmed: n parameter supports 1-10; sharp.stats().dominant enables hue extraction |
| AIGEN-03 | System replaces existing images that fail quality scoring with AI-generated alternatives | Confirmed: cleanup prompt via images.edit() with source image as input |
| AIGEN-04 | Generated images maintain color fidelity and garment proportions consistent with the source front image | HSL hue comparison algorithm documented; proportion preserved via 1024x1024 square output |
</phase_requirements>

---

## Summary

Phase 10 integrates the OpenAI images API to generate missing garment views. The critical model is **gpt-image-1** (not DALL-E 3 or DALL-E 2). The Node.js SDK is `openai` v6.33.0 (already decided in STATE.md). The `images.edit()` endpoint takes a PNG image buffer (via the `toFile()` helper) and a text prompt, and returns base64-encoded PNG data in `response.data[0].b64_json`.

The most important operational finding is **API latency**: gpt-image-1 takes 44–130 seconds per request at medium quality 1024x1024. With 3 candidates per view and 2 views per product, a single product can take 4–13 minutes of API wait time. This dictates sequential-not-concurrent API calls to avoid rate limits. The default SDK timeout (10 minutes) should be raised to 600 seconds per call.

For hue comparison (D-03's 15-degree drift check), `sharp.stats()` returns a `.dominant` property (most dominant sRGB color via 4096-bin 3D histogram) — no extra library needed. Convert the dominant RGB to HSL and compare hue angles.

**Primary recommendation:** Use `gpt-image-1` at `quality: 'medium'` and `size: '1024x1024'` for the best balance of cost ($0.042/image), speed, and stability. Avoid `quality: 'high'` for initial implementation due to 130-second latency risk.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| openai | 6.33.0 | OpenAI API client | Official SDK; already decided in STATE.md; latest stable |
| sharp | ^0.34.5 | Image processing, hue extraction | Already in project; stats().dominant for color comparison |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | — | Hue comparison is pure math on stats().dominant RGB | No extra dep needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| gpt-image-1 | dall-e-3 | DALL-E 3 doesn't support images.edit(); generate-only, no input image reference |
| gpt-image-1 | dall-e-2 | Deprecated 2026-05-12; lower quality; no prompt adherence for color names |
| gpt-image-1 | gpt-image-1.5 | 1.5 is newer but same pricing/limits; gpt-image-1 is confirmed stable |
| sharp.stats().dominant | node-vibrant | Extra dependency; sharp.dominant is sufficient for hue check |
| in-memory cost tracking | file-based | File-based survives process restart; in-memory is simpler for single-run CLI |

**Installation:**
```bash
npm install openai@6.33.0
```

**Version verification:** `npm view openai version` returns `6.33.0` as of 2026-03-26. This matches the STATE.md decision.

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── lib/
│   ├── image-sourcer.ts       # Existing (Phase 09)
│   └── ai-image-generator.ts  # NEW: generateGarmentView() + cost tracker
├── shopify/
│   ├── image-scorer.ts        # Existing (Phase 08) — scoreImageQuality()
│   └── image-standardizer.ts  # Existing (Phase 08) — detectGarmentBounds()
```

### Pattern 1: images.edit() Call with Buffer Input

The OpenAI Node.js SDK requires images to be passed as `File` objects, not raw Buffers. Use the `toFile()` helper exported from the `openai` package to wrap a Buffer.

```typescript
// Source: OpenAI Node.js SDK README + cookbook
import OpenAI, { toFile } from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 600_000,  // 10 minutes — gpt-image-1 can take 130s at high quality
});

const response = await client.images.edit({
  model: 'gpt-image-1',
  image: await toFile(frontBuffer, 'front.png', { type: 'image/png' }),
  prompt: 'Back view of this navy blue t-shirt on a plain white background, blank garment, no print, no model.',
  n: 3,
  size: '1024x1024',
  quality: 'medium',
});

// Response always returns b64_json for gpt-image-1 (no response_format needed)
const imageBuffers = response.data.map(img =>
  Buffer.from(img.b64_json!, 'base64')
);
```

**Critical:** Do NOT pass `response_format` — gpt-image-1 always returns `b64_json` regardless; passing `response_format` causes a BadRequestError.

**Critical:** Do NOT pass `input_fidelity` — this parameter causes a BadRequestError on the edit endpoint (only works on the Responses API variant, not images.edit).

**Critical:** Do NOT pass `output_format` — not supported on images.edit for gpt-image-1.

### Pattern 2: Hue Drift Check via sharp.stats().dominant

```typescript
// Source: sharp docs https://sharp.pixelplumbing.com/api-input/
// stats().dominant = { r, g, b } — most dominant sRGB color from 4096-bin histogram

async function extractDominantHue(buffer: Buffer): Promise<number> {
  const stats = await sharp(buffer).stats();
  const { r, g, b } = stats.dominant;
  return rgbToHue(r, g, b);
}

function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;  // achromatic (gray/white/black)
  let h = 0;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return ((h * 60) + 360) % 360;
}

function hueDrift(hue1: number, hue2: number): number {
  const diff = Math.abs(hue1 - hue2);
  return Math.min(diff, 360 - diff);  // circular distance
}

// Usage: reject if drift > 15 degrees
const frontHue = await extractDominantHue(frontBuffer);
const candidateHue = await extractDominantHue(candidateBuffer);
const passes = hueDrift(frontHue, candidateHue) <= 15;
```

**Note on achromatic garments:** When dominant color is near-white, near-black, or neutral gray, the hue value is 0 and meaningless. Skip the hue check for garments where the dominant color's saturation is below ~10% — use `max - min < 25` as the achromatic threshold (RGB 0-255 scale).

### Pattern 3: Cost Tracking

gpt-image-1 pricing (verified 2026-03-26):
- `medium` quality, `1024x1024`: **$0.042 per image**
- `low` quality, `1024x1024`: **$0.011 per image**
- `high` quality, `1024x1024`: **$0.167 per image**

```typescript
// In-memory tracker — sufficient for single-run CLI
class CostTracker {
  private cumulative = 0;
  private readonly budget: number;

  constructor(budgetDollars: number) {
    this.budget = budgetDollars;
  }

  // Returns false if budget would be exceeded
  canAfford(estimatedCost: number): boolean {
    return this.cumulative + estimatedCost <= this.budget;
  }

  record(cost: number): void {
    this.cumulative += cost;
  }

  get total(): number { return this.cumulative; }
  get remaining(): number { return this.budget - this.cumulative; }
}

// Cost per call at medium/1024x1024
const COST_PER_IMAGE = 0.042;
```

### Pattern 4: Prompt Templates per Garment Type

```typescript
// Source: D-01/D-02 decisions + garment category system
type View = 'back' | 'side';
type GarmentType = 'tops' | 'hoodies';

const PROMPT_TEMPLATES: Record<GarmentType, Record<View, string>> = {
  tops: {
    back: 'Back view of this {color} t-shirt on a plain white background, blank garment, no print, no text, no model, same color as input image.',
    side: 'Side view of this {color} t-shirt on a plain white background, blank garment, no print, no text, no model, same color as input image.',
  },
  hoodies: {
    back: 'Back view of this {color} hoodie on a plain white background, blank garment, no print, no text, no model, hood down, same color as input image.',
    side: 'Side view of this {color} hoodie on a plain white background, blank garment, no print, no text, no model, same color as input image.',
  },
};

// Retry prompt: stronger color instruction (D-04)
const RETRY_PROMPT_TEMPLATES: Record<GarmentType, Record<View, string>> = {
  tops: {
    back: 'Back view of this exact {color} t-shirt. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
    side: 'Side view of this exact {color} t-shirt. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
  },
  hoodies: {
    back: 'Back view of this exact {color} hoodie. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person. Hood is down.',
    side: 'Side view of this exact {color} hoodie. The garment color MUST be {color}. Plain white background. Blank garment, absolutely no print, no logos, no text. No model or person.',
  },
};

function buildPrompt(template: string, colorName: string): string {
  return template.replace(/\{color\}/g, colorName);
}
```

### Pattern 5: generateGarmentView() Function Signature

```typescript
export interface GenerateViewResult {
  buffer: Buffer;
  score: number;
  verdict: 'pass' | 'fail';
  totalCost: number;     // cost for this view's calls
  callCount: number;     // how many API calls were made
  usedRetry: boolean;
  hueDrift: number;      // hue drift of selected candidate
}

export async function generateGarmentView(
  frontBuffer: Buffer,
  view: 'back' | 'side',
  garmentType: 'tops' | 'hoodies',
  colorName: string,
  costTracker: CostTracker,
): Promise<GenerateViewResult | null>  // null = budget exhausted
```

### Anti-Patterns to Avoid
- **Passing `response_format: 'b64_json'`:** gpt-image-1 always returns b64_json; adding this parameter causes a BadRequestError on some SDK versions.
- **Passing `input_fidelity`:** Supported only in the Responses API path, not `images.edit()` endpoint. Causes "Unknown parameter" error.
- **Passing `quality` as an integer:** Must be the string `'low'`, `'medium'`, or `'high'`.
- **Sending 2000x2000 PNG to the edit endpoint:** May trigger 413 errors. Resize input image to 1024x1024 before sending.
- **Using `n: 3` and processing sequentially from response:** `n: 3` returns all 3 in one API call — process `response.data` as an array (not 3 separate calls).
- **Treating neutral-gray garments as color-failed:** Achromatic garments have meaningless hue; skip hue check and accept any candidate that passes quality scoring.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP client for OpenAI API | Custom fetch wrapper | `openai` SDK (v6.33.0) | Handles auth, retry, streaming, b64 decode, FormData multipart |
| Buffer-to-File conversion for API | Manual FormData | `toFile()` from openai package | SDK helper handles MIME type, filename, boundary correctly |
| Dominant color extraction | Pixel sampling loop | `sharp(buffer).stats().dominant` | Built-in 4096-bin histogram; already a dependency |
| HSL conversion math | Import a color library | Pure JS function (4 lines) | RGB-to-HSL is trivial math; no dependency justified |
| Rate limiting via sleep() | Custom delay logic | Sequential await + IPM tracking | gpt-image-1 Tier 1 = 5 IPM; sequential with natural latency (~44s) stays within limits automatically |

**Key insight:** The 44–130 second response time per gpt-image-1 call acts as natural rate limiting. At Tier 1 (5 IPM), you can sustain one call every 12 seconds. Since each call takes at minimum 44 seconds, sequential await inherently keeps you well under the rate limit. No explicit sleep() or queue needed.

---

## Common Pitfalls

### Pitfall 1: Passing Unsupported Parameters to images.edit()
**What goes wrong:** `BadRequestError: Unknown parameter: 'response_format'` or `Unknown parameter: 'input_fidelity'` — API call fails entirely.
**Why it happens:** gpt-image-1's edit endpoint rejects parameters that are valid in the Responses API or dall-e-2 but not in the standard images.edit() path. The SDK's TypeScript types may not catch this.
**How to avoid:** Use only these parameters: `model`, `image`, `prompt`, `n`, `size`, `quality`, `mask`. Omit everything else.
**Warning signs:** `status 400` with "Unknown parameter" in error message.

### Pitfall 2: Timeout at ~180 Seconds
**What goes wrong:** The connection drops at ~180 seconds even when SDK timeout is set higher. At `quality: 'high'`, `size: '1536x1024'`, some requests take 130+ seconds and may hit the server-side limit.
**Why it happens:** OpenAI's infrastructure enforces a server-side ~180-second connection limit. Client-side timeout settings don't override this.
**How to avoid:** Use `quality: 'medium'` and `size: '1024x1024'` (typical response: 44–80s). Avoid `quality: 'high'` in initial implementation.
**Warning signs:** `APIConnectionTimeoutError` at ~180s wall-clock time.

### Pitfall 3: 413 Payload Too Large
**What goes wrong:** API returns 413 even though the PNG is under 25MB documented limit.
**Why it happens:** Practical limit appears closer to 4MB per image. Also caused by improper FormData formatting when NOT using the SDK's toFile() helper.
**How to avoid:** Resize input image to 1024x1024 PNG before sending. Use `toFile()` — never manually construct multipart FormData.
**Warning signs:** `status 413` response.

### Pitfall 4: Achromatic False Positives on Hue Check
**What goes wrong:** White, black, navy, or very dark garments get rejected by the 15-degree hue check because their dominant hue is near-zero (achromatic), and small numerical noise causes spurious failures.
**Why it happens:** When `dominant.r ≈ dominant.g ≈ dominant.b`, the hue value is undefined/zero; small floating-point differences create apparent large hue swings.
**How to avoid:** Skip hue check when `Math.max(r,g,b) - Math.min(r,g,b) < 25` (achromatic threshold). Accept the candidate as long as it passes quality scoring.
**Warning signs:** High rejection rate on solid-color garments (black hoodies, white tees).

### Pitfall 5: Content Policy Rejection on Normal Garment Images
**What goes wrong:** API returns a safety rejection even for plain blank garment prompts. The response has `data[0].b64_json = null` or the SDK throws with a content policy message.
**Why it happens:** gpt-image-1 has a two-stage safety filter. Rare false positives occur even on innocuous apparel prompts. Frequency is low but non-zero.
**How to avoid:** Treat safety rejections as "failed candidate" (not a fatal error). Log the rejection. Count it against the retry budget (D-04). If all 6 calls are content-rejected, return null for that view — do not hard-fail the product.
**Warning signs:** `status 400` with content policy message, or `data[0].b64_json === null` / `data[0].b64_json === undefined`.

### Pitfall 6: n=3 Budget Double-Counting
**What goes wrong:** Treating `n=3` as 3 separate API calls in cost tracking leads to double-counting since `n=3` is billed as 3 images but is 1 API call.
**Why it happens:** Cost is per-image, not per-request. `n=3` at medium/1024x1024 costs `3 × $0.042 = $0.126`, not `$0.042`.
**How to avoid:** `costPerCall = n × COST_PER_IMAGE`. Record `n × COST_PER_IMAGE` per API call.
**Warning signs:** Budget exhausted faster or slower than expected.

---

## Code Examples

### Full images.edit() Call Pattern
```typescript
// Source: OpenAI cookbook + Node.js SDK README
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 600_000,
});

async function callImagesEdit(
  inputBuffer: Buffer,
  prompt: string,
  n: number,
): Promise<Buffer[]> {
  // Resize to 1024x1024 to avoid 413 errors — model works fine with square input
  const resized = await sharp(inputBuffer)
    .resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  const response = await client.images.edit({
    model: 'gpt-image-1',
    image: await toFile(resized, 'input.png', { type: 'image/png' }),
    prompt,
    n,
    size: '1024x1024',
    quality: 'medium',
  });

  return response.data.map(img => Buffer.from(img.b64_json!, 'base64'));
}
```

### Content Policy Error Handling
```typescript
// Treat content policy as failed candidate, not fatal error
try {
  const buffers = await callImagesEdit(frontBuffer, prompt, 3);
  // ... score and filter candidates
} catch (err) {
  const isContentPolicy = err instanceof OpenAI.BadRequestError &&
    (err.message.includes('content_policy') || err.message.includes('safety'));
  if (isContentPolicy) {
    logger.warn(`Content policy rejection for view=${view}, colorName=${colorName}`);
    return [];  // 0 candidates from this call
  }
  throw err;  // re-throw network/auth errors
}
```

### Dry-Run Cost Estimation
```typescript
// D-08: estimate before running
function estimateCost(viewsNeeded: number): {
  minCost: number;  // 1 call per view (best case)
  maxCost: number;  // 6 calls per view (worst case retry)
  typicalCost: number;  // 3 calls per view (first batch)
} {
  const perCallCost = 3 * COST_PER_IMAGE;  // n=3 images
  return {
    minCost: viewsNeeded * perCallCost,
    maxCost: viewsNeeded * perCallCost * 2,  // one retry round
    typicalCost: viewsNeeded * perCallCost,
  };
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DALL-E 2 images.edit() | gpt-image-1 images.edit() | May 2025 | Better prompt adherence, color accuracy; DALL-E 2 deprecated May 2026 |
| dall-e-3 (generate only) | gpt-image-1 (edit from reference) | May 2025 | Edit endpoint requires input image — gpt-image-1 only |
| `response_format: 'url'` | Always `b64_json` for gpt-image-1 | May 2025 | URLs expire; b64_json is the only option; don't pass response_format |
| Sync HTTP with 60s timeout | Async with 10-min timeout | 2024+ | gpt-image-1 takes 44–130s; default SDK timeout is 600s |

**Deprecated/outdated:**
- `dall-e-2`: Deprecated 2026-05-12 per OpenAI announcement. Do not use.
- `input_fidelity` on images.edit(): Only works via the Responses API path, not the standard images/edits endpoint.
- `response_format` parameter on gpt-image-1: Ignored or causes errors; omit it.

---

## Open Questions

1. **n=3 return guarantee with content policy**
   - What we know: Content policy rejections can affect individual images within an `n=3` call
   - What's unclear: Whether the entire call fails or partial results are returned (some images pass, some fail)
   - Recommendation: Treat any partial result as a recoverable state; check `response.data.length` before processing; treat length < n as partial success

2. **gpt-image-1 vs gpt-image-1.5 for edit endpoint**
   - What we know: gpt-image-1.5 is newer and supports "try-ons" (clothing fidelity). Same pricing table. gpt-image-1 is confirmed stable.
   - What's unclear: Whether gpt-image-1.5 edit endpoint is stable vs still experimental
   - Recommendation: Start with gpt-image-1. The CONTEXT.md leaves model selection to researcher — gpt-image-1 is the safer choice for initial implementation; upgrade to 1.5 if color fidelity is poor in testing.

3. **Hue check threshold at 15 degrees — effectiveness for dark garments**
   - What we know: HSL hue is meaningless for near-achromatic colors (low saturation)
   - What's unclear: How many of the catalog's garments are dark enough to trigger achromatic bypass
   - Recommendation: Implement achromatic detection (`max-min < 25`) alongside hue check; log bypass events to quantify in testing.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Assumed present | — | — |
| `openai` npm package | AIGEN-01 | Not installed yet | — | Must install |
| `sharp` | Hue extraction, image resize | Installed | ^0.34.5 | — |
| `OPENAI_API_KEY` env var | All API calls | Unknown — check .env | — | Phase fails without it |

**Missing dependencies with no fallback:**
- `openai` package: `npm install openai@6.33.0` — required before any implementation
- `OPENAI_API_KEY`: Must be present in `.env` — document in Wave 0 setup task

**Missing dependencies with fallback:**
- None identified

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | vitest.config.ts (auto-detected from package.json `"test": "vitest run"`) |
| Quick run command | `npx vitest run tests/lib/ai-image-generator.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AIGEN-01 | generateGarmentView() calls images.edit(), returns Buffer | unit (mock OpenAI) | `npx vitest run tests/lib/ai-image-generator.test.ts` | Wave 0 |
| AIGEN-02 | 3-candidate selection picks highest scorer passing hue check | unit | `npx vitest run tests/lib/ai-image-generator.test.ts` | Wave 0 |
| AIGEN-03 | Cleanup prompt path: images.edit() with front buffer input | unit (mock OpenAI) | `npx vitest run tests/lib/ai-image-generator.test.ts` | Wave 0 |
| AIGEN-04 | hueDrift() < 15 accepted; > 15 rejected; achromatic bypass | unit | `npx vitest run tests/lib/ai-image-generator.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/lib/ai-image-generator.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/lib/ai-image-generator.test.ts` — covers AIGEN-01 through AIGEN-04 (mock `openai` client; no real API calls in tests)
- [ ] `OPENAI_API_KEY` present in `.env` — check and document in Wave 0 setup task

*(Existing test infrastructure covers the framework; only test file is new.)*

---

## Sources

### Primary (HIGH confidence)
- OpenAI Node SDK GitHub README — toFile usage, Buffer handling
- OpenAI model docs (via search result extraction) — gpt-image-1 pricing table, rate limits by tier, supported sizes
- sharp.pixelplumbing.com/api-input/ — stats().dominant verified present, 4096-bin histogram

### Secondary (MEDIUM confidence)
- OpenAI community forum: error-using-gpt-image-1-api-with-quality-parameter — quality param issues on edit endpoint
- OpenAI community forum: image-generation-edit-api-time-out-with-gpt-image-1 — 180s server timeout, latency data
- OpenAI community forum: edit-endpoint-images-edits-refusing-gpt-image-models — unsupported parameter list
- OpenAI community forum: 413-payload-too-large-error — practical ~4MB limit, FormData formatting cause
- OpenAI community forum: creating-multiple-images-in-a-single-api-call-with-gpt-image-1 — n parameter confirmed working

### Tertiary (LOW confidence)
- docs.aimlapi.com/api-references/image-models/openai/gpt-image-1 — pricing/rate limit table (cross-verified with OpenAI model docs)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — openai v6.33.0 is current latest; sharp already in project
- Architecture patterns: MEDIUM-HIGH — toFile pattern verified via cookbook; parameter list verified via community error reports
- Pitfalls: MEDIUM-HIGH — verified via official community bug reports, not just training data
- Pricing/rate limits: MEDIUM — extracted from OpenAI model docs (redirected content); cross-checked against third-party source

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (OpenAI APIs evolve fast; re-verify if parameter behavior changes)

**Key finding not in any existing planning doc:** The `n=3` parameter returns all 3 images in a single API response at `3 × COST_PER_IMAGE` total cost. This means "3 candidates per view" = 1 API call, not 3 calls. The cost for 3 candidates at medium/1024x1024 = $0.126. The "6 calls per view" budget cap (D-06) should be reinterpreted as "2 API calls per view" (initial n=3 + retry n=3) = 6 images total.
