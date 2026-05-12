/**
 * Phase 16: Same-specific-product Vision verifier.
 *
 * Sibling to Phase 15's `verifyGarmentTypeMatch` (src/lib/ai-image-generator.ts:
 * 129-181). Pattern is intentionally copied verbatim — same OpenAI client
 * signature, same gpt-4o-mini model, same JSON-mode response, same
 * `detail: 'low'`, same false-accept-on-error fallback. The differences are:
 *
 *   1. System prompt — Phase 16 asks "are these the SAME SPECIFIC PRODUCT"
 *      (cut, brand details, fabric texture, logo placement) while Phase 15 asks
 *      "are these the SAME GARMENT FAMILY" (crewneck vs hoodie). Color is
 *      explicitly color-blind in this verifier (different colors = SAME).
 *
 *   2. Prompt order — CANDIDATE first, REFERENCE second. Phase 15 puts the
 *      reference (source front) first because the generated candidate is the
 *      thing being judged against a known truth. Phase 16's mental model is
 *      different: the BR image is the thing being audited, the supplier
 *      canonical is the truth — so the audited thing leads.
 *
 *   3. Logger prefix — `[verify-same-product]` (vs `[ai-image-generator]`).
 *
 * Error policy (T-16-02 — false-accept-on-error): on Vision API errors or
 * JSON-parse failures, return `{ match: true, reason: 'verifier ... fallback' }`
 * — NEVER false-reject when the verifier itself broke. Cost of a false-accept
 * is one wrong image staying one more cycle; cost of a false-reject would be
 * blocking legitimate fixes from completing.
 */

import type OpenAI from 'openai';
import { logger } from './logger.js';

/** Result from `verifySameProduct()`. */
export interface VerifySameProductResult {
  match: boolean;
  reason: string;
}

/**
 * System prompt — verbatim per 16-RESEARCH.md lines 429-452.
 *
 * The "color may differ → SAME PRODUCT" clause is the deliberate color-blind
 * default (per CONTEXT Claude's Discretion). A navy hoodie and a black hoodie
 * of the same Bella+Canvas style 6110 are the SAME PRODUCT.
 *
 * Do NOT downcase or modify this string between Plan 01 and Plan 02 — the
 * verbatim wording is what supports the color-blind discretion + same-specific-
 * product semantics that downstream test expectations depend on.
 */
export const SAME_PRODUCT_SYSTEM_PROMPT = `You are comparing two product photos of garments on white backgrounds.
The FIRST image is a CANDIDATE (the image we're auditing).
The SECOND image is a REFERENCE (the canonical supplier photo of what the product SHOULD look like).

Decide whether both photos depict the SAME SPECIFIC PRODUCT — same garment style, same cut, same brand details (collar, hem, sleeve detail, fabric texture, logo placement if visible). They MAY differ in:
- Color (a navy hoodie and a black hoodie of the same style = SAME PRODUCT)
- Photo angle (slightly different framing = SAME PRODUCT)
- Lighting / exposure (= SAME PRODUCT)
- Model wearing it vs. flat lay (= SAME PRODUCT, but only if the garment itself matches)

They are DIFFERENT PRODUCTS if:
- The garment SHAPE differs (hoodie vs crewneck, polo vs t-shirt, etc.)
- The brand is visibly different (Adidas hoodie vs Gildan hoodie = different products even if both pullovers)
- Cut/fit family differs (oversized vs slim fit if visible)
- Decoration is intrinsic (printed logo, embroidery) and only appears on one

Respond with ONLY a JSON object on a single line:
{"match": true|false, "reason": "<short phrase, max 80 chars>"}

Examples:
- "same Bella+Canvas 6110 t-shirt, different color" → match=true
- "candidate is Gildan hoodie, reference is Adidas hoodie" → match=false
- "candidate is baby onesie, reference is adult t-shirt" → match=false
- "same crewneck sweatshirt, candidate has model wearing it" → match=true`;

/**
 * Verify that two product photos depict the same specific product.
 *
 * Used by Phase 16 Pass 2 (content-mismatch detection) and Tier 1
 * verifier-after-fix (gate before a supplier-canonical image is written back
 * to BR). The candidate is the BR image being audited; the reference is the
 * supplier canonical pulled fresh from S&S / CSW.
 *
 * Error policy: false-accept-on-error per T-16-02. Vision API failure, parse
 * failure, and empty content all return `{ match: true, reason: 'verifier ...
 * fallback' }`. The audit/fix pipeline must NEVER false-reject a legitimate
 * fix because the verifier itself crashed.
 *
 * @param client OpenAI client (DI seam for tests).
 * @param candidateBuffer The BR image being audited.
 * @param referenceBuffer The supplier canonical reference image.
 * @returns `{ match, reason }` where match=true means same specific product.
 */
export async function verifySameProduct(
  client: OpenAI,
  candidateBuffer: Buffer,
  referenceBuffer: Buffer,
): Promise<VerifySameProductResult> {
  try {
    const candidateB64 = candidateBuffer.toString('base64');
    const referenceB64 = referenceBuffer.toString('base64');

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SAME_PRODUCT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Candidate (BR image being audited):' },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${candidateB64}`,
                detail: 'low',
              },
            },
            { type: 'text', text: 'Reference (supplier canonical):' },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${referenceB64}`,
                detail: 'low',
              },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';

    // First try direct JSON.parse; on failure, regex-extract a {...} block.
    let parsed: { match?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m === null) {
        logger.warn(
          `[verify-same-product] parse failed (no JSON object found in: ${raw.slice(0, 100)})`,
        );
        return { match: true, reason: 'verifier parse error fallback' };
      }
      // If the regex-extracted block is itself unparseable, the throw falls
      // through to the outer catch which returns the api-error fallback shape.
      parsed = JSON.parse(m[0]);
    }

    return {
      match: parsed.match === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    };
  } catch (err) {
    logger.warn(`[verify-same-product] verifySameProduct failed: ${err}`);
    return { match: true, reason: 'verifier api error fallback' };
  }
}
