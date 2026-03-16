import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "./ynab-client.js";
import { formatCurrency } from "./utils/formatting.js";
import { apiUsageTracker } from "./utils/api-usage.js";

export function registerResources(server: McpServer) {
  // Static resource: API usage (no API call needed)
  server.registerResource(
    "api-usage",
    "ynab://api-usage",
    {
      title: "YNAB API Usage",
      description: "Current rate limit status: calls used, remaining, and window reset time",
      mimeType: "text/plain",
    },
    async (uri) => {
      const stats = apiUsageTracker.getUsage();
      const lines = [
        "YNAB API Usage",
        `Calls used: ${stats.used} / ${stats.limit}`,
        `Remaining: ${stats.remaining}`,
        `Window resets: ${stats.windowResetsAt ?? "N/A"}`,
      ];
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") }] };
    }
  );

  // Template resource: Budget summary
  server.registerResource(
    "budget-summary",
    new ResourceTemplate("ynab://budgets/{budget_id}/summary", { list: undefined }),
    {
      title: "Budget Summary",
      description: "Budget overview with accounts, balances, and category groups [1 API call]",
      mimeType: "text/plain",
    },
    async (uri, { budget_id }) => {
      const res = await getClient().plans.getPlanById(budget_id as string);
      const budget = res.data.plan;

      const lines = [
        `Budget: ${budget.name}`,
        `Last modified: ${budget.last_modified_on}`,
        `Currency: ${budget.currency_format?.iso_code ?? "USD"}`,
        "",
        "Accounts:",
      ];

      for (const account of budget.accounts ?? []) {
        const status = account.closed ? " (closed)" : "";
        lines.push(
          `  ${account.name} [${account.type}]: ${formatCurrency(account.balance)}${status}`
        );
      }

      lines.push("", "Category Groups:");
      for (const group of budget.category_groups ?? []) {
        if (group.hidden) continue;
        lines.push(`  ${group.name}`);
      }

      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") }] };
    }
  );

  // Template resource: Account list
  server.registerResource(
    "accounts",
    new ResourceTemplate("ynab://budgets/{budget_id}/accounts", { list: undefined }),
    {
      title: "Account List",
      description: "All accounts with type, balance, cleared balance, and status [1 API call]",
      mimeType: "text/plain",
    },
    async (uri, { budget_id }) => {
      const res = await getClient().accounts.getAccounts(budget_id as string);
      const accounts = res.data.accounts;

      const lines = ["Accounts:"];
      for (const a of accounts) {
        const status = a.closed ? " (closed)" : "";
        lines.push(
          `  ${a.name} [${a.type}]${status}`,
          `    Balance: ${formatCurrency(a.balance)} | Cleared: ${formatCurrency(a.cleared_balance)} | Uncleared: ${formatCurrency(a.uncleared_balance)}`,
        );
      }

      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") }] };
    }
  );

  // Template resource: Monthly category budget sheet
  server.registerResource(
    "month-categories",
    new ResourceTemplate("ynab://budgets/{budget_id}/months/{month}/categories", { list: undefined }),
    {
      title: "Monthly Category Budget",
      description: "All categories for a budget month with budgeted, activity, and balance [1 API call]",
      mimeType: "text/plain",
    },
    async (uri, { budget_id, month }) => {
      const res = await getClient().months.getPlanMonth(budget_id as string, month as string);
      const monthData = res.data.month;

      const lines = [
        `Budget Month: ${monthData.month}`,
        `Income: ${formatCurrency(monthData.income)}`,
        `Budgeted: ${formatCurrency(monthData.budgeted)}`,
        `Activity: ${formatCurrency(monthData.activity)}`,
        `To Be Budgeted: ${formatCurrency(monthData.to_be_budgeted)}`,
        "",
      ];

      // Group categories by category_group_name
      const grouped = new Map<string, typeof monthData.categories>();
      for (const cat of monthData.categories ?? []) {
        if (cat.hidden) continue;
        const groupName = cat.category_group_name ?? "Ungrouped";
        if (!grouped.has(groupName)) grouped.set(groupName, []);
        grouped.get(groupName)!.push(cat);
      }

      for (const [groupName, cats] of grouped) {
        lines.push(`${groupName}:`);
        for (const c of cats) {
          lines.push(
            `  ${c.name}: Budgeted ${formatCurrency(c.budgeted)} | Activity ${formatCurrency(c.activity)} | Balance ${formatCurrency(c.balance)}`
          );
        }
        lines.push("");
      }

      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: lines.join("\n") }] };
    }
  );
}
