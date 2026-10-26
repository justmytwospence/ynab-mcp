import { AsyncLocalStorage } from "node:async_hooks";
import { recordAttempt } from "./operation.js";

const RATE_LIMIT = 200;
const WINDOW_MS = 3_600_000;
const MAX_BACKOFF_MS = 5000;
const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();

interface Options {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
}

/** Local attempted-request accounting, NOT authoritative upstream remaining quota.
 * Other processes/clients using this access token are invisible. YNAB's own
 * web/mobile sessions do not necessarily use this token; do not count them.
 */
export class ApiUsageTracker {
  private calls: number[] = [];
  private reserved = 0;
  private leases = new AsyncLocalStorage<{ remaining: number }>();
  private active = 0;
  private queue: Array<() => void> = [];
  private lastRateLimitAt: number | null = null;
  private lastDataLimitAt: number | null = null;
  private lastResponseAt: number | null = null;
  private cooldownUntil: number | null = null;
  private cooldownSource: "retry-after" | "local-backoff" | null = null;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private transport: typeof fetch;
  private concurrency: number;

  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    // Resolve global fetch at call time so offline transports can replace it.
    this.transport = options.fetch ?? ((input, init) => fetch(input, init));
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16) throw new Error("Invalid concurrency");
  }

  private prune() { this.calls = this.calls.filter(t => t > this.now() - WINDOW_MS); }

  assertAvailable(cost: number) {
    if (!Number.isInteger(cost) || cost < 0) throw new Error("Invalid estimated request cost");
    this.prune();
    const own = this.leases.getStore()?.remaining ?? 0;
    if (cost > 0 && this.cooldownUntil !== null && this.cooldownUntil > this.now()) {
      throw new Error(`YNAB cooldown until ${iso(this.cooldownUntil)} (${this.cooldownSource}); no request sent.`);
    }
    if (cost > Math.max(0, RATE_LIMIT - this.calls.length - this.reserved + own)) {
      throw new Error(`Local estimated YNAB budget cannot cover ${cost} request(s). Check get_api_usage for the next available slot; no new request sent.`);
    }
  }

  /** Reserve an entire known-cost phase before starting it. Not a provider quota guarantee. */
  async withBudget<T>(cost: number, fn: () => Promise<T>): Promise<T> {
    this.assertAvailable(cost);
    if (this.leases.getStore()) {
      if (this.leases.getStore()!.remaining < cost) throw new Error("Operation reservation cannot cover this phase");
      return fn();
    }
    this.reserved += cost;
    const lease = { remaining: cost };
    try { return await this.leases.run(lease, fn); }
    finally { this.reserved -= lease.remaining; lease.remaining = 0; }
  }

  private async acquire() {
    if (this.active < this.concurrency) { this.active++; return; }
    if (this.queue.length >= 64) throw new Error("YNAB local request queue full; no request sent");
    await new Promise<void>(resolve => this.queue.push(resolve));
  }
  private release() {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }

  wrappedFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    for (let attempt = 0; ; attempt++) {
      await this.acquire();
      let response: Response;
      try {
        this.assertAvailable(1);
        const lease = this.leases.getStore();
        if (lease && lease.remaining > 0) { lease.remaining--; this.reserved--; }
        this.calls.push(this.now());
        recordAttempt(method); // Every real attempt, including failed transport and flag follow-ups.
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        response = await this.transport(input, {
          ...init,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
        });
        this.lastResponseAt = this.now();
        if (response.status === 429) {
          this.lastRateLimitAt = this.now();
          const delay = retryAfterMs(response.headers.get("retry-after"), this.now());
          const until = this.now() + (delay ?? 60000);
          if (until >= (this.cooldownUntil ?? 0)) {
            this.cooldownUntil = until;
            this.cooldownSource = delay === null ? "local-backoff" : "retry-after";
          }
        }
        // Hold the permit through body transfer, not merely until response headers.
        // This also makes the timeout cover SDK JSON reads and avoids unbounded
        // concurrent export streams after fetch() resolves.
        const body = await response.arrayBuffer();
        response = new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
        if (response.status === 403) {
          // Inspect a clone: unrelated permission failures are not 403.4 data limits.
          const body = await response.clone().json().catch(() => null);
          if (body?.error?.id === "403.4") this.lastDataLimitAt = this.now();
        }
        if (!response.ok && !(response.headers.get("content-type") ?? "").includes("json")) {
          const body = JSON.stringify({ error: {
            id: String(response.status), name: response.statusText || "api_error",
            detail: `YNAB API returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
          } });
          response = new Response(body, { status: response.status, statusText: response.statusText,
            headers: { "content-type": "application/json", ...(response.headers.has("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {}) } });
        }
      } finally { this.release(); }
      // Only GET/HEAD, only one retry, never a network/timeout or ambiguous mutation replay.
      const retryable = ["GET", "HEAD"].includes(method) && attempt === 0 && [429, 500, 502].includes(response.status);
      if (!retryable) return response;
      const delay = response.status === 429 ? Math.max(0, this.cooldownUntil! - this.now())
        : retryAfterMs(response.headers.get("retry-after"), this.now()) ?? 500;
      if (delay > MAX_BACKOFF_MS) return response;
      await response.body?.cancel();
      await this.sleep(delay);
    }
  };

  getUsage() {
    this.prune();
    const used = this.calls.length;
    const remaining = Math.max(0, RATE_LIMIT - used);
    const firstExpires = this.calls.length ? this.calls[0]! + WINDOW_MS : null;
    const cooldown = this.cooldownUntil !== null && this.cooldownUntil > this.now() ? this.cooldownUntil : null;
    return {
      observedAt: iso(this.now())!, accounting: "local-estimate", scope: "this process / shared access token",
      used, remaining, limit: RATE_LIMIT, reserved: this.reserved,
      available: Math.max(0, remaining - this.reserved),
      oldestCallAt: iso(this.calls[0] ?? null),
      // Compatibility field: first observed expiry, NOT a full-window reset.
      windowResetsAt: iso(firstExpires),
      nextAvailableSlotAt: remaining > 0 && this.reserved >= remaining ? null
        : iso(Math.max(this.now(), cooldown ?? 0, remaining === 0 ? firstExpires ?? 0 : 0)),
      nextAvailableSlotReason: remaining > 0 && this.reserved >= remaining ? "Waiting for in-flight reservations; release time unknown"
        : cooldown ? "Upstream response cooldown" : remaining === 0 ? "Next observed request expiry" : "Local slot available (upstream quota unknown)",
      allObservedCallsExpireAt: iso(this.calls.length ? this.calls[this.calls.length - 1]! + WINDOW_MS : null),
      lastResponseAt: iso(this.lastResponseAt), lastRateLimitAt: iso(this.lastRateLimitAt),
      lastDataLimitAt: iso(this.lastDataLimitAt), cooldownUntil: iso(cooldown), cooldownSource: cooldown ? this.cooldownSource : null,
      upstreamRemaining: null, upstreamResetAt: null,
      uncertainty: "Counts every local HTTP attempt, including retries and follow-ups. Other clients using the same access token and earlier process lifetimes are unobserved; remaining is an estimate, not upstream quota. Attempts that never reached YNAB can also overcount usage. Data-limit allowance is unknown.",
      policy: { concurrency: this.concurrency, maxQueued: 64, timeoutMs: 45000, maxReadRetries: 1, maxBackoffMs: MAX_BACKOFF_MS, mutationRetries: 0 },
    };
  }
}

export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && now + delay <= 8640000000000000 ? delay : null;
  }
  if (/^[+-]/.test(value.trim())) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export const apiUsageTracker = new ApiUsageTracker();
