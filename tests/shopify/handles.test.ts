import { describe, it, expect } from 'vitest';
import { buildHandle } from '../../src/shopify/variants.js';

describe('buildHandle', () => {
  it('produces deterministic output for same inputs', () => {
    const a = buildHandle('Test Product', 'ST100');
    const b = buildHandle('Test Product', 'ST100');
    expect(a).toBe(b);
  });

  it('produces URL-safe handle (lowercase, hyphenated)', () => {
    const handle = buildHandle('Test Product', 'ST100');
    expect(handle).toBe('test-product-st100');
    expect(handle).toMatch(/^[a-z0-9-]+$/);
  });

  it('strips special characters', () => {
    expect(buildHandle('Product Name!@#', 'ABC-123')).toBe('product-name-abc-123');
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
