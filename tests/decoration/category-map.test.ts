import { describe, it, expect } from 'vitest';
import { resolveCategory, CATEGORY_ALIASES } from '../../src/decoration/category-map.js';

describe('resolveCategory', () => {
  it('resolves "fleece" to Hoodie', () => {
    expect(resolveCategory('fleece')).toBe('Hoodie');
  });

  it('resolves "t-shirts" to T-Shirt', () => {
    expect(resolveCategory('t-shirts')).toBe('T-Shirt');
  });

  it('resolves "caps & hats" to Cap', () => {
    expect(resolveCategory('caps & hats')).toBe('Cap');
  });

  it('resolves "beanies" to Beanie', () => {
    expect(resolveCategory('beanies')).toBe('Beanie');
  });

  it('resolves "long sleeve" to Long Sleeve', () => {
    expect(resolveCategory('long sleeve')).toBe('Long Sleeve');
  });

  it('resolves "pants" to Pants', () => {
    expect(resolveCategory('pants')).toBe('Pants');
  });

  it('resolves "jackets" to Jacket', () => {
    expect(resolveCategory('jackets')).toBe('Jacket');
  });

  it('returns null for unknown category', () => {
    expect(resolveCategory('totally-unknown')).toBeNull();
  });

  it('handles case-insensitive matching', () => {
    expect(resolveCategory('FLEECE')).toBe('Hoodie');
    expect(resolveCategory('T-Shirts')).toBe('T-Shirt');
    expect(resolveCategory('Caps & Hats')).toBe('Cap');
  });

  it('handles whitespace trimming', () => {
    expect(resolveCategory('  fleece  ')).toBe('Hoodie');
    expect(resolveCategory('  t-shirts ')).toBe('T-Shirt');
  });

  it('resolves all known aliases', () => {
    // Every key in CATEGORY_ALIASES should resolve to a valid GarmentCategory
    for (const [alias, expected] of Object.entries(CATEGORY_ALIASES)) {
      expect(resolveCategory(alias)).toBe(expected);
    }
  });
});
