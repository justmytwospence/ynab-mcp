import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

export function registerBudgetTools(server: McpServer) {
  server.registerTool("list_budgets", {
    title: "List Budgets",
    description: "List all budgets the user has access to, with optional account info",
    inputSchema: {
      include_accounts: z.boolean().optional().describe("Include accounts for each budget"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ include_accounts }) => {
    try {
      const response = await getClient().plans.getPlans(include_accounts);
      const budgets = response.data.plans;
      const lines = budgets.map((b) => {
        let line = `- ${b.name} (ID: ${b.id})`;
        if (b.last_modified_on) line += ` [Last modified: ${b.last_modified_on}]`;
        if (include_accounts && b.accounts) {
          for (const a of b.accounts) {
            line += `\n  - ${a.name}: ${formatCurrency(a.balance)} (${a.type})`;
          }
        }
        return line;
      });
      return textResult(`Budgets:\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_budget", {
    title: "Get Budget",
    description: "Get a single budget's full detail including all entities. Use 'last-used' for the most recently accessed budget.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request - only return entities changed since this server knowledge value"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().plans.getPlanById(budget_id, last_knowledge_of_server);
      const b = response.data.plan;
      const summary = [
        `Budget: ${b.name}`,
        `ID: ${b.id}`,
        `Last Modified: ${b.last_modified_on}`,
        `Accounts: ${b.accounts?.length ?? 0}`,
        `Categories: ${b.categories?.length ?? 0}`,
        `Payees: ${b.payees?.length ?? 0}`,
        `Transactions: ${b.transactions?.length ?? 0}`,
        `Scheduled Transactions: ${b.scheduled_transactions?.length ?? 0}`,
        `Server Knowledge: ${response.data.server_knowledge}`,
      ];
      return textResult(summary.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_budget_settings", {
    title: "Get Budget Settings",
    description: "Get a budget's date and currency format settings",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      const response = await getClient().plans.getPlanSettingsById(budget_id);
      const s = response.data.settings;
      const lines = [
        `Date Format: ${s.date_format?.format}`,
        `Currency Format:`,
        `  ISO Code: ${s.currency_format?.iso_code}`,
        `  Symbol: ${s.currency_format?.currency_symbol}`,
        `  Decimal Digits: ${s.currency_format?.decimal_digits}`,
        `  Symbol First: ${s.currency_format?.symbol_first}`,
        `  Display Symbol: ${s.currency_format?.display_symbol}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
