import { describe, it, expect } from 'vitest';
import { getTemplateSuffix } from '../../src/shopify/template-map.js';

describe('getTemplateSuffix', () => {
  it('maps T-Shirt to t-shirt', () => {
    expect(getTemplateSuffix('T-Shirt')).toBe('t-shirt');
  });

  it('maps Hoodie to hoodie', () => {
    expect(getTemplateSuffix('Hoodie')).toBe('hoodie');
  });

  it('maps Cap to cap', () => {
    expect(getTemplateSuffix('Cap')).toBe('cap');
  });

  it('maps Beanie to beanie', () => {
    expect(getTemplateSuffix('Beanie')).toBe('beanie');
  });

  it('maps Pants to pants', () => {
    expect(getTemplateSuffix('Pants')).toBe('pants');
  });

  it('maps Long Sleeve to long-sleeve', () => {
    expect(getTemplateSuffix('Long Sleeve')).toBe('long-sleeve');
  });

  it('maps Jacket to jacket', () => {
    expect(getTemplateSuffix('Jacket')).toBe('jacket');
  });

  it('returns undefined for unknown category', () => {
    expect(getTemplateSuffix('Unknown')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getTemplateSuffix('')).toBeUndefined();
  });
});
