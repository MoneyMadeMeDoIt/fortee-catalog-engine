# Technology Stack — v2.0 Image Automation Additions

**Project:** Fortee Catalog Engine (v2.0 Image Automation milestone)
**Researched:** 2026-03-26
**Scope:** NEW additions only. Do not re-add what already exists.

---

## Existing Stack (Do NOT Re-add)

These are already in `package.json` and working. The new stack builds on top of them:

| Already Present | Version | Relevant to v2.0 |
|----------------|---------|------------------|
| `sharp` | ^0.34.5 | Core of blur detection and image scoring |
| `cheerio` | ^1.2.0 | Already used in `onesource-client.ts` for SOAP XML parsing |
| `dotenv` | ^17.3.1 | Will hold new API keys (OpenAI, Sightengine) |
| `zod` | ^4.3.6 | Schema-validate AI API responses and image metadata |
| `googleapis` | ^171.4.0 | Write image status back to Google Sheet |
| `p-queue` | — (not in package.json but used) | Rate-limit AI generation calls |
| `@shopify/admin-api-client` | ^1.1.1 | Upload standardized images to Shopify |
| `tsx` | ^4.21.0 | Run new pipeline scripts |
| `winston` | ^3.19.0 | Already in place for pipeline logging |

Note: `p-queue` is used in the codebase but not in `package.json` — confirm it is installed before building new features against it.

---

## New Additions Required

### AI Image Generation

| Package | Version | Purpose | Why |
|---------|---------|---------|-----|
| `openai` | ^6.x (latest 6.33.0) | GPT Image 1.5 generation and editing | Official OpenAI Node.js SDK. Handles multipart form-data for `images.edit()` automatically via `toFile()`. Supports ESM. Dual CJS/ESM build, TypeScript-native. No other option provides equivalent quality for garment view synthesis. |

**Model to use:** `gpt-image-1.5` (current production model, 20% cheaper than `gpt-image-1`).
**Cost baseline:** ~$0.034–$0.063 per generated image at medium quality, 1024×1024. Use `gpt-image-1-mini` at ~$0.005–$0.011 for bulk triage; upgrade to `gpt-image-1.5` for final accepted views.

**API pattern for back/side view generation:**
```typescript
import OpenAI, { toFile } from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Generate a back view from front image
const result = await client.images.edit({
  model: 'gpt-image-1.5',
  image: await toFile(fs.createReadStream(frontImagePath), null, { type: 'image/png' }),
  prompt: 'Generate the back view of this blank garment product on white background. ...',
  size: '1024x1024',
  quality: 'medium',
  response_format: 'b64_json',
});
```

**Known limitations (verified):**
- Model does NOT do pixel-level view rotation — it performs whole-image recreation from prompt + reference
- Latency up to 2 minutes for complex prompts
- No guaranteed geometric consistency between front and generated back (fabric details may drift)
- Hallucination risk: model may invent details not present in the original (e.g. graphics on a blank back)
- Rate limits: enforced per-account; queue all generation calls through `p-queue`

### Image Quality Scoring

**Strategy: implement in-process using `sharp` (already installed) — no new API dependency needed for core scoring.**

`sharp` supports Laplacian convolution directly. The blur detection approach is:
1. Convolve with Laplacian kernel `[0,1,0, 1,-4,1, 0,1,0]` via `sharp().convolve()`
2. Get pixel stats via `sharp().stats()`
3. Calculate variance of the output — low variance = blurry image

This gives blur score with zero external API calls and zero cost.

For brightness/exposure, `sharp().stats()` returns per-channel mean, std, min, max — sufficient to detect underexposed or overexposed images.

**When to use Sightengine instead:**

If the team needs a managed quality API with a single 0–1 score (blur + exposure + noise combined), Sightengine provides this as `quality.score` via a GET request. There is a Node.js client library (`sightengine` npm package). However:
- Minimum paid plan is $29/month
- For a catalog of ~100–500 products, the `sharp`-based approach is sufficient and free
- Sightengine is worth adding only if the team wants to avoid maintaining the Laplacian threshold calibration

**Recommendation:** Use `sharp` for blur/brightness scoring. Add Sightengine only if in-process scoring proves unreliable after testing.

No new npm package required for image quality scoring if using sharp-based approach.

### Image Sourcing — S&S Canada (already available, no new package)

The S&S Activewear V2 REST API already exists in `src/suppliers/ss-canada.ts` and returns these image fields per color:

| Field | Description |
|-------|-------------|
| `colorFrontImage` | Medium front view (`_fm` suffix) |
| `colorBackImage` | Medium back view |
| `colorSideImage` | Medium side view |
| `colorDirectSideImage` | Medium direct side view |
| `colorOnModelFrontImage` | On-model front |
| `colorOnModelBackImage` | On-model back |
| `colorOnModelSideImage` | On-model side |

Full URL: `https://www.ssactivewear.com/{imageField}`. Swap `_fm` → `_fl` for large.

**No new package needed.** Extend `src/suppliers/ss-canada.ts` to extract and return the additional view fields. These are available without any additional API calls — they come back in the existing products endpoint.

### Image Sourcing — Canada Sportswear (OneSource SOAP, already implemented)

`src/lib/onesource-client.ts` already implements `getMediaContent()` via PromoStandards Media Content Service. The `parseMediaContentFromXml()` function returns URLs with `classTypes` that identify front/back/side views.

**No new package needed.** The PromoStandards `classTypeId` values distinguish view types:
- Typically classTypeId 1 = Front, 2 = Back, 3 = Side (verify against live response)
- Parse `classTypes` array in `parseMediaContentFromXml()` result to select view-specific images

