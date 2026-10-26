import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getClient } from "./ynab-client.js";
import { getBudgetSnapshot, snapshotCacheStatus, type BudgetSnapshot } from "./budget-snapshot.js";
import { formatCurrency, attributes } from "./utils/formatting.js";
import { apiUsageTracker } from "./utils/api-usage.js";
import { dateSchema, idSchema, monthSchema } from "./utils/register.js";
import { BUDGET_GUIDANCE, USAGE_GUIDE } from "./utils/guidance.js";

function textResource(uri: URL, text: string) {
  const cap = 65536;
  const bytes = Buffer.from(text);
  if (bytes.length > cap) text = bytes.subarray(0, cap - 200).toString("utf8") + "\n[TRUNCATED: resource text exceeded 64 KiB; use scoped tools/templates.]";
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
}
function parameter(value: string | string[], schema: z.ZodType<string> = idSchema) {
  if (typeof value !== "string") throw new Error("Expected a single URI parameter");
  return schema.parse(decodeURIComponent(value));
}
function noQuery(uri: URL) { if (uri.search) throw new Error("This resource does not accept query parameters"); }
function provenance(s: BudgetSnapshot, apiCalls: number) {
  return { budget_id: s.budgetId, refresh_api_calls: apiCalls, fetched_at: new Date(s.fetchedAt).toISOString(), assembled_piecewise: s.assembledPiecewise,
    omitted: s.assembledPiecewise ? ["scheduled_transactions", "scheduled_subtransactions", "payee_locations"] : [],
    source: "YNAB budget snapshot (60 second resource cache)" };
}
const SNAPSHOT_COST = "[0 calls if snapshot <60s old; normally 1 refresh; unusable delta +1; 503 fallback 5+M+Y calls plus failed reads/retries, preflighted]";

