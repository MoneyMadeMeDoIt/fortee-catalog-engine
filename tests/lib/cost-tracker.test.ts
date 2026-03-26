import { describe, it, expect } from 'vitest';
import { CostTracker, COST_PER_IMAGE } from '../../src/lib/cost-tracker.js';
import { CANDIDATES_PER_CALL } from '../../src/lib/ai-image-types.js';

// ---------------------------------------------------------------------------
// COST_PER_IMAGE export
// ---------------------------------------------------------------------------

describe('COST_PER_IMAGE', () => {
  it('is $0.042 (medium quality, 1024x1024)', () => {
    expect(COST_PER_IMAGE).toBe(0.042);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — canAfford
// ---------------------------------------------------------------------------

describe('CostTracker.canAfford', () => {
  it('returns true when budget is sufficient for a single view', () => {
    const tracker = new CostTracker(200);
    expect(tracker.canAfford(0.126)).toBe(true);
  });

  it('returns false when cost exceeds budget', () => {
    const tracker = new CostTracker(0.10);
    expect(tracker.canAfford(0.126)).toBe(false);
  });

  it('returns true when cost exactly equals remaining budget', () => {
    const tracker = new CostTracker(0.126);
    expect(tracker.canAfford(0.126)).toBe(true);
  });

  it('returns false after cumulative spend exhausts budget', () => {
    const tracker = new CostTracker(0.20);
    tracker.record(0.126);
    expect(tracker.canAfford(0.126)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — record / total / remaining
// ---------------------------------------------------------------------------

describe('CostTracker.record', () => {
  it('increments total correctly after one record', () => {
    const tracker = new CostTracker(200);
    tracker.record(0.126);
    expect(tracker.total).toBeCloseTo(0.126, 10);
  });

  it('increments total correctly after multiple records', () => {
    const tracker = new CostTracker(200);
    tracker.record(0.126);
    tracker.record(0.126);
    expect(tracker.total).toBeCloseTo(0.252, 10);
  });

  it('decrements remaining after record', () => {
    const tracker = new CostTracker(1.00);
    tracker.record(0.126);
    expect(tracker.remaining).toBeCloseTo(0.874, 10);
  });

  it('starts at total=0 and remaining=budget', () => {
    const tracker = new CostTracker(200);
    expect(tracker.total).toBe(0);
    expect(tracker.remaining).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — estimateViewCost
// ---------------------------------------------------------------------------

describe('CostTracker.estimateViewCost', () => {
  it('returns CANDIDATES_PER_CALL * COST_PER_IMAGE per view', () => {
    const tracker = new CostTracker(200);
    const expected = CANDIDATES_PER_CALL * COST_PER_IMAGE;
    expect(tracker.estimateViewCost()).toBeCloseTo(expected, 10);
  });

  it('equals 0.126 (3 candidates × $0.042)', () => {
    const tracker = new CostTracker(200);
    expect(tracker.estimateViewCost()).toBeCloseTo(0.126, 5);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — estimateCost (D-08 dry-run)
// ---------------------------------------------------------------------------

describe('CostTracker.estimateCost', () => {
  it('returns 0 for 0 views', () => {
    const tracker = new CostTracker(200);
    expect(tracker.estimateCost(0)).toBe(0);
  });

  it('returns 0.378 for 3 views (3 × 3 × $0.042)', () => {
    const tracker = new CostTracker(200);
    expect(tracker.estimateCost(3)).toBeCloseTo(0.378, 5);
  });

  it('is proportional: 6 views costs twice as much as 3 views', () => {
    const tracker = new CostTracker(200);
    expect(tracker.estimateCost(6)).toBeCloseTo(tracker.estimateCost(3) * 2, 10);
  });

  it('equals viewsNeeded * CANDIDATES_PER_CALL * COST_PER_IMAGE', () => {
    const tracker = new CostTracker(200);
    const viewsNeeded = 5;
    const expected = viewsNeeded * CANDIDATES_PER_CALL * COST_PER_IMAGE;
    expect(tracker.estimateCost(viewsNeeded)).toBeCloseTo(expected, 10);
  });
});
