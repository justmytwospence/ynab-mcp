import { test } from "node:test";
import assert from "node:assert/strict";
import { getBudgetSnapshot, invalidateBudgetSnapshot } from "./budget-snapshot.js";
import { apiUsageTracker } from "./utils/api-usage.js";
import { performCategoryMerge } from "./workflows/lib/category-merge.js";

const json = (data: object) => Response.json({ data });
const timeout = () => Response.json({ error: { id: "503", name: "timeout", detail: "offline" } }, { status: 503 });
const month = (date: string) => ({ month: date, income: 0, budgeted: 0, activity: 0, to_be_budgeted: 100000, age_of_money: null, deleted: false, categories: [] });
const plan = (id: string) => ({ id, name: "Offline budget", accounts: [], categories: [], category_groups: [], payees: [], transactions: [], months: [], scheduled_transactions: [] });

test("offline SDK snapshot costs, delta reuse and fallback preflights", async t => {
  process.env.YNAB_API_TOKEN = "offline-test-token";
  const original = globalThis.fetch;
  const requests: URL[] = [];
  let handler: (url: URL, init?: RequestInit) => Response = () => { throw new Error("Unexpected offline request"); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return handler(url, init);
  };
  t.after(() => { globalThis.fetch = original; invalidateBudgetSnapshot(); });

  await t.test("cold export, delta tombstones and resource-age cache accurately count HTTP", async () => {
    const base = requests.length;
    handler = url => {
      if (url.searchParams.has("last_knowledge_of_server")) {
        assert.equal(url.searchParams.get("last_knowledge_of_server"), "7");
        return json({ plan: { id: "cached", accounts: [{ id: "old", deleted: true }, { id: "new", name: "New" }], months: [] }, server_knowledge: 8 });
      }
      return json({ plan: { ...plan("cached"), accounts: [{ id: "old", name: "Old" }] }, server_knowledge: 7 });
    };
    const cold = await getBudgetSnapshot("cached");
    assert.equal(cold.apiCalls, 1);
    const cached = await getBudgetSnapshot("cached", { maxAgeMs: 60000 });
    assert.equal(cached.apiCalls, 0);
    const delta = await getBudgetSnapshot("cached", { maxAgeMs: -1 });
    assert.equal(delta.apiCalls, 1);
    assert.deepEqual(delta.snapshot.plan.accounts?.map(a => a.id), ["new"]);
    assert.equal(delta.snapshot.serverKnowledge, 8);
    assert.equal(requests.length - base, 2);
  });

  await t.test("an unusable delta refetches once and full-read retry cost is included", async () => {
    let calls = 0;
    handler = url => {
      if (url.searchParams.has("last_knowledge_of_server")) return json({ plan: { id: "unmergeable", months: [{ month: "2026-01-01" }] }, server_knowledge: 3 });
      if (++calls === 1) return Response.json({ error: { id: "500", name: "error", detail: "offline" } }, { status: 500 });
      return json({ plan: plan("unmergeable"), server_knowledge: 2 });
    };
    assert.equal((await getBudgetSnapshot("unmergeable")).apiCalls, 2);
    const refreshed = await getBudgetSnapshot("unmergeable", { maxAgeMs: -1 });
    assert.equal(refreshed.apiCalls, 2);
    assert.equal(refreshed.refetchedInFull, true);
  });

  await t.test("503 fallback costs 1+5+M+Y and later refreshes skip the known-failing full export", async () => {
    const year = new Date().getUTCFullYear();
    const dates = [`${year}-01-01`, `${year}-02-01`];
    handler = url => {
      const path = url.pathname;
      if (path.endsWith("/settings")) return json({ settings: {} });
      if (path.endsWith("/accounts")) return json({ accounts: [] });
      if (path.endsWith("/categories")) return json({ category_groups: [] });
      if (path.endsWith("/months")) return json({ months: dates.map(month).reverse() });
      if (path.includes("/months/")) return json({ month: month(path.split("/").at(-1)!) });
      if (path.endsWith("/payees")) return json({ payees: [] });
      if (path.endsWith("/transactions")) { assert.ok(url.searchParams.has("until_date")); return json({ transactions: [] }); }
      return timeout();
    };
    const base = requests.length;
    const result = await getBudgetSnapshot("piecewise");
    assert.equal(result.apiCalls, 9);
    assert.equal(requests.length - base, 9);
    assert.equal(result.snapshot.assembledPiecewise, true);
    assert.equal(result.snapshot.plan.first_month, dates[0]);
    assert.equal(result.snapshot.plan.scheduled_transactions, undefined);
    const next = await getBudgetSnapshot("piecewise", { maxAgeMs: -1 });
    assert.equal(next.apiCalls, 8);
  });

  await t.test("fallback preflights M+Y after discovery, before any history fan-out", async () => {
    const dates = Array.from({ length: 201 }, (_, i) => new Date(Date.UTC(2000, i, 1)).toISOString().slice(0, 10));
    handler = url => {
      if (url.pathname.endsWith("/months")) return json({ months: dates.map(month) });
      if (url.pathname.endsWith("/settings")) return json({ settings: {} });
      if (url.pathname.endsWith("/accounts")) return json({ accounts: [] });
      if (url.pathname.endsWith("/categories")) return json({ category_groups: [] });
      if (url.pathname.endsWith("/payees")) return json({ payees: [] });
      if (url.pathname.includes("/months/") || url.pathname.endsWith("/transactions")) assert.fail("history phase must not start");
      return timeout();
    };
    const base = requests.length;
    await assert.rejects(getBudgetSnapshot("too-large"), /budget cannot cover/);
    assert.equal(requests.length - base, 6);
    assert.equal(apiUsageTracker.getUsage().reserved, 0);
  });

  await t.test("category merge preflights the whole mutation batch before any write", async () => {
    const year = new Date().getUTCFullYear();
    const months = Array.from({ length: 110 }, (_, i) => ({ ...month(new Date(Date.UTC(year, i, 1)).toISOString().slice(0, 10)), categories: [
      { id: "source", budgeted: 1000 }, { id: "target", budgeted: 0 },
    ] }));
    handler = (_url, init) => {
      assert.equal(init?.method, "GET");
      return json({ plan: { ...plan("merge"), categories: [{ id: "source", name: "Source" }, { id: "target", name: "Target" }], months }, server_knowledge: 1 });
    };
    const base = requests.length;
    await assert.rejects(performCategoryMerge("merge", "source", "target", false), /budget cannot cover/);
    assert.equal(requests.length - base, 1);
  });

  await t.test("fallback discovery cannot start with fewer than five remaining slots", async () => {
    handler = url => url.hostname === "offline.invalid" ? json({}) : timeout();
    while (apiUsageTracker.getUsage().used < 196) await apiUsageTracker.wrappedFetch("https://offline.invalid/fill");
    const base = requests.length;
    await assert.rejects(getBudgetSnapshot("exhausted"), /budget cannot cover/);
    assert.equal(requests.length - base, 1);
    assert.equal(apiUsageTracker.getUsage().used, 197);
  });
});
