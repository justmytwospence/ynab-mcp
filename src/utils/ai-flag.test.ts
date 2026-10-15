import { test } from "node:test";
import assert from "node:assert/strict";
import { aiFlagColor, withAiFlag } from "./ai-flag.js";

const BASE = "https://api.ynab.com/v1/plans/p1";

interface Call { url: string; method: string; body: any }

/** A fake YNAB: records requests; existing flags by id; echoes updates back. */
function fakeYnab(flags: Record<string, string | null> = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const echo = (t: any) => {
      if ("flag_color" in t) flags[t.id] = t.flag_color;
      return { id: t.id, import_id: t.import_id ?? null, flag_color: flags[t.id] ?? null };
    };
    let data: any = {};
    if (method === "PUT") data = { transaction: echo({ ...body.transaction, id: url.split("/").pop() }) };
    else if (method === "PATCH") data = { transactions: body.transactions.map(echo) };
    else if (method === "POST") data = { transactions: (body.transactions ?? [body.transaction]).map((t: any) => ({ ...t, id: "new" })) };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn, flags };
}

const send = (f: typeof fetch, method: string, path: string, body: unknown) =>
  f(`${BASE}${path}`, { method, headers: { Authorization: "Bearer x" }, body: JSON.stringify(body) }).then((r) => r.json());

test("aiFlagColor reads the env and rejects non-colors", () => {
  assert.equal(aiFlagColor({ YNAB_MCP_AI_FLAG: "Purple" }), "purple");
  assert.equal(aiFlagColor({ YNAB_MCP_AI_FLAG: "off" }), null);
  assert.equal(aiFlagColor({}), null);
  assert.equal(aiFlagColor({ YNAB_MCP_AI_FLAG: "pink" }), null);
});

test("disabled: requests pass through untouched", async () => {
  const y = fakeYnab();
  const f = withAiFlag(y.fetchFn, null);
  assert.equal(f, y.fetchFn);
});

test("create: the flag goes into the request, an explicit one wins", async () => {
  const y = fakeYnab();
  const f = withAiFlag(y.fetchFn, "purple");
  await send(f, "POST", "/transactions", { transactions: [{ amount: 1 }, { amount: 2, flag_color: "red" }] });
  assert.equal(y.calls.length, 1);
  assert.deepEqual(y.calls[0]!.body.transactions.map((t: any) => t.flag_color), ["purple", "red"]);
});

test("bulk update: unflagged edits get the flag in one follow-up, user flags are kept", async () => {
  const y = fakeYnab({ a: null, b: "red", c: null, d: null });
  const f = withAiFlag(y.fetchFn, "purple");
  const res = await send(f, "PATCH", "/transactions", {
    transactions: [
      { id: "a", category_id: "groceries" }, // meaningful, unflagged -> marked
      { id: "b", memo: "x" }, // meaningful, user flag -> kept
      { id: "c", cleared: "reconciled" }, // bookkeeping -> not marked
      { id: "d", category_id: "x", flag_color: null }, // explicit clear -> respected
    ],
  });
  assert.equal(y.calls.length, 2);
  assert.equal(y.calls[1]!.method, "PATCH");
  assert.equal(y.calls[1]!.url, `${BASE}/transactions`);
  assert.deepEqual(y.calls[1]!.body, { transactions: [{ id: "a", flag_color: "purple" }] });
  assert.deepEqual(y.flags, { a: "purple", b: "red", c: null, d: null });
  // The caller sees the flag it now has.
  assert.equal(res.data.transactions.find((t: any) => t.id === "a").flag_color, "purple");
});

test("single update: marked via the bulk endpoint", async () => {
  const y = fakeYnab({ t1: null });
  const f = withAiFlag(y.fetchFn, "purple");
  const res = await send(f, "PUT", "/transactions/t1", { transaction: { memo: "Amazon: socks" } });
  assert.equal(y.calls.length, 2);
  assert.equal(y.calls[1]!.url, `${BASE}/transactions`);
  assert.equal(res.data.transaction.flag_color, "purple");
});

test("nothing to mark: no extra request", async () => {
  const y = fakeYnab({ a: null });
  const f = withAiFlag(y.fetchFn, "purple");
  await send(f, "PATCH", "/transactions", { transactions: [{ id: "a", approved: true }] });
  assert.equal(y.calls.length, 1);
});

test("imports and scheduled transactions are left alone", async () => {
  const y = fakeYnab();
  const f = withAiFlag(y.fetchFn, "purple");
  await send(f, "POST", "/transactions/import", {});
  await send(f, "POST", "/scheduled_transactions", { scheduled_transaction: { amount: 1 } });
  assert.equal(y.calls.length, 2);
  assert.deepEqual(y.calls[0]!.body, {});
  assert.equal(y.calls[1]!.body.scheduled_transaction.flag_color, undefined);
});
