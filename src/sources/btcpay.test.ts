import { test } from "node:test";
import assert from "node:assert/strict";
import { btcpayMovements, btcpaySats } from "./btcpay.js";

const env: NodeJS.ProcessEnv = {
  BTCPAY_URL: "https://pay.example/ignored", BTCPAY_API_KEY: "secret-token",
  BITCOIN_RPC_URL: "http://node.example/", BITCOIN_RPC_USER: "user", BITCOIN_RPC_PASSWORD: "password",
};
const store = "store /?#";
const wallet = `/api/v1/stores/${encodeURIComponent(store)}/payment-methods/BTC-CHAIN/wallet`;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const row = () => ({ paymentMethodId: "BTC-CHAIN", available: true, syncHeight: 101, chainHeight: 100,
  nodeInformation: { blocks: 101, headers: 100, verificationProgress: 0.99999 } });
const info = () => ({ fullySynched: false, syncStatus: [{ paymentMethodId: "BTC-LN", available: false }, row()] });
const tx = (n: number, block = 1, amount = "0.1") => ({ transactionHash: hash(n), blockHash: hash(block),
  confirmations: 1, status: "Confirmed", blockHeight: 1, timestamp: "1999-01-01T00:00:00Z", amount });
const header = (block: number, date = "2026-01-02T00:00:00Z") => ({ hash: hash(block), confirmations: 1, time: Date.parse(date) / 1000 });

type Handler = (url: string, init: RequestInit, body: any) => Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function mockFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const options = init ?? {};
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url, init: options, body });
    return handler(url, options, body);
  }) as typeof fetch;
  return { f, calls };
}
function assertAllowed(calls: ReturnType<typeof mockFetch>["calls"]) {
  for (const { url, init, body } of calls) {
    assert.ok(init.signal instanceof AbortSignal);
    if (url === env.BITCOIN_RPC_URL) {
      assert.equal(init.method, "POST");
      assert.equal(body.method, "getblockheader");
      assert.deepEqual(body.params, [body.params[0], true]);
      assert.match(body.params[0], /^[a-f0-9]{64}$/);
    } else {
      assert.equal(init.method, "GET");
      assert.equal((init.headers as Record<string, string>).Authorization, `token ${env.BTCPAY_API_KEY}`);
      assert.equal(init.redirect, "error");
      assert.ok(url === `https://pay.example/api/v1/server/info` || url === `https://pay.example${wallet}` ||
        new RegExp(`^https://pay\\.example${wallet}/transactions\\?statusFilter=Confirmed&skip=\\d+&limit=100$`).test(url), url);
      assert.equal(init.body, undefined);
    }
  }
}
function standard(options: { sync?: unknown; balance?: unknown; pages?: unknown[]; headers?: Record<string, unknown> } = {}) {
  return mockFetch((url, _init, body) => {
    if (url === env.BITCOIN_RPC_URL) return json({ result: options.headers?.[body.params[0]] ?? header(1), error: null });
    if (url.endsWith("/server/info")) return json(options.sync ?? info());
    if (url.includes("/transactions?")) {
      const skip = Number(new URL(url).searchParams.get("skip"));
      return json(options.pages?.[skip / 100] ?? []);
    }
    return json({ confirmedBalance: options.balance ?? "0.12345678", totalBalance: "999", unconfirmedBalance: "998" });
  });
}
const movements = (f: typeof fetch, since = "2026-01-01", e = env) => btcpayMovements(store, since, "2026-01-01", f, e);

test("balance: encoded read-only endpoints, token auth, confirmed exact sats and 20s timeouts", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  const m = standard();
  assert.equal(await btcpaySats(store, m.f, env), 12_345_678);
  assert.deepEqual(m.calls.map(c => c.url), [`https://pay.example/api/v1/server/info`, `https://pay.example${wallet}`]);
  assert.deepEqual(timeout.mock.calls.map(c => c.arguments[0]), [20_000, 20_000]);
  assertAllowed(m.calls);
});

test("balance: exact decimal bounds, zero, and invalid values", async () => {
  for (const [value, expected] of [["0", 0], ["0.00000001", 1], ["90071992.54740991", Number.MAX_SAFE_INTEGER]] as const) {
    assert.equal(await btcpaySats(store, standard({ balance: value }).f, env), expected);
  }
  for (const value of [0, -1, "-0", "-0.1", "", "1.", ".1", "01", "1e-8", " 1", "1.000000001", "90071992.54740992", null, {}, "NaN"]) {
    const m = mockFetch(url => json(url.endsWith("/server/info") ? info() : { confirmedBalance: value }));
    await assert.rejects(() => btcpaySats(store, m.f, env), String(value));
  }
});

