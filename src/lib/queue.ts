import PQueue from 'p-queue';

export interface RateLimitOptions {
  intervalCap?: number;
  interval?: number;
}

export function createRateLimitedQueue(options?: RateLimitOptions): PQueue {
  return new PQueue({
    intervalCap: options?.intervalCap ?? 55,
    interval: options?.interval ?? 60_000,
    carryoverConcurrencyCount: true,
  });
}
