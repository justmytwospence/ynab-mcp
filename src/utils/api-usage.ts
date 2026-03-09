const RATE_LIMIT = 200;
const WINDOW_MS = 3_600_000; // 1 hour

class ApiUsageTracker {
  private calls: number[] = [];

  wrappedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    this.calls.push(Date.now());
    this.prune();
    return response;
  };

  private prune() {
    const cutoff = Date.now() - WINDOW_MS;
    this.calls = this.calls.filter((t) => t > cutoff);
  }

  getUsage() {
    this.prune();
    const used = this.calls.length;
    const remaining = Math.max(0, RATE_LIMIT - used);
    const oldestCallAt = this.calls.length > 0 ? new Date(this.calls[0]!).toISOString() : null;
    const windowResetsAt = oldestCallAt
      ? new Date(this.calls[0]! + WINDOW_MS).toISOString()
      : null;
    return { used, remaining, limit: RATE_LIMIT, oldestCallAt, windowResetsAt };
  }
}

export const apiUsageTracker = new ApiUsageTracker();