test("configuration and store validation fail before HTTP", async () => {
  for (const bad of [{ ...env, BTCPAY_URL: "ftp://host" }, { ...env, BTCPAY_URL: "https://u:p@host" },
    { ...env, BTCPAY_URL: "not a url" }, { ...env, BTCPAY_API_KEY: " " }]) {
    const m = standard();
    await assert.rejects(() => btcpaySats(store, m.f, bad));
    assert.equal(m.calls.length, 0);
  }
  for (const id of ["", " ", ".", ".."]) {
    const m = standard();
    await assert.rejects(() => btcpaySats(id, m.f, env));
    assert.equal(m.calls.length, 0);
  }
  const m = standard();
  await assert.rejects(() => movements(m.f, "2026-01-01", { ...env, BITCOIN_RPC_PASSWORD: "" }));
  assert.equal(m.calls.length, 0);
  const http = standard();
  assert.equal(await btcpaySats(store, http.f, { ...env, BTCPAY_URL: "http://pay.example" }), 12345678);
});

test("BTC-CHAIN sync is isolated from other rails and fails closed", async () => {
  const good = row();
  const badRows: unknown[] = [null, {}, { ...good, available: false }, { ...good, available: 1 },
    { ...good, syncHeight: 99 }, { ...good, syncHeight: Infinity }, { ...good, chainHeight: -1 },
    { ...good, syncHeight: 100.5 }, { ...good, nodeInformation: null },
    { ...good, nodeInformation: { ...good.nodeInformation, blocks: 99 } },
    { ...good, nodeInformation: { ...good.nodeInformation, headers: "100" } },
    { ...good, nodeInformation: { ...good.nodeInformation, verificationProgress: 0.9999 } },
    { ...good, nodeInformation: { ...good.nodeInformation, verificationProgress: NaN } }];
  for (const bad of badRows) {
    const m = standard({ sync: { fullySynched: true, syncStatus: [bad] } });
    await assert.rejects(() => btcpaySats(store, m.f, env));
    assert.equal(m.calls.length, 1);
  }
  for (const sync of [{}, { syncStatus: "bad" }, { syncStatus: [good, good] }, { syncStatus: [{ ...good, paymentMethodId: "BTC-LN" }] }]) {
    await assert.rejects(() => btcpaySats(store, standard({ sync }).f, env));
  }
  assert.equal(await btcpaySats(store, standard().f, env), 12345678);
});

test("HTTP failures, malformed JSON and thrown secrets are sanitized and never retried", async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const m = mockFetch(() => new Response("secret-token private-body https://pay.example", { status }));
    const error = await btcpaySats(store, m.f, env).catch(e => e);
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(error.message, /secret-token|private-body|pay\.example/);
    assert.equal(m.calls.length, 1);
  }
  for (const handler of [() => { throw new Error("timeout https://pay.example secret-token private-body"); },
    () => { throw new DOMException("https://pay.example secret-token private-body", "TimeoutError"); },
    () => new Response("{secret-token private-body https://pay.example")]) {
    const m = mockFetch(handler);
    const error = await btcpaySats(store, m.f, env).catch(e => e);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /secret-token|private-body|pay\.example/);
    assert.equal(m.calls.length, 1);
  }
});

test("history uses block dates, signed net amounts, deduplicates and sorts; only approved requests", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  const a = tx(3, 10, "-0.00000001");
  const b = tx(2, 11, "0.25");
  const c = tx(1, 11, "1.1");
  const m = standard({ pages: [[a, b, c, { ...b, transactionHash: b.transactionHash.toUpperCase() }, tx(4, 12, "0"), tx(5, 13)]],
    headers: { [hash(10)]: header(10, "2026-01-03T23:59:59Z"), [hash(11)]: header(11),
      [hash(12)]: header(12), [hash(13)]: header(13, "2025-12-31T23:59:59Z") } });
  assert.deepEqual(await movements(m.f), [
    { date: "2026-01-02", txid: hash(1), sats: 110_000_000 },
    { date: "2026-01-02", txid: hash(2), sats: 25_000_000 },
    { date: "2026-01-03", txid: hash(3), sats: -1 },
  ]);
  assert.deepEqual(m.calls.filter(c => c.url === env.BITCOIN_RPC_URL).map(c => c.body.params[0]), [hash(10), hash(11), hash(12), hash(13)]);
  assert.ok(timeout.mock.calls.every(c => c.arguments[0] === 20_000));
  assertAllowed(m.calls);
  await movements(m.f);
  assert.equal(m.calls.filter(c => c.url === env.BITCOIN_RPC_URL).length, 8, "header cache must be per call");
});

