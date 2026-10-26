import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiUsageTracker, retryAfterMs } from "./api-usage.js";
import { withAiFlag } from "./ai-flag.js";
import { operationUsage, runOperation } from "./operation.js";

const ok = () => Response.json({ data: {} });
const apiError = (status: number, id = String(status), headers: HeadersInit = {}) => Response.json({ error: { id, name: "test", detail: "offline" } }, { status, headers });
const url = "https://offline.invalid/v1/plans/test";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("rolling-hour estimate blocks call 201, reports next slot not full reset, and ignores invented quota headers", async () => {
  let now = 10000000, sent = 0;
  const tracker = new ApiUsageTracker({ now: () => now, fetch: async (_input, init) => {
    sent++;
    assert.ok(init?.signal);
    return Response.json({}, { headers: { "X-Rate-Limit-Remaining": "999", "X-Rate-Limit-Reset": "123" } });
  } });
  for (let i = 0; i < 200; i++) { await tracker.wrappedFetch(url); now += 10; }
  const usage = tracker.getUsage();
  assert.equal(usage.used, 200);
  assert.equal(usage.remaining, 0);
  assert.equal(usage.nextAvailableSlotAt, new Date(10000000 + 3600000).toISOString());
  assert.equal(usage.windowResetsAt, usage.nextAvailableSlotAt);
  assert.notEqual(usage.allObservedCallsExpireAt, usage.windowResetsAt);
  assert.equal(usage.upstreamRemaining, null);
  assert.equal(usage.upstreamResetAt, null);
  await assert.rejects(tracker.wrappedFetch(url), /budget cannot cover/);
  assert.equal(sent, 200);
  now = 10000000 + 3600000;
  assert.equal(tracker.getUsage().remaining, 1);
  await tracker.wrappedFetch(url);
  assert.equal(sent, 201);
  assert.equal(tracker.getUsage().used, 200);
});

test("safe read backoff counts every attempt and never exceeds one retry", async () => {
  let now = 0, sent = 0;
  const delays: number[] = [];
  const tracker = new ApiUsageTracker({ now: () => now, sleep: async ms => { delays.push(ms); now += ms; }, fetch: async () => {
    sent++;
    return sent === 1 ? apiError(500) : ok();
  } });
  await runOperation(async () => {
    assert.equal((await tracker.wrappedFetch(url)).status, 200);
    assert.equal(operationUsage().attempts, 2);
  });
  assert.deepEqual(delays, [500]);
  assert.equal(tracker.getUsage().used, 2);
  const persistent = new ApiUsageTracker({ sleep: async () => {}, fetch: async () => apiError(502) });
  assert.equal((await persistent.wrappedFetch(url)).status, 502);
  assert.equal(persistent.getUsage().used, 2);
});

test("429 Retry-After seconds and dates drive bounded read retry and cached cooldown; absence is local backoff", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z"), sent = 0;
  const tracker = new ApiUsageTracker({ now: () => now, sleep: async ms => { now += ms; }, fetch: async () => {
    return ++sent === 1 ? apiError(429, "429", { "Retry-After": "1" }) : ok();
  } });
  assert.equal((await tracker.wrappedFetch(url)).status, 200);
  assert.equal(sent, 2);
  assert.equal(tracker.getUsage().cooldownUntil, null);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", now), 59000);
  assert.equal(retryAfterMs("bad", now), null);
  assert.equal(retryAfterMs("-1", now), null);
  assert.equal(retryAfterMs("9".repeat(400), now), null);
  for (const header of ["120", undefined]) {
    const long = new ApiUsageTracker({ now: () => now, sleep: async () => { assert.fail("must not sleep through a long cooldown"); },
      fetch: async () => apiError(429, "429", header ? { "Retry-After": header } : {}) });
    assert.equal((await long.wrappedFetch(url)).status, 429);
    const usage = long.getUsage();
    assert.equal(usage.used, 1);
    assert.equal(usage.cooldownUntil, new Date(now + (header ? 120000 : 60000)).toISOString());
    assert.equal(usage.cooldownSource, header ? "retry-after" : "local-backoff");
    await assert.rejects(long.wrappedFetch(url), /cooldown/);
    assert.equal(long.getUsage().used, 1);
  }
});

test("only JSON error 403.4 records a data limit, without consuming the SDK body", async () => {
  let dataLimit = false;
  const tracker = new ApiUsageTracker({ fetch: async () => apiError(403, dataLimit ? "403.4" : "403.1") });
  await tracker.wrappedFetch(url);
  assert.equal(tracker.getUsage().lastDataLimitAt, null);
  dataLimit = true;
  const response = await tracker.wrappedFetch(url);
  assert.equal((await response.json()).error.id, "403.4");
  assert.ok(tracker.getUsage().lastDataLimitAt);
  const html = new ApiUsageTracker({ fetch: async () => new Response("denied", { status: 403 }) });
  assert.equal((await (await html.wrappedFetch(url)).json()).error.id, "403");
  assert.equal(html.getUsage().lastDataLimitAt, null);
});

