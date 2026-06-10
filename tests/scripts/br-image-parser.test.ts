/**
 * Regression suite for scripts/lib/br-image-parser.ts — Phase 18-01.
 *
 * Covers:
 *   - Q-Tees/H08050 brand-leak regression (IMG-03 / D-07): hyphenated brand must
 *     never bleed its tokens into the parsed color.
 *   - American Apparel, Bella+Canvas, Gildan — standard multi-word brand + color
 *     combinations.
 *   - All 7 canonical roles (Front, Back, LeftSide, RightSide, ModelFront,
 *     ModelBack, ModelSide).
 *   - Role anchoring: color containing a role-word substring still parses correctly.
 *   - Null-return cases: wrong extension, lowercase role, missing role, pid mismatch.
 *   - normalizeColor: underscore and space collapse; Grey ≠ Gray preserved.
 *   - ROLE_TO_COLUMN: all 7 entries, including LeftSide→DirectSideImage.
 *   - CANONICAL_ROLES: exactly 7 elements.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCanonicalFilename,
  normalizeColor,
  ROLE_TO_COLUMN,
  CANONICAL_ROLES,
} from '../../scripts/lib/br-image-parser.js';

// ─── parseCanonicalFilename ────────────────────────────────────────────────

describe('parseCanonicalFilename — valid filenames', () => {
  it('Q-Tees H08050 Forest_Green Front — no brand-token leak (IMG-03 regression)', () => {
    const result = parseCanonicalFilename('Q-Tees-H08050-Forest_Green-Front.png', 'H08050');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Forest Green');
    expect(result!.role).toBe('Front');
    // Explicit absence of brand tokens — the brand-leak guard
    expect(result!.color.toLowerCase()).not.toContain('q');
    expect(result!.color.toLowerCase()).not.toContain('tees');
  });

  it('American_Apparel BB001 Navy_Blue Front', () => {
    const result = parseCanonicalFilename('American_Apparel-BB001-Navy_Blue-Front.png', 'BB001');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Navy Blue');
    expect(result!.role).toBe('Front');
  });

  it('Bella_Canvas 3001 Black LeftSide', () => {
    const result = parseCanonicalFilename('Bella_Canvas-3001-Black-LeftSide.png', '3001');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Black');
    expect(result!.role).toBe('LeftSide');
  });

  it('Gildan 5000 Heather_Grey ModelFront', () => {
    const result = parseCanonicalFilename('Gildan-5000-Heather_Grey-ModelFront.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Heather Grey');
    expect(result!.role).toBe('ModelFront');
  });

  it('Back role', () => {
    const result = parseCanonicalFilename('Gildan-5000-Black-Back.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Black');
    expect(result!.role).toBe('Back');
  });

  it('RightSide role', () => {
    const result = parseCanonicalFilename('Gildan-5000-Red-RightSide.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Red');
    expect(result!.role).toBe('RightSide');
  });

  it('ModelBack role', () => {
    const result = parseCanonicalFilename('Gildan-5000-White-ModelBack.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('White');
    expect(result!.role).toBe('ModelBack');
  });

  it('ModelSide role', () => {
    const result = parseCanonicalFilename('Gildan-5000-White-ModelSide.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('White');
    expect(result!.role).toBe('ModelSide');
  });

  it('color containing a role-word substring is parsed correctly (role anchored at end)', () => {
    // "Sideshow_Silver" contains "Side" — role is anchored at the trailing `-Role.png`, not mid-string
    const result = parseCanonicalFilename('Gildan-5000-Sideshow_Silver-Front.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Sideshow Silver');
    expect(result!.role).toBe('Front');
  });

  it('multi-word color with underscore separator', () => {
    const result = parseCanonicalFilename('Gildan-5000-Dark_Heather_Green-Back.png', '5000');
    expect(result).not.toBeNull();
    expect(result!.color).toBe('Dark Heather Green');
    expect(result!.role).toBe('Back');
  });
});

describe('parseCanonicalFilename — null cases', () => {
  it('lowercase role token → null (case-sensitive role matching)', () => {
    const result = parseCanonicalFilename('Gildan-5000-Black-front.png', '5000');
    expect(result).toBeNull();
  });

  it('wrong extension (.jpg) → null', () => {
    const result = parseCanonicalFilename('5000-Black-front.jpg', '5000');
    expect(result).toBeNull();
  });

  it('no role token → null', () => {
    const result = parseCanonicalFilename('Gildan-5000-Black.png', '5000');
    expect(result).toBeNull();
  });

  it('pid mismatch → null (sanity guard)', () => {
    // Name contains pid "5000" but caller passes "9999"
    const result = parseCanonicalFilename('Gildan-5000-Black-Front.png', '9999');
    expect(result).toBeNull();
  });

  it('non-canonical role token → null', () => {
    const result = parseCanonicalFilename('Gildan-5000-Black-Profile.png', '5000');
    expect(result).toBeNull();
  });

  it('empty string → null', () => {
    expect(parseCanonicalFilename('', '5000')).toBeNull();
  });
});

// ─── normalizeColor ────────────────────────────────────────────────────────

describe('normalizeColor', () => {
  it('Navy_Blue (underscore) and Navy Blue (space) produce same normalized form', () => {
    expect(normalizeColor('Navy_Blue')).toBe('navyblue');
    expect(normalizeColor('Navy Blue')).toBe('navyblue');
    // They must match each other
    expect(normalizeColor('Navy_Blue')).toBe(normalizeColor('Navy Blue'));
  });

  it('Heather Grey and Heather Gray normalize to DIFFERENT strings (miss, never collapse)', () => {
    expect(normalizeColor('Heather Grey')).toBe('heathergrey');
    expect(normalizeColor('Heather Gray')).toBe('heathergray');
    expect(normalizeColor('Heather Grey')).not.toBe(normalizeColor('Heather Gray'));
  });

  it('strips all non-alphanumeric characters', () => {
    expect(normalizeColor('Dark-Heather/Blue')).toBe('darkheatherblue');
  });

  it('lowercases all characters', () => {
    expect(normalizeColor('ForestGreen')).toBe('forestgreen');
  });
});

// ─── ROLE_TO_COLUMN ────────────────────────────────────────────────────────

describe('ROLE_TO_COLUMN', () => {
  it('Front → FrontImage', () => {
    expect(ROLE_TO_COLUMN['Front']).toBe('FrontImage');
  });

  it('Back → BackImage', () => {
    expect(ROLE_TO_COLUMN['Back']).toBe('BackImage');
  });

  it('LeftSide → DirectSideImage (D-04)', () => {
    expect(ROLE_TO_COLUMN['LeftSide']).toBe('DirectSideImage');
  });

  it('RightSide → RightSide', () => {
    expect(ROLE_TO_COLUMN['RightSide']).toBe('RightSide');
  });

  it('ModelFront → ModelFront', () => {
    expect(ROLE_TO_COLUMN['ModelFront']).toBe('ModelFront');
  });

  it('ModelSide → ModelSide', () => {
    expect(ROLE_TO_COLUMN['ModelSide']).toBe('ModelSide');
  });

  it('ModelBack → ModelBack', () => {
    expect(ROLE_TO_COLUMN['ModelBack']).toBe('ModelBack');
  });
});

// ─── CANONICAL_ROLES ──────────────────────────────────────────────────────

describe('CANONICAL_ROLES', () => {
  it('has exactly 7 role tokens', () => {
    expect(CANONICAL_ROLES).toHaveLength(7);
  });

  it('contains all required role tokens', () => {
    expect(CANONICAL_ROLES).toContain('Front');
    expect(CANONICAL_ROLES).toContain('Back');
    expect(CANONICAL_ROLES).toContain('LeftSide');
    expect(CANONICAL_ROLES).toContain('RightSide');
    expect(CANONICAL_ROLES).toContain('ModelFront');
    expect(CANONICAL_ROLES).toContain('ModelBack');
    expect(CANONICAL_ROLES).toContain('ModelSide');
  });
});