test("history fetches later pages despite old block dates and stops only on a short page", async () => {
  const m = standard({ pages: [Array.from({ length: 100 }, (_, i) => tx(i + 100, 20)), [tx(500, 21)]],
    headers: { [hash(20)]: header(20, "2025-01-01T00:00:00Z"), [hash(21)]: header(21) } });
  assert.deepEqual(await movements(m.f), [{ date: "2026-01-02", txid: hash(500), sats: 10_000_000 }]);
  assert.deepEqual(m.calls.filter(c => c.url.includes("/transactions?")).map(c => new URL(c.url).searchParams.get("skip")), ["0", "100"]);
  assertAllowed(m.calls);
});

test("history refuses 100 full pages rather than returning partial history", async () => {
  const page = Array.from({ length: 100 }, (_, i) => tx(i + 1));
  const m = mockFetch(url => url.endsWith("/server/info") ? json(info()) : json(page));
  await assert.rejects(() => movements(m.f), /100 full pages/);
  assert.equal(m.calls.length, 101);
  assertAllowed(m.calls);
});

test("history coverage and calendar dates are checked before any HTTP", async () => {
  const m = standard();
  await assert.rejects(() => btcpayMovements(store, "2025-12-31", "2026-01-01", m.f, env),
    { message: "BTC history is only verified from 2026-01-01; review earlier movements before reconciling" });
  for (const date of ["2026-02-29", "2026-1-01", "not-a-date"]) {
    await assert.rejects(() => btcpayMovements(store, date, "2026-01-01", m.f, env));
    await assert.rejects(() => btcpayMovements(store, "2026-01-01", date, m.f, env));
  }
  assert.equal(m.calls.length, 0);
});

test("history rejects malformed transactions and conflicting duplicates", async () => {
  const good = tx(1);
  const invalid = [{ ...good, transactionHash: "abc" }, { ...good, blockHash: "z".repeat(64) },
    { ...good, status: "Pending" }, { ...good, confirmations: 0 }, { ...good, confirmations: 1.5 },
    { ...good, blockHeight: -1 }, { ...good, blockHeight: "1" }, { ...good, amount: 0.1 },
    { ...good, amount: "-1.000000001" }, { ...good, amount: "-90071992.54740992" }, null];
  for (const value of invalid) await assert.rejects(() => movements(standard({ pages: [[value]] }).f), JSON.stringify(value));
  for (const page of [{}, Array(101).fill(good), [good, { ...good, amount: "0.2" }], [good, { ...good, blockHash: hash(2) }]]) {
    await assert.rejects(() => movements(standard({ pages: [page] }).f));
  }
});

test("history rejects malformed, mismatched and orphaned node headers without leaking RPC errors", async () => {
  for (const value of [null, {}, { ...header(1), hash: hash(2) }, { ...header(1), confirmations: 0 },
    { ...header(1), confirmations: -1 }, { ...header(1), time: -1 }, { ...header(1), time: "1" },
    { ...header(1), time: Number.MAX_SAFE_INTEGER }]) {
    // Explicit null needs a dedicated handler rather than the standard helper's default.
    const m = mockFetch((url) => url === env.BITCOIN_RPC_URL ? json({ result: value }) :
      url.endsWith("/server/info") ? json(info()) : json([tx(2)]));
    await assert.rejects(() => movements(m.f), /header/);
    assertAllowed(m.calls);
  }
  const m = mockFetch(url => {
    if (url === env.BITCOIN_RPC_URL) throw new Error("password secret-token private-body http://node.example");
    return url.endsWith("/server/info") ? json(info()) : json([tx(2)]);
  });
  const error = await movements(m.f).catch(e => e);
  assert.match(error.message, /header/);
  assert.doesNotMatch(error.message, /password|secret-token|private-body|node\.example/);
  assert.equal(m.calls.filter(c => c.url === env.BITCOIN_RPC_URL).length, 1);
});
