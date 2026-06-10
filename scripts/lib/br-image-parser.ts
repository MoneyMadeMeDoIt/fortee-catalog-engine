/**
 * Pure, side-effect-free canonical Drive filename parser + color normalizer +
 * role→column mapping for the Drive→BR image linker (Phase 18).
 *
 * Canonical filename format (built by finalize-bestsellers-drive.ts):
 *   {Brand}-{pid}-{Color}-{Role}.png
 *
 *   - Brand  : Title_Case_With_Underscores (multi-word brands use `_`, e.g. American_Apparel).
 *              Hyphenated brand names (Q-Tees, J-America) preserve their `-` — that is the
 *              source of the brand-leak risk: a naive split('/[-_]/') on "Q-Tees-H08050-..."
 *              yields ["Q", "Tees", "H08050", ...] and lets "Q"/"Tees" bleed into color.
 *   - pid    : exact case, e.g. H08050, BB001, 3001, 5000
 *   - Color  : Title_Case_With_Underscores, e.g. Forest_Green, Navy_Blue
 *   - Role   : one of the 7 CANONICAL_ROLES tokens (case-sensitive)
 *
 * Parser strategy (pid-anchored + role-anchored — D-07):
 *   1. Strip `.png` suffix (required).
 *   2. Require the name ends with `-<Role>` where Role ∈ CANONICAL_ROLES (case-sensitive, `$`-anchored).
 *   3. Require the name contains the exact substring `-<pid>-` (pid boundaries guarded by `-`).
 *   4. Take the color as the substring strictly between the end of `-<pid>-` and the start of
 *      `-<Role>` suffix — no splitting on every `-` or `_`.
 *   5. Convert internal `_` → space.
 *   6. Return null for any non-canonical or malformed input (fail-closed, IMG-03).
 */

// ─── Role types ───────────────────────────────────────────────────────────

/** All valid role tokens produced by the finalize-bestsellers-drive pipeline. */
export const CANONICAL_ROLES = [
  'Front',
  'Back',
  'LeftSide',
  'RightSide',
  'ModelFront',
  'ModelBack',
  'ModelSide',
] as const;

export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

// ─── Role → BR column mapping ─────────────────────────────────────────────

/**
 * Maps each Drive role token to its corresponding BR sheet column header.
 *
 * D-02: Front   → FrontImage
 * D-03: Back    → BackImage
 * D-04: LeftSide → DirectSideImage  (no separate LeftSide column exists in BR)
 * D-05: RightSide, ModelFront, ModelSide, ModelBack → new columns of the same name
 */
export const ROLE_TO_COLUMN: Record<CanonicalRole, string> = {
  Front: 'FrontImage',
  Back: 'BackImage',
  LeftSide: 'DirectSideImage',
  RightSide: 'RightSide',
  ModelFront: 'ModelFront',
  ModelSide: 'ModelSide',
  ModelBack: 'ModelBack',
};

// ─── Color normalization ──────────────────────────────────────────────────

/**
 * Normalizes a color string to a lowercase alphanumeric key for join comparison.
 *
 * Copied verbatim from scripts/link-drive-images.ts line 68 (safe, no brand-leak risk).
 *
 * Grey and Gray normalize to DIFFERENT strings — this is intentional.
 * A spelling mismatch is a miss, never a wrong match (D-01 / T-18-02).
 *
 * @example
 *   normalizeColor("Navy_Blue")   // "navyblue"
 *   normalizeColor("Navy Blue")   // "navyblue"  (same — matches)
 *   normalizeColor("Heather Grey") // "heathergrey"
 *   normalizeColor("Heather Gray") // "heathergray"  (different — miss)
 */
export function normalizeColor(c: string): string {
  return c.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Canonical filename parser ────────────────────────────────────────────

/** Result returned by parseCanonicalFilename on success. */
export interface ParsedFilename {
  /** Color with internal underscores replaced by spaces, e.g. "Forest Green". */
  color: string;
  /** One of the 7 CANONICAL_ROLES tokens. */
  role: CanonicalRole;
}

/**
 * Pid-anchored + role-anchored Drive filename parser (D-07).
 *
 * Parses a canonical `{Brand}-{pid}-{Color}-{Role}.png` filename into its
 * color and role components, using the pid and role as anchors so that
 * hyphenated brand names (e.g. Q-Tees) can never contaminate the color token.
 *
 * @param name - The Drive filename including the `.png` extension.
 * @param pid  - The product ID expected in the filename (e.g. "H08050").
 * @returns Parsed color and role, or null if the filename is non-canonical.
 */
export function parseCanonicalFilename(name: string, pid: string): ParsedFilename | null {
  if (!name || !pid) return null;

  // 1. Require .png extension (case-sensitive per the builder)
  if (!name.endsWith('.png')) return null;
  const withoutExt = name.slice(0, -4); // remove ".png"

  // 2. Build a regex anchored at the end that matches `-<Role>` for any canonical role.
  //    Roles are sorted longest-first to avoid prefix shadowing (e.g. "ModelFront" before "Front"),
  //    though in this set there is no ambiguity since all multi-word roles are distinct.
  //    The regex is case-sensitive — "front" (lowercase) must NOT match.
  const rolePattern = CANONICAL_ROLES
    .slice() // avoid mutating the const
    .sort((a, b) => b.length - a.length)
    .join('|');
  const roleRegex = new RegExp(`-(${rolePattern})$`);

  const roleMatch = withoutExt.match(roleRegex);
  if (!roleMatch) return null;

  const role = roleMatch[1] as CanonicalRole;
  // Remove the trailing `-<Role>` from the working string
  const withoutRole = withoutExt.slice(0, withoutExt.length - roleMatch[0].length);

  // 3. Require the exact substring `-<pid>-` exists in the remainder.
  //    We search from the right (lastIndexOf) in case the pid also appears in the brand,
  //    but realistically pids are unique enough that indexOf also works; lastIndexOf is safer.
  const pidMarker = `-${pid}-`;
  const pidIdx = withoutRole.lastIndexOf(pidMarker);
  if (pidIdx === -1) return null;

  // 4. Color is the substring strictly after the pid marker.
  const rawColor = withoutRole.slice(pidIdx + pidMarker.length);

  // Reject if color segment is empty
  if (!rawColor) return null;

  // 5. Convert internal `_` to spaces.
  const color = rawColor.replace(/_/g, ' ');

  return { color, role };
}
