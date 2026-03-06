import { describe, it, expect } from 'vitest';
import { buildHandle } from '../../src/shopify/variants.js';

describe('buildHandle', () => {
  it('produces lowercase hyphenated handle from name and styleID', () => {
    expect(buildHandle('Gildan Heavy Cotton', 'ST550')).toBe('gildan-heavy-cotton-st550');
  });

  it('strips special characters', () => {
    expect(buildHandle('Product Name!@#', 'ABC-123')).toBe('product-name-abc-123');
  });

  it('is deterministic (same inputs always return same output)', () => {
    const a = buildHandle('Test Product', 'XYZ-99');
    const b = buildHandle('Test Product', 'XYZ-99');
    expect(a).toBe(b);
  });

  it('deduplicates consecutive hyphens', () => {
    expect(buildHandle('Multi   Space', 'ID--1')).toBe('multi-space-id-1');
  });

  it('trims leading and trailing hyphens', () => {
    expect(buildHandle('  Leading ', ' Trailing  ')).toBe('leading-trailing');
  });

  it('handles empty productName', () => {
    expect(buildHandle('', 'STYLE1')).toBe('style1');
  });

  it('handles empty styleID', () => {
    expect(buildHandle('Product', '')).toBe('product');
  });
});
