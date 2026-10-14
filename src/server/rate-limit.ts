/** In-memory sliding-window limiter, keyed by client address. Resets when the server restarts. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true if the key is still within its allowance. */
  take(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const recent = this.hits.get(key) ?? [];
    if (recent.length >= this.limit) return false;
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Drops expired timestamps so idle clients do not accumulate forever. */
  private sweep(t: number): void {
    for (const [key, times] of this.hits) {
      const live = times.filter((time) => t - time < this.windowMs);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}
