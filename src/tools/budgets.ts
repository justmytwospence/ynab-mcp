import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, setActiveCurrencyFormat } from "../utils/formatting.js";
import { getBudgetSnapshot, snapshotMonths } from "../budget-snapshot.js";

export function registerBudgetTools(server: McpServer) {
  server.registerTool("list_budgets", {
    title: "List Budgets",
    description: "[1 API call] List all budgets the user has access to, with optional account info",
    inputSchema: z.object({
      include_accounts: z.boolean().optional().describe("Include accounts for each budget"),
    }),
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
      return errorResult(e);
    }
  });

  server.registerTool("get_budget", {
    title: "Get Budget",
    description:
      "[1 API call, cached] Get a single budget's full detail: every account, category, payee, transaction, " +
      "and every budget month with its per-category budgeted/activity/balance. The response is cached in " +
      "memory and refreshed by delta, so repeat calls and the workflows built on it cost one request or none. " +
      "Use 'last-used' for the most recently accessed budget.",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      force_refresh: z.boolean().default(false).describe("Discard the cached snapshot and refetch the full export"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, force_refresh }) => {
    try {
      const { snapshot, apiCalls } = await getBudgetSnapshot(budget_id, { forceFull: force_refresh });
      const b = snapshot.plan;
      const months = snapshotMonths(snapshot);
      const summary = [
        `Budget: ${b.name}`,
        `ID: ${b.id}`,
        `Last Modified: ${b.last_modified_on}`,
        `Accounts: ${b.accounts?.length ?? 0}`,
        `Categories: ${b.categories?.length ?? 0}`,
        `Payees: ${b.payees?.length ?? 0}`,
        `Transactions: ${b.transactions?.length ?? 0}`,
        `Scheduled Transactions: ${b.scheduled_transactions?.length ?? 0}`,
        months.length > 0
          ? `Months: ${months.length} (${months[0]!.month} to ${months[months.length - 1]!.month}), with per-category detail`
          : `Months: 0`,
        `Server Knowledge: ${snapshot.serverKnowledge}`,
        `API calls used: ${apiCalls}`,
      ];
      if (snapshot.assembledPiecewise) {
        summary.push(
          `Note: the full export timed out (503), so this was assembled from the per-resource endpoints.`,
          `It has no plan-level server knowledge, so each refresh re-assembles it.`
        );
      }
      return textResult(summary.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("get_budget_settings", {
    title: "Get Budget Settings",
    description: "[1 API call] Get a budget's date and currency format settings",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      const response = await getClient().plans.getPlanSettingsById(budget_id);
      const s = response.data.settings;
      setActiveCurrencyFormat(s.currency_format);
      const lines = [
        `Date Format: ${s.date_format?.format}`,
        `Currency Format:`,
        `  ISO Code: ${s.currency_format?.iso_code}`,
        `  Symbol: ${s.currency_format?.currency_symbol}`,
        `  Decimal Digits: ${s.currency_format?.decimal_digits}`,
        `  Symbol First: ${s.currency_format?.symbol_first}`,
        `  Display Symbol: ${s.currency_format?.display_symbol}`,
        ``,
        `Amounts in this session will now be formatted using this currency: ${formatCurrency(1234560)}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
