# Technology Stack: Multi-View Garment Generation

**Project:** Fortee Catalog Engine - Back/Side View Generation for 249 Styles
**Researched:** 2026-03-31

## Recommended Stack

### Core Generation Model
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| OpenAI gpt-image-1.5 | Latest | Primary image generation via `images.edit()` | Drop-in upgrade from current gpt-image-1. 20% cheaper ($0.034 vs $0.042/image at medium quality). 4x faster generation. Better edit fidelity -- preserves composition, lighting, and details across edits. Already integrated via OpenAI SDK. |

### Validation
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| OpenAI gpt-4o-mini | Latest | Post-generation garment-type classification | $0.001/call. Already available through existing OpenAI client. Catches wrong garment type (the biggest quality issue). Used in existing `describeGarment()` function. |
| sharp | Existing | Hue extraction, image resize, quality checks | Already in the pipeline. Used for hue-drift comparison, garment bounds detection, and standardization to 2000x2000. |

### Batch Processing
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| OpenAI Batch API | Latest | 50% cost reduction for bulk generation | Halves token rates. 249 styles x 2 views = ~498 generation requests. Batch API processes within 24 hours. Reduces cost from ~$17-34 to ~$8.50-17 for the full run. |

### Image Sourcing (Pre-AI)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| OneSource PromoStandards | 1.1.0 | Fetch supplier back/side images before AI generation | Already integrated in `image-sourcer.ts`. Free. Real photography beats AI generation when available. |
| S&S Activewear REST API | v2 | Fetch `colorBackImage` and `colorSideImage` fields | Already integrated. Returns actual supplier photos. Should be tried first for every style. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Generation model | gpt-image-1.5 | gpt-image-1 (current) | 20% more expensive, 4x slower, worse edit fidelity. No reason to stay. |
| Generation model | gpt-image-1.5 | FLUX 2 via fal.ai/Replicate | Better photorealism but requires new API integration, different prompting paradigm, no `images.edit()` equivalent -- would need IP-Adapter for reference-based generation. Overkill for 249 styles. |
| Generation model | gpt-image-1.5 | Stable Diffusion + ControlNet + IP-Adapter | Lowest per-image cost ($0.01-0.02) but requires ComfyUI infrastructure, GPU servers, pose templates per garment type. 2-3 weeks engineering. Not justified for 249 styles. |
| Generation model | gpt-image-1.5 | Fashion SaaS (HuHu AI, Uwear AI) | Purpose-built for garments, likely higher quality. But $0.10+/credit, new API integration, webhook handling, vendor dependency. Evaluate if gpt-image-1.5 quality is insufficient. |
| Generation model | gpt-image-1.5 | Midjourney | No API available. Manual-only. Not suitable for automated pipeline. |
| 3D approach | None | Zero123 / SV3D / Wonder3D | Research-only. Designed for rigid objects, struggles with soft fabric. Requires GPU infrastructure. Lower quality output than modern image generation for 2D product photos. |
| Validation | gpt-4o-mini Vision | FashionCLIP (local) | Zero API cost but requires Python runtime + HuggingFace model download. TypeScript project would need Python subprocess or ONNX conversion. gpt-4o-mini is simpler and cheap enough at $0.001/call. |

## Pricing Summary (for 249-style batch)

### Standard API Pricing
| Operation | Cost per unit | Units needed | Total |
|-----------|--------------|-------------|-------|
| gpt-image-1.5 medium edit (1024x1024) | ~$0.034 output + input tokens | 249 styles x 2 views x 3 candidates = 1,494 | ~$51 |
| Retry round (est. 30% retry rate) | ~$0.034 x 3 | ~150 retries | ~$15 |
| gpt-4o-mini validation | ~$0.001 | ~1,494 | ~$1.50 |
| **Total (standard)** | | | **~$67.50** |

### Batch API Pricing (recommended)
| Operation | Cost per unit | Units needed | Total |
|-----------|--------------|-------------|-------|
| gpt-image-1.5 medium edit (batch, 50% off) | ~$0.017 | 1,494 + retries | ~$33 |
| gpt-4o-mini validation | ~$0.001 | ~1,494 | ~$1.50 |
| **Total (batch)** | | | **~$34.50** |

Note: Actual costs will be slightly higher due to input image tokens in edit operations. Budget $50-75 for the full batch with retries. Well within the existing $200 default budget.

## Migration Path (from current gpt-image-1)

```typescript
// In ai-image-generator.ts, callImagesEdit():
// Change:
model: 'gpt-image-1',
// To:
model: 'gpt-image-1.5',

// In ai-image-types.ts:
// Change:
export const COST_PER_IMAGE = 0.042;
// To:
export const COST_PER_IMAGE = 0.034;
```

The API surface is identical. Both models support `images.edit()` with the same parameters. No other code changes needed for the model swap.

## Sources

- [OpenAI API Pricing](https://openai.com/api/pricing/) - Official pricing page
- [GPT Image 1.5 Model Docs](https://platform.openai.com/docs/models/gpt-image-1.5) - Official model documentation
- [GPT Image 1 vs 1.5 Comparison](https://www.aifreeapi.com/en/posts/gpt-image-1-vs-gpt-image-1-5) - Detailed migration guide
- [GPT Image 1.5 Pricing Calculator](https://www.aifreeapi.com/en/posts/gpt-image-1-5-pricing-calculator) - Batch pricing details
- [GPT Image 1.5 Prompting Guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide) - Official prompt engineering
