/**
 * Local accounting for YNAB's rate limit.
 *
 * The limit is 200 requests/hour per access token on a rolling window, shared
 * with anything else using the same token - including the user's own YNAB web
 * and mobile sessions, which this process cannot see. No response header
 * reports remaining quota (X-Rate-Limit was removed from 429s in v1.73.0), so
 * counting locally is the only option, and it is a lower bound on real usage.
 */
const RATE_LIMIT = 200;
const WINDOW_MS = 3_600_000; // 1 hour

class ApiUsageTracker {
  private calls: number[] = [];
  private lastRateLimitAt: number | null = null;
  private lastDataLimitAt: number | null = null;

  wrappedFetch: typeof fetch = async (input, init) => {
    // Count before awaiting: a request that reaches YNAB and then fails in
    // transit still consumed quota, and counting after the await would miss it.
    this.calls.push(Date.now());
    this.prune();
    const response = await fetch(input, init);

    if (response.status === 429) this.lastRateLimitAt = Date.now();
    if (response.status === 403) {
      // 403.4 data_limit_reached is a distinct, unquantified abuse-prevention
      // limit; it is not a rate limit and retrying does not clear it. Reading
      // the body would consume the stream the SDK needs, so record the status.
      this.lastDataLimitAt = Date.now();
    }

    // The YNAB SDK assumes error responses are JSON. When the API returns
    // HTML (e.g. rate-limit pages, 502/503 from CDN), the SDK's
    // response.json() call fails. Convert non-JSON errors into a JSON
    // response so the SDK can handle them gracefully.
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const text = await response.text();
        const body = JSON.stringify({
          error: {
            id: String(response.status),
            name: response.statusText || "api_error",
            detail: `YNAB API returned ${response.status}: ${text.slice(0, 200)}`,
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: { "content-type": "application/json" },
        });
      }
    }

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
    const recent = (at: number | null) => (at != null && Date.now() - at < WINDOW_MS ? new Date(at).toISOString() : null);
    const oldestCallAt = this.calls.length > 0 ? new Date(this.calls[0]!).toISOString() : null;
    const windowResetsAt = oldestCallAt
      ? new Date(this.calls[0]! + WINDOW_MS).toISOString()
      : null;
    return {
      used,
      remaining,
      limit: RATE_LIMIT,
      oldestCallAt,
      windowResetsAt,
      lastRateLimitAt: recent(this.lastRateLimitAt),
      lastDataLimitAt: recent(this.lastDataLimitAt),
    };
  }
}

export const apiUsageTracker = new ApiUsageTracker();