### Image Sourcing — OrderMyGear / OneSource

OrderMyGear's OneSource API is the same PromoStandards SOAP endpoint already implemented in `onesource-client.ts`. The `supplierCode` parameter routes to different suppliers. No new library is needed — configure a new `supplierCode` and credentials.

**OneSource API format:** SOAP XML (already handled). REST/JSON versions are planned by OrderMyGear but not yet available as of March 2026. Do NOT add a REST SDK for OneSource — it does not exist yet.

---

## No-Install Notes (What NOT to Add)

| Do Not Add | Reason |
|-----------|--------|
| `axios` or `axios-retry` | Already using native `fetch` throughout. Adding axios creates a mixed HTTP client situation. For retry logic, implement a thin wrapper around `fetch` using a retry loop. |
| `node-soap` / `strong-soap` | OneSource SOAP is already handled by hand-rolled `fetch` + cheerio XML parsing in `onesource-client.ts`. Adding a SOAP library would require rewriting working code. |
| `opencv4nodejs` | Native binding, requires OpenCV system install, complex build chain on Windows/CI. `sharp` convolution covers all needed quality detection without it. |
| `jimp` | Redundant with `sharp`. Much slower (pure JS). Already have sharp. |
| `ssim.js` | Only useful for comparing two images of the same scene. Not needed for quality auditing of supplier images. |
| `playwright` or `puppeteer` | Neither Canada Sportswear nor S&S pages are JavaScript-gated for product data. Both suppliers have structured data endpoints. |
| `sightengine` | External paid API for what `sharp` can do in-process. Add only if sharp-based scoring is validated as insufficient. |
| `replicate` SDK | Replicate hosts gpt-image-1.5 but at higher cost and with an extra vendor dependency. Use OpenAI direct API. |

---

## Installation

```bash
# Only new addition required
npm install openai
```

Everything else is either already installed or implemented using existing dependencies.

---

## Environment Variables to Add

```bash
# .env additions for v2.0
OPENAI_API_KEY=sk-...            # GPT Image generation and editing
# Optional if Sightengine path is chosen:
SIGHTENGINE_API_USER=...
SIGHTENGINE_API_SECRET=...
```

---

## Integration Points with Existing Stack

| New Feature | Integrates With | How |
|-------------|----------------|-----|
| Blur detection | `sharp` (existing) | `sharp().convolve()` + `sharp().stats()` on the existing image buffer flow in `image-standardizer.ts` |
| AI generation | `openai` (new) + `sharp` (existing) | Feed OpenAI output buffer back into `image-standardizer.ts` for standardization (2000×2000 canvas, print area coords) |
| S&S image sourcing | `src/suppliers/ss-canada.ts` (existing) | Extend to return `colorBackImage`, `colorSideImage` fields already in API response |
| OneSource image sourcing | `src/lib/onesource-client.ts` (existing) | `parseMediaContentFromXml()` already returns URLs; add view-type classification by `classTypeId` |
| Sheet status writeback | `googleapis` (existing) | Write image status column (audit pass/fail/generated) using existing Sheets API integration |
| Shopify upload | `@shopify/admin-api-client` (existing) | `image-standardizer.ts` already handles staged uploads |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| OpenAI SDK version | HIGH | Confirmed v6.33.0 on GitHub releases page (March 25, 2026) |
| GPT Image 1.5 pricing | HIGH | Multiple pricing sources agree as of March 2026 |
| S&S API image fields | HIGH | Verified directly from api.ssactivewear.com/V2/Products.aspx |
| OneSource SOAP integration | HIGH | Code already works in production (onesource-client.ts) |
| sharp blur detection via Laplacian | HIGH | Well-documented approach; sharp convolution API confirmed |
| GPT Image view generation accuracy | MEDIUM | Model can generate views but geometric consistency not guaranteed — needs empirical threshold validation |
| OrderMyGear REST API timeline | LOW | Claims "REST/JSON coming" but no release date found |

---

## Sources

- [OpenAI Node.js SDK GitHub releases](https://github.com/openai/openai-node/releases) — v6.33.0 confirmed March 25, 2026 (HIGH)
- [OpenAI Image Generation Docs](https://platform.openai.com/docs/guides/image-generation) — gpt-image-1.5 model, `images.edit()` API (HIGH)
- [GPT Image 1.5 API pricing, March 2026](https://costgoat.com/pricing/openai-images) — $0.034–$0.063 medium quality (HIGH)
- [S&S Activewear API Products endpoint](https://api.ssactivewear.com/V2/Products.aspx) — image field names confirmed (HIGH)
- [Sightengine Image Quality Detection](https://sightengine.com/docs/image-quality-detection) — quality score 0–1, Node.js GET API (MEDIUM)
- [LinkedIn: Pinpointing Blurry Images Node.js Way](https://www.linkedin.com/pulse/pinpointing-blurry-images-simple-nodejs-way-pablo-schaffner-bofill) — sharp Laplacian convolution approach (MEDIUM)
- [OpenAI gpt-image-1.5 Prompting Guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-1.5-prompting_guide) — edit API pattern, garment try-on approach (HIGH)
- [OneSource API Documentation](https://apidocs.distributorcentral.com/docs/onesource-api/b2edb775739e6-one-source-api-documentation) — SOAP format confirmed, REST not yet available (MEDIUM)
- [OrderMyGear OneSource API](https://www.ordermygear.com/onesource-api/) — single integration point for PromoStandards suppliers (MEDIUM)

---

*Stack research for: Fortee Catalog Engine v2.0 Image Automation*
*Researched: 2026-03-26*
