import { describe, it, expect } from 'vitest';
import { getDecorationRulesForCategory, ALL_PLACEMENTS } from '../../src/decoration/rules.js';
import type { GarmentCategory } from '../../src/decoration/types.js';

describe('getDecorationRulesForCategory', () => {
  it('returns Front, Back, and Sleeve placements for T-Shirt', () => {
    const placements = getDecorationRulesForCategory('T-Shirt');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toContain('Front');
    expect(bodyCategories).toContain('Back');
    expect(bodyCategories).toContain('Sleeve');
    expect(bodyCategories).not.toContain('Hoodie');
    expect(bodyCategories).not.toContain('Headwear');
    expect(bodyCategories).not.toContain('Pants');
  });

  it('returns Front, Back, Sleeve, and Hoodie-specific placements for Hoodie', () => {
    const placements = getDecorationRulesForCategory('Hoodie');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toContain('Front');
    expect(bodyCategories).toContain('Back');
    expect(bodyCategories).toContain('Sleeve');
    expect(bodyCategories).toContain('Hoodie');

    const hoodieSpecific = placements.filter((p) => p.bodyCategory === 'Hoodie');
    const names = hoodieSpecific.map((p) => p.placementName);
    expect(names).toContain('Pouch Pocket Center');
  });

  it('returns only Headwear placements for Cap', () => {
    const placements = getDecorationRulesForCategory('Cap');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toEqual(new Set(['Headwear']));

    // Cap should not include beanie-specific placements
    const names = placements.map((p) => p.placementName);
    expect(names.some((n) => n.toLowerCase().includes('cap') || n.toLowerCase().includes('front') || n.toLowerCase().includes('side'))).toBe(true);
  });

  it('returns only Headwear placements for Beanie', () => {
    const placements = getDecorationRulesForCategory('Beanie');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toEqual(new Set(['Headwear']));
  });

  it('returns only Pants placements for Pants', () => {
    const placements = getDecorationRulesForCategory('Pants');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toEqual(new Set(['Pants']));
  });

  it('returns Front, Back, Sleeve for Long Sleeve', () => {
    const placements = getDecorationRulesForCategory('Long Sleeve');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toContain('Front');
    expect(bodyCategories).toContain('Back');
    expect(bodyCategories).toContain('Sleeve');
    expect(bodyCategories).not.toContain('Hoodie');
  });

  it('returns Front, Back, Sleeve for Jacket', () => {
    const placements = getDecorationRulesForCategory('Jacket');
    expect(placements.length).toBeGreaterThan(0);

    const bodyCategories = new Set(placements.map((p) => p.bodyCategory));
    expect(bodyCategories).toContain('Front');
    expect(bodyCategories).toContain('Back');
    expect(bodyCategories).toContain('Sleeve');
  });

  it('returns empty array for unknown category', () => {
    const placements = getDecorationRulesForCategory('unknown' as GarmentCategory);
    expect(placements).toEqual([]);
  });

  it('has exactly 38 total placements across all body categories', () => {
    expect(ALL_PLACEMENTS).toHaveLength(38);
  });
});