export function registerResources(server: McpServer) {
  server.registerResource("usage-guide", "ynab://guide", {
    title: "YNAB Usage and Limits", description: "Local workflow, cost, retry and result guide [0 HTTP requests]", mimeType: "text/plain",
  }, async uri => textResource(uri, USAGE_GUIDE));

  server.registerResource("api-usage", "ynab://api-usage", {
    title: "YNAB API Usage", description: "Cached local rolling-hour estimates, next slot, cooldown and snapshot metadata; NOT upstream remaining quota [0 HTTP requests]", mimeType: "text/plain",
  }, async uri => {
    const stats = apiUsageTracker.getUsage();
    return textResource(uri, ["YNAB API Usage (local estimate)", `Calls used: ${stats.used} / ${stats.limit}`,
      `Estimated remaining: ${stats.remaining}`, `Next observed expiry (not full reset): ${stats.windowResetsAt ?? "N/A"}`,
      JSON.stringify({ ...stats, snapshots: snapshotCacheStatus() }, null, 2), BUDGET_GUIDANCE,
      "Read ynab://guide for template URIs and prompt examples/costs."].join("\n"));
  });

  server.registerResource("budget-summary", new ResourceTemplate("ynab://budgets/{budget_id}/summary", { list: undefined }), {
    title: "Budget Summary", description: `Snapshot budget overview, up to 100 accounts/groups each, with provenance ${SNAPSHOT_COST}`, mimeType: "text/plain",
  }, async (uri, { budget_id }) => {
    noQuery(uri);
    const { snapshot, apiCalls } = await getBudgetSnapshot(parameter(budget_id), { maxAgeMs: 60000 });
    const budget = snapshot.plan;
    const accounts = (budget.accounts ?? []).filter(a => !a.deleted);
    const groups = (budget.category_groups ?? []).filter(g => !g.deleted);
    const lines = [`Budget: ${budget.name}`, `Last modified: ${budget.last_modified_on ?? "unknown"}`,
      `Currency: ${budget.currency_format?.iso_code ?? "unknown"}`, JSON.stringify(provenance(snapshot, apiCalls)), "", "Accounts:"];
    for (const a of accounts.slice(0, 100)) lines.push(`  ${a.name} [${a.type}]: ${formatCurrency(a.balance)}${a.closed ? " (closed)" : ""}`);
    lines.push("", "Category Groups:");
    for (const g of groups.slice(0, 100)) lines.push(`  ${g.name}${attributes(g)}`);
    if (accounts.length > 100 || groups.length > 100) lines.push(`[TRUNCATED: ${accounts.length} accounts, ${groups.length} groups; first 100 shown of each.]`);
    return textResource(uri, lines.join("\n"));
  });

  server.registerResource("accounts", new ResourceTemplate("ynab://budgets/{budget_id}/accounts", { list: undefined }), {
    title: "Account List", description: "Accounts with balances/status, capped at 500 rows and 64 KiB [1 API read, retries may add calls]", mimeType: "text/plain",
  }, async (uri, { budget_id }) => {
    noQuery(uri);
    const res = await getClient().accounts.getAccounts(parameter(budget_id));
    const lines = ["Accounts:"];
    for (const a of res.data.accounts.slice(0, 500)) lines.push(`  ${a.name} [${a.type}]${a.closed ? " (closed)" : ""}`,
      `    Balance: ${formatCurrency(a.balance)} | Cleared: ${formatCurrency(a.cleared_balance)} | Uncleared: ${formatCurrency(a.uncleared_balance)}`);
    if (res.data.accounts.length > 500) lines.push("[TRUNCATED: first 500 accounts shown.]");
    return textResource(uri, lines.join("\n"));
  });

  server.registerResource("month-categories", new ResourceTemplate("ynab://budgets/{budget_id}/months/{month}/categories", { list: undefined }), {
    title: "Monthly Category Budget", description: "Category balances for one month, capped at 500 rows/64 KiB [1 API read, retries may add calls]", mimeType: "text/plain",
  }, async (uri, { budget_id, month }) => {
    noQuery(uri);
    const res = await getClient().months.getPlanMonth(parameter(budget_id), parameter(month, monthSchema.or(z.literal("current"))));
    const m = res.data.month;
    const lines = [`Budget Month: ${m.month}`, `Income: ${formatCurrency(m.income)}`, `Budgeted: ${formatCurrency(m.budgeted)}`,
      `Activity: ${formatCurrency(m.activity)}`, `To Be Budgeted: ${formatCurrency(m.to_be_budgeted)}`, ""];
    for (const c of (m.categories ?? []).slice(0, 500)) lines.push(`  ${c.category_group_name ?? "Ungrouped"} / ${c.name}${attributes(c)}: Budgeted ${formatCurrency(c.budgeted)} | Activity ${formatCurrency(c.activity)} | Balance ${formatCurrency(c.balance)}`);
    if ((m.categories ?? []).length > 500) lines.push("[TRUNCATED: first 500 categories shown.]");
    return textResource(uri, lines.join("\n"));
  });

  server.registerResource("category-month", new ResourceTemplate("ynab://budgets/{budget_id}/categories/{category_id}/months/{month}", { list: undefined }), {
    title: "Category Month Context", description: `One snapshot category-month; goals are configured today, not historical targets ${SNAPSHOT_COST}`, mimeType: "text/plain",
  }, async (uri, { budget_id, category_id, month }) => {
    noQuery(uri);
    const id = parameter(budget_id), categoryId = parameter(category_id), monthId = parameter(month, monthSchema);
    const { snapshot, apiCalls } = await getBudgetSnapshot(id, { maxAgeMs: 60000 });
    const category = snapshot.plan.months?.find(m => m.month === monthId && !m.deleted)?.categories?.find(c => c.id === categoryId && !c.deleted);
    if (!category) throw new Error("Category-month not present in this budget snapshot");
    return textResource(uri, JSON.stringify({ provenance: provenance(snapshot, apiCalls), month: monthId, category, goal_history: "Not available; goal fields reflect configuration today" }));
  });

  server.registerResource("account-transactions", new ResourceTemplate("ynab://budgets/{budget_id}/accounts/{account_id}/transactions/{since_date}/{until_date}/{limit}/{offset}", { list: undefined }), {
    title: "Bounded Account Transactions", description: `Snapshot transactions for one account, <=366 days, 1-100 rows/page, offset <=10000; output paging does not bound upstream export size ${SNAPSHOT_COST}`, mimeType: "text/plain",
  }, async (uri, { budget_id, account_id, since_date, until_date, limit: pageLimit, offset: pageOffset }) => {
    noQuery(uri);
    const integer = z.string().regex(/^\d+$/).transform(Number);
    const limit = integer.pipe(z.number().int().min(1).max(100)).parse(pageLimit);
    const offset = integer.pipe(z.number().int().min(0).max(10000)).parse(pageOffset);
    const id = parameter(budget_id), accountId = parameter(account_id);
    const since = parameter(since_date, dateSchema), until = parameter(until_date, dateSchema);
    if (since > until || Date.parse(until) - Date.parse(since) > 366 * 86400000) throw new Error("Use an ordered date window of at most 366 days");
    const { snapshot, apiCalls } = await getBudgetSnapshot(id, { maxAgeMs: 60000 });
    if (!snapshot.plan.accounts?.some(a => a.id === accountId && !a.deleted)) throw new Error("Account not present in this budget snapshot");
    const rows = (snapshot.plan.transactions ?? []).filter(t => !t.deleted && t.account_id === accountId && t.date >= since && t.date <= until)
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const page = rows.slice(offset, offset + limit).map(t => ({ id: t.id, date: t.date, amount: t.amount, payee_id: t.payee_id, category_id: t.category_id, memo: t.memo?.slice(0, 200), cleared: t.cleared, approved: t.approved }));
    const body = () => {
      const next = offset + page.length < rows.length && offset + page.length <= 10000 ? offset + page.length : null;
      const nextUri = new URL(uri); if (next !== null) nextUri.pathname = nextUri.pathname.replace(/\/\d+\/\d+$/, `/${limit}/${next}`);
      return JSON.stringify({ provenance: provenance(snapshot, apiCalls), transactions: page, total: rows.length, offset, limit,
        memo_truncated: rows.slice(offset, offset + page.length).some(t => (t.memo?.length ?? 0) > 200),
        truncated: offset + page.length < rows.length, next_uri: next === null ? null : nextUri.href });
    };
    // Keep JSON valid and advance by rows actually returned, even with Unicode memos.
    while (Buffer.byteLength(body()) > 65536 && page.length > 0) page.pop();
    if (page.length === 0 && offset < rows.length) throw new Error("A transaction exceeds the resource byte bound; use get_transaction");
    return textResource(uri, body());
  });
}
