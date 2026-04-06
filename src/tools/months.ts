import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

export function registerMonthTools(server: McpServer) {
  server.registerTool("list_months", {
    title: "List Budget Months",
    description: "[1 API call] List all budget months for a budget, showing income, budgeted, activity, and ready to assign",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().months.getPlanMonths(budget_id, last_knowledge_of_server);
      const months = response.data.months;
      const lines = months.map((m) =>
        `- ${m.month}: Income ${formatCurrency(m.income)} | Budgeted ${formatCurrency(m.budgeted)} | Activity ${formatCurrency(m.activity)} | To Be Budgeted ${formatCurrency(m.to_be_budgeted)}`
      );
      return textResult(
        `Budget Months (${months.length}):\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("get_month", {
    title: "Get Budget Month",
    description: "[1 API call] Get detailed info for a single budget month including all category balances. Use 'current' for the current month.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month) or 'current'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, month }) => {
    try {
      const response = await getClient().months.getPlanMonth(budget_id, month);
      const m = response.data.month;
      const lines = [
        `Month: ${m.month}`,
        `Income: ${formatCurrency(m.income)}`,
        `Budgeted: ${formatCurrency(m.budgeted)}`,
        `Activity: ${formatCurrency(m.activity)}`,
        `To Be Budgeted: ${formatCurrency(m.to_be_budgeted)}`,
        `Age of Money: ${m.age_of_money ?? "N/A"} days`,
      ];
      if (m.categories) {
        lines.push(`\nCategories:`);
        for (const c of m.categories) {
          if (c.hidden) continue;
          lines.push(`  - ${c.name}: Budgeted ${formatCurrency(c.budgeted)} | Activity ${formatCurrency(c.activity)} | Balance ${formatCurrency(c.balance)}`);
        }
      }
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
