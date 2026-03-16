const RATE_LIMIT = 200;
const WINDOW_MS = 3_600_000; // 1 hour

class ApiUsageTracker {
  private calls: number[] = [];

  wrappedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    this.calls.push(Date.now());
    this.prune();

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
    const oldestCallAt = this.calls.length > 0 ? new Date(this.calls[0]!).toISOString() : null;
    const windowResetsAt = oldestCallAt
      ? new Date(this.calls[0]! + WINDOW_MS).toISOString()
      : null;
    return { used, remaining, limit: RATE_LIMIT, oldestCallAt, windowResetsAt };
  }
}

export const apiUsageTracker = new ApiUsageTracker();