test("mutation statuses and lost responses are never replayed; failed transports still count", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const status of [429, 500, 502, 503]) {
      let sent = 0;
      const tracker = new ApiUsageTracker({ fetch: async () => { sent++; return apiError(status); } });
      assert.equal((await tracker.wrappedFetch(url, { method })).status, status);
      assert.equal(sent, 1);
    }
    const tracker = new ApiUsageTracker({ fetch: async () => { throw new TypeError("lost response"); } });
    await assert.rejects(tracker.wrappedFetch(url, { method }), /lost response/);
    assert.equal(tracker.getUsage().used, 1);
  }
});

test("aggregate concurrency is bounded and reservations atomically protect expensive phases", async () => {
  let active = 0, maximum = 0, entered = 0;
  const releases: Array<() => void> = [];
  const tracker = new ApiUsageTracker({ concurrency: 2, fetch: async () => {
    active++; entered++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--; return ok();
  } });
  const calls = Array.from({ length: 5 }, () => tracker.wrappedFetch(url));
  await tick();
  assert.equal(entered, 2);
  while (entered < 5 || releases.length) { releases.splice(0).forEach(resolve => resolve()); await tick(); }
  await Promise.all(calls);
  assert.equal(maximum, 2);
  const reserved = new ApiUsageTracker({ fetch: async () => ok() });
  let release!: () => void;
  const phase = reserved.withBudget(199, async () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(reserved.withBudget(2, async () => assert.fail("must not start")), /budget cannot cover/);
  await reserved.wrappedFetch(url); // Only the one unreserved slot is available.
  await assert.rejects(reserved.wrappedFetch(url), /budget cannot cover/);
  assert.equal(reserved.getUsage().nextAvailableSlotAt, null);
  assert.match(reserved.getUsage().nextAvailableSlotReason, /release time unknown/);
  release(); await phase;
  assert.equal(reserved.getUsage().reserved, 0);
  assert.equal(reserved.getUsage().used, 1);
  await assert.rejects(reserved.withBudget(1, async () => { throw new Error("phase fails"); }), /phase fails/);
  assert.equal(reserved.getUsage().reserved, 0);
});

test("concurrency permit lasts through response body transfer and the queue has a finite bound", async () => {
  let sent = 0;
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const tracker = new ApiUsageTracker({ concurrency: 1, fetch: async () => {
    sent++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }));
  } });
  const first = tracker.wrappedFetch(url);
  const second = tracker.wrappedFetch(url);
  await tick();
  assert.equal(sent, 1);
  controllers[0]!.enqueue(new TextEncoder().encode("{}")); controllers[0]!.close();
  await first; await tick();
  assert.equal(sent, 2);
  controllers[1]!.enqueue(new TextEncoder().encode("{}")); controllers[1]!.close();
  await second;

  let unblock!: () => void;
  let started = 0;
  const queued = new ApiUsageTracker({ concurrency: 1, fetch: async () => {
    if (++started === 1) await new Promise<void>(resolve => { unblock = resolve; });
    return ok();
  } });
  const outcomes = Promise.allSettled(Array.from({ length: 66 }, () => queued.wrappedFetch(url)));
  await tick();
  assert.equal(started, 1);
  unblock();
  const results = await outcomes;
  assert.equal(results.filter(r => r.status === "fulfilled").length, 65);
  const rejected = results.find(r => r.status === "rejected");
  assert.match(rejected?.status === "rejected" ? rejected.reason.message : "", /queue full/);
  assert.equal(queued.getUsage().used, 65);
});

test("AI flag follow-ups count and failure is a partial-result warning, not primary mutation replay", async () => {
  let sent = 0;
  const tracker = new ApiUsageTracker({ fetch: async () => {
    if (++sent === 1) return Response.json({ data: { transaction: { id: "t1", flag_color: null } } });
    return apiError(500);
  } });
  const flagged = withAiFlag(tracker.wrappedFetch, "purple", (cost, fn) => tracker.withBudget(cost, fn));
  await runOperation(async () => {
    const response = await flagged(`${url}/transactions/t1`, { method: "PUT", body: JSON.stringify({ transaction: { memo: "offline edit" } }) });
    assert.equal(response.status, 200);
    assert.equal(operationUsage().attempts, 2);
    assert.match(operationUsage().warnings.join(" "), /Primary transaction update succeeded/);
  });
  assert.equal(sent, 2);
  assert.equal(tracker.getUsage().reserved, 0);
  // Preflight includes the possible flag update before the primary mutation.
  for (let i = 0; i < 197; i++) await tracker.wrappedFetch(url, { method: "POST" });
  await assert.rejects(flagged(`${url}/transactions/t1`, { method: "PUT", body: JSON.stringify({ transaction: { memo: "another edit" } }) }), /budget cannot cover/);
  assert.equal(sent, 199);
});

test("per-operation costs do not include other overlapping invocations", async () => {
  const tracker = new ApiUsageTracker({ fetch: async () => ok() });
  const counts = await Promise.all([1, 3].map(count => runOperation(async () => {
    for (let i = 0; i < count; i++) await tracker.wrappedFetch(url);
    return operationUsage().attempts;
  })));
  assert.deepEqual(counts, [1, 3]);
  assert.equal(tracker.getUsage().used, 4);
});
