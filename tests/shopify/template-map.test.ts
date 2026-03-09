import { describe, it, expect } from 'vitest';
import { getTemplateSuffix } from '../../src/shopify/template-map.js';
import { resolveCategory } from '../../src/decoration/category-map.js';

describe('getTemplateSuffix', () => {
  it('returns quick-order for T-Shirt', () => {
    expect(getTemplateSuffix('T-Shirt')).toBe('quick-order');
  });

  it('returns quick-order for Long Sleeve', () => {
    expect(getTemplateSuffix('Long Sleeve')).toBe('quick-order');
  });

  it('returns quick-order for Crewneck', () => {
    expect(getTemplateSuffix('Crewneck')).toBe('quick-order');
  });

  it('returns quick-order for Hoodie', () => {
    expect(getTemplateSuffix('Hoodie')).toBe('quick-order');
  });

  it('returns undefined for Cap (unsupported)', () => {
    expect(getTemplateSuffix('Cap')).toBeUndefined();
  });

  it('returns undefined for Beanie (unsupported)', () => {
    expect(getTemplateSuffix('Beanie')).toBeUndefined();
  });

  it('returns undefined for unknown category', () => {
    expect(getTemplateSuffix('Unknown')).toBeUndefined();
  });
});

describe('resolveCategory - Crewneck', () => {
  it('resolves crewneck to Crewneck', () => {
    expect(resolveCategory('crewneck')).toBe('Crewneck');
  });

  it('resolves crewnecks to Crewneck', () => {
    expect(resolveCategory('crewnecks')).toBe('Crewneck');
  });
});
