import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { invalidateBudgetSnapshot } from "./budget-snapshot.js";
import { resultSchema } from "./utils/formatting.js";

async function wire() {
  const server = createServer();
  const [client, transport] = InMemoryTransport.createLinkedPair();
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  client.onmessage = (message: JSONRPCMessage) => {
    if (!("id" in message) || !("result" in message || "error" in message)) return;
    const callback = pending.get(Number(message.id));
    if (!callback) return;
    pending.delete(Number(message.id));
    if ("error" in message) callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
  };
  await server.connect(transport);
  await client.start();
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    void client.send({ jsonrpc: "2.0", id: next, method, params }).catch(reject);
  });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "offline-tests", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, initialized, close: () => server.close() };
}
const json = (data: object) => Response.json({ data });

test("offline MCP wire declarations, resources, prompts and results", async t => {
  process.env.YNAB_API_TOKEN = "offline-test-token";
  delete process.env.AMAZON_ORDERS_URL;
  const dir = mkdtempSync(join(tmpdir(), "ynab-offline-"));
  const stateDir = join(dir, "must-not-be-created");
  process.env.YNAB_MCP_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  let sent = 0;
  let handler: (url: URL, init?: RequestInit) => Response = () => { throw new Error("Unexpected offline HTTP request"); };
  globalThis.fetch = async (input, init) => { sent++; return handler(new URL(input instanceof Request ? input.url : String(input)), init); };
  const connection = await wire();
  const { request } = connection;
  t.after(async () => { await connection.close(); globalThis.fetch = originalFetch; invalidateBudgetSnapshot(); rmSync(dir, { recursive: true, force: true }); });

  const tools = (await request("tools/list")).tools;
  const templates = (await request("resources/templates/list")).resourceTemplates;
  const prompts = (await request("prompts/list")).prompts;

  await t.test("initialize capabilities and complete audited hint/output inventories", async () => {
    assert.match(connection.initialized.instructions, /200 requests\/token\/rolling hour/);
    for (const feature of ["tools", "resources", "prompts"]) assert.ok(connection.initialized.capabilities[feature]);
    assert.equal(tools.length, 55);
    const writes = new Set(["create_account", "create_category", "update_category", "update_month_category", "create_category_group", "update_category_group", "update_payee", "create_payee", "create_transaction", "create_transactions", "update_transaction", "update_transactions", "delete_transaction", "import_transactions", "create_scheduled_transaction", "update_scheduled_transaction", "delete_scheduled_transaction", "merge_category", "delete_category", "audit_credit_card_payments", "audit_account_reconciliation", "audit_budget_integrity", "plan_month", "suggest_categories", "enrich_transactions"]);
    for (const tool of tools) {
      assert.ok(tool.title, tool.name);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint}`);
      assert.equal(tool.annotations.readOnlyHint, !writes.has(tool.name), tool.name);
      const local = ["get_api_usage", "list_item_categories"].includes(tool.name);
      assert.equal(tool.annotations.openWorldHint, !local, tool.name);
      if (writes.has(tool.name)) {
        const additive = tool.name.startsWith("create_") || tool.name === "import_transactions";
        assert.equal(tool.annotations.destructiveHint, !additive, tool.name);
        assert.match(tool.description, /preview.*before apply/i);
        assert.match(tool.description, /never automatically replayed/);
      } else {
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.annotations.idempotentHint, true);
      }
      assert.ok(tool.inputSchema);
      for (const field of ["text", "data", "api_usage", "request_cost"]) assert.ok(tool.outputSchema.properties[field], `${tool.name}.${field}`);
    }
    for (const name of ["merge_category", "delete_category", "plan_month", "suggest_categories", "enrich_transactions", "audit_account_reconciliation"]) {
      assert.equal(tools.find((tool: any) => tool.name === name).annotations.idempotentHint, false, name);
    }
    assert.equal(sent, 0);
  });

  await t.test("static guide is discoverable without templates/list or initialize instructions and catalogs every workflow", async () => {
    const resources = (await request("resources/list")).resources;
    assert.deepEqual(resources.map((r: any) => r.uri).sort(), ["ynab://api-usage", "ynab://guide"]);
    const guide = (await request("resources/read", { uri: "ynab://guide" })).contents[0].text;
    assert.equal(templates.length, 5);
    assert.equal(prompts.length, 6);
    for (const template of templates) assert.ok(guide.includes(template.uriTemplate), template.uriTemplate);
    for (const prompt of prompts) assert.ok(guide.includes(prompt.name), prompt.name);
    assert.match(guide, /Example: ynab:\/\/budgets\/last-used/);
    assert.match(guide, /zero HTTP|0 HTTP/);
    assert.match(guide, /preview|Preview/);
    assert.match(guide, /not necessarily|not assumed/);
    assert.equal(sent, 0);
  });

  await t.test("all prompts retrieve offline with budget/preview guidance and validated arguments", async () => {
    for (const prompt of prompts) {
      const args: Record<string, string> = { budget_id: "last-used" };
      for (const argument of prompt.arguments ?? []) {
        if (argument.name === "month" || argument.name === "since_month") args[argument.name] = "2026-01-01";
        if (argument.name === "since_date") args[argument.name] = "2026-01-01";
        if (argument.name === "account_id") args[argument.name] = "account";
        if (argument.name === "target_balance") args[argument.name] = "123.45";
      }
      const result = await request("prompts/get", { name: prompt.name, arguments: args });
      const text = result.messages.map((m: any) => m.content.text).join("\n");
      assert.match(text, /get_api_usage/);
      assert.match(text, /Preview mixed workflows first/);
      assert.match(text, /Writes are never automatically replayed/);
    }
    await assert.rejects(request("prompts/get", { name: "monthly-review", arguments: { month: "2026-02-30" } }));
    await assert.rejects(request("prompts/get", { name: "reconcile-account", arguments: { account_id: "a", target_balance: "NaN" } }));
    assert.equal(sent, 0);
  });

  await t.test("status and local item reads make zero HTTP and no filesystem writes", async () => {
    const status = await request("tools/call", { name: "get_api_usage", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.ok(resultSchema.safeParse(status.structuredContent).success);
    assert.equal(status.structuredContent.request_cost.attempts, 0);
    assert.equal(status.structuredContent.data.upstreamRemaining, null);
    assert.match(status.content[0].text, /preview|Preview/);
    const resource = await request("resources/read", { uri: "ynab://api-usage" });
    assert.match(resource.contents[0].text, /get_api_usage/);
    await request("tools/call", { name: "list_item_categories", arguments: {} });
    assert.equal(existsSync(stateDir), false);
    assert.equal(sent, 0);
  });

  await t.test("invalid resource URIs and tool inputs fail before HTTP", async () => {
    for (const uri of [
      "http://budgets/x/summary", "ynab://budgets/bad%2Fscope/summary", "ynab://budgets/x/summary?unexpected=1",
      "ynab://budgets/x/months/2026-01-02/categories", "ynab://budgets/x/categories/c/months/2026-02-30",
      "ynab://budgets/x/accounts/a/transactions/2026-01-31/2026-01-01/50/0",
      "ynab://budgets/x/accounts/a/transactions/2020-01-01/2026-01-01/50/0",
      "ynab://budgets/x/accounts/a/transactions/2026-01-01/2026-02-01/101/0",
      "ynab://budgets/x/accounts/a/transactions/2026-01-01/2026-02-01/NaN/0",
      "ynab://budgets/x/accounts/a/transactions/2026-01-01/2026-02-01/50/-1",
      "ynab://budgets/x/accounts/a/transactions/2026-01-01/2026-02-01/50/0?limit=1&limit=2",
    ]) await assert.rejects(request("resources/read", { uri }), uri);
    for (const [name, args] of [
      ["get_month", { month: "2026-01-02" }], ["get_account", { account_id: "" }],
      ["list_transactions", { since_date: "2026-02-01", until_date: "2026-01-01" }],
      ["create_transactions", { transactions: Array.from({ length: 1001 }, () => ({ account_id: "a", date: "2026-01-01", amount: 1 })) }],
      ["update_transactions", { transactions: [{ memo: "missing identifier" }] }],
    ] as const) {
      const result = await request("tools/call", { name, arguments: args });
      assert.equal(result.isError, true, name);
    }
    assert.equal(sent, 0);
  });

  const account = { id: "a", name: "Offline Account", type: "checking", balance: 1000, cleared_balance: 1000, uncleared_balance: 0, on_budget: true, closed: false, deleted: false };
  const category = { id: "c", name: "Groceries", category_group_id: "g", category_group_name: "Daily", budgeted: 10000, activity: -1000, balance: 9000, deleted: false };
  const month = { month: "2026-01-01", income: 0, budgeted: 10000, activity: -1000, to_be_budgeted: 0, categories: [category], deleted: false };
  const transactions = Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, account_id: "a", date: "2026-01-05", amount: -1000, payee_id: "p", memo: "offline", cleared: "cleared", approved: true, flag_color: i % 2 ? "purple" : null, category_id: "c", subtransactions: [], deleted: false }));
  const fixture = { id: "budget", name: "Offline", accounts: [account], categories: [category], category_groups: [{ id: "g", name: "Daily" }], months: [month], transactions, payees: [], scheduled_transactions: [] };

  await t.test("snapshot templates reuse a single full/delta cache read and bound local transaction pages", async () => {
    handler = url => {
      assert.equal(url.pathname, "/v1/plans/budget");
      return json({ plan: fixture, server_knowledge: 5 });
    };
    const base = sent;
    const summary = await request("resources/read", { uri: "ynab://budgets/budget/summary" });
    assert.match(summary.contents[0].text, /Offline Account/);
    const categoryResult = await request("resources/read", { uri: "ynab://budgets/budget/categories/c/months/2026-01-01" });
    assert.equal(JSON.parse(categoryResult.contents[0].text).category.id, "c");
    const uri = "ynab://budgets/budget/accounts/a/transactions/2026-01-01/2026-01-31/100/0";
    const result = JSON.parse((await request("resources/read", { uri })).contents[0].text);
    assert.equal(result.transactions.length, 100);
    assert.equal(result.total, 150);
    assert.equal(result.truncated, true);
    assert.equal(result.provenance.budget_id, "budget");
    assert.ok(result.next_uri.endsWith("/100/100"));
    const next = JSON.parse((await request("resources/read", { uri: result.next_uri })).contents[0].text);
    assert.equal(next.transactions.length, 50);
    assert.equal(next.truncated, false);
    assert.equal(next.next_uri, null);
    assert.equal(sent - base, 1);
  });

  await t.test("Unicode-heavy transaction pages stay valid JSON and do not skip byte-limited rows", async () => {
    invalidateBudgetSnapshot();
    handler = () => json({ plan: { ...fixture, transactions: transactions.map(t => ({ ...t, memo: "漢".repeat(500) })) }, server_knowledge: 6 });
    const uri = "ynab://budgets/budget/accounts/a/transactions/2026-01-01/2026-01-31/100/0";
    const response = await request("resources/read", { uri });
    assert.ok(Buffer.byteLength(response.contents[0].text) <= 65536);
    const page = JSON.parse(response.contents[0].text);
    assert.ok(page.transactions.length > 0 && page.transactions.length < 100);
    assert.equal(page.memo_truncated, true);
    assert.ok(page.next_uri.endsWith(`/100/${page.transactions.length}`));
    const next = JSON.parse((await request("resources/read", { uri: page.next_uri })).contents[0].text);
    assert.equal(next.offset, page.transactions.length);
    assert.equal(next.provenance.refresh_api_calls, 0);
    assert.notEqual(next.transactions[0].id, page.transactions.at(-1).id);
  });

  await t.test("existing resource content is bounded with explicit truncation and URI validation", async () => {
    handler = url => {
      if (url.pathname.endsWith("/months/2026-01-01")) return json({ month });
      return json({ accounts: Array.from({ length: 1000 }, () => ({ ...account, name: "long".repeat(1000) })) });
    };
    const result = await request("resources/read", { uri: "ynab://budgets/budget/accounts" });
    assert.ok(Buffer.byteLength(result.contents[0].text) <= 65536);
    assert.match(result.contents[0].text, /TRUNCATED/);
    const monthResult = await request("resources/read", { uri: "ynab://budgets/budget/months/2026-01-01/categories" });
    assert.match(monthResult.contents[0].text, /Groceries/);
  });

  await t.test("tool text compatibility includes filtered machine data and per-invocation HTTP costs", async () => {
    handler = url => {
      if (url.pathname.endsWith("/transactions")) return json({ transactions, server_knowledge: 10 });
      if (url.pathname.endsWith("/plans/budget")) return json({ plan: fixture, server_knowledge: 11 });
      throw new Error(`Unexpected ${url}`);
    };
    const result = await request("tools/call", { name: "list_transactions", arguments: { budget_id: "budget", since_date: "2026-01-01", flag: "purple" } });
    assert.match(result.content[0].text, /Transactions/);
    assert.ok(resultSchema.safeParse(result.structuredContent).success);
    assert.equal(result.structuredContent.data.transactions.length, 75);
    assert.equal(result.structuredContent.request_cost.attempts, 1);
    const summary = await request("tools/call", { name: "get_budget", arguments: { budget_id: "budget", force_refresh: true } });
    assert.match(summary.content[0].text, /Transactions: 150/);
    assert.equal(summary.structuredContent.data.counts.transactions, 150);
    assert.equal(summary.structuredContent.data.transactions, undefined); // Summary, honestly described.
    assert.equal(summary.structuredContent.request_cost.attempts, 1);
    const plan = await request("tools/call", { name: "plan_month", arguments: { budget_id: "budget", month: "2026-01-01", format: "json" } });
    assert.ok(resultSchema.safeParse(plan.structuredContent).success);
    const body = JSON.parse(plan.content[0].text);
    assert.equal(body.applied, null);
    assert.equal(body.api_calls, plan.structuredContent.request_cost.attempts);
    const beforeResource = sent;
    await request("resources/read", { uri: "ynab://budgets/budget/summary" });
    assert.equal(sent, beforeResource, "A mixed workflow preview must retain its fresh snapshot, not invalidate it");
  });

  await t.test("documented null categories/flags and import-id updates validate and reach the fake wire", async () => {
    handler = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (init?.method === "POST") {
        assert.equal(body.transaction.category_id, undefined); // null normalizes to SDK omission on creates.
        assert.equal(body.transaction.subtransactions[0].amount, -1000);
        return json({ transaction: transactions[0] });
      }
      assert.equal(init?.method, "PATCH");
      assert.equal(body.transactions[0].import_id, "YNAB:-1000:2026-01-01:1");
      assert.equal(body.transactions[0].flag_color, null);
      return json({ transactions: [transactions[0]] });
    };
    const split = await request("tools/call", { name: "create_transaction", arguments: { account_id: "a", date: "2026-01-01", amount: -1, category_id: null, subtransactions: [{ amount: -1, category_id: "c" }] } });
    assert.equal(split.isError, undefined);
    const update = await request("tools/call", { name: "update_transactions", arguments: { transactions: [{ import_id: "YNAB:-1000:2026-01-01:1", memo: "updated", flag_color: null }] } });
    assert.equal(update.isError, undefined);
    assert.equal(update.structuredContent.request_cost.attempts, 1);
  });

  await t.test("a lost mutation response is an error with cost, never automatically replayed", async () => {
    const base = sent;
    handler = (_url, init) => { assert.equal(init?.method, "POST"); throw new TypeError("ambiguous lost write"); };
    const result = await request("tools/call", { name: "create_transaction", arguments: { account_id: "a", date: "2026-01-01", amount: -1 } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.request_cost.attempts, 1);
    assert.equal(sent - base, 1);
    assert.ok(resultSchema.safeParse(result.structuredContent).success);
    const afterMutation = sent;
    handler = () => json({ plan: fixture, server_knowledge: 12 });
    await request("resources/read", { uri: "ynab://budgets/budget/summary" });
    assert.equal(sent, afterMutation + 1, "An ambiguous mutation must invalidate the cached snapshot");
  });

  await t.test("optional Amazon tools retain explicit remote-read declarations without discovery HTTP", async () => {
    process.env.AMAZON_ORDERS_URL = "https://offline.invalid";
    const optional = await wire();
    const base = sent;
    const all = (await optional.request("tools/list")).tools;
    assert.equal(all.length, 57);
    for (const name of ["amazon_order", "amazon_receipts"]) {
      const tool = all.find((tool: any) => tool.name === name);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
    assert.equal(sent, base);
    await optional.close();
    delete process.env.AMAZON_ORDERS_URL;
  });
});
