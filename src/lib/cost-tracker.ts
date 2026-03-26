/**
 * CostTracker — in-memory global budget tracking for AI image generation.
 *
 * Enforces a configurable budget cap (default $200 per D-07) across all API calls.
 * Provides dry-run cost estimation per D-08.
 */

import {
  COST_PER_IMAGE,
  CANDIDATES_PER_CALL,
  DEFAULT_BUDGET,
} from './ai-image-types.js';

// Re-export COST_PER_IMAGE for convenience — callers need it for per-call cost math.
export { COST_PER_IMAGE } from './ai-image-types.js';

export class CostTracker {
  private cumulative = 0;
  private readonly budget: number;

  constructor(budgetDollars: number = DEFAULT_BUDGET) {
    this.budget = budgetDollars;
  }

  /**
   * Returns true if the tracker can afford the given cost without exceeding budget.
   * Uses non-strict equality so spending exactly the remaining budget is allowed.
   */
  canAfford(estimatedCost: number): boolean {
    return this.cumulative + estimatedCost <= this.budget;
  }

  /**
   * Records an API call's cost, incrementing the cumulative spend.
   */
  record(cost: number): void {
    this.cumulative += cost;
  }

  /** Total dollars spent so far. */
  get total(): number {
    return this.cumulative;
  }

  /** Dollars remaining in the budget. */
  get remaining(): number {
    return this.budget - this.cumulative;
  }

  /**
   * Cost estimate for a single view API call (n=CANDIDATES_PER_CALL images).
   * At medium/1024x1024: 3 × $0.042 = $0.126 per call.
   */
  estimateViewCost(): number {
    return CANDIDATES_PER_CALL * COST_PER_IMAGE;
  }

  /**
   * Dry-run cost estimation per D-08.
   *
   * Given the number of views that need generation, returns the estimated
   * total cost assuming one API call (n=3) per view. This is the minimum
   * cost — retries are not included (worst case is 2×).
   */
  estimateCost(viewsNeeded: number): number {
    return viewsNeeded * CANDIDATES_PER_CALL * COST_PER_IMAGE;
  }
}
