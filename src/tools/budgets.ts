import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../utils/register.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, setActiveCurrencyFormat } from "../utils/formatting.js";
import { getBudgetSnapshot, snapshotMonths } from "../budget-snapshot.js";

export function registerBudgetTools(server: McpServer) {
  registerTool(server, "list_budgets", {
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
      return textResult(`Budgets:\n${lines.join("\n")}`, response.data);
    } catch (e: any) {
      return errorResult(e);
    }
  });

  registerTool(server, "get_budget", {
    title: "Get Budget",
    description:
      "[Normally 1 API call; fallback variable] Refresh a cached budget export and return a SUMMARY (counts, month range, provenance), not every entity. " +
      "Workflows and bounded resource templates reuse the snapshot. Refresh uses delta; an unusable delta adds a full read. " +
      "A 503 fallback costs 5 + M month + Y yearly transaction calls and omits schedules/payee locations. Read retries can add calls. " +
      "Check get_api_usage first; fallback phases preflight local budget. Use 'last-used' for the most recently accessed budget.",
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
        `Scheduled Transactions: ${b.scheduled_transactions?.length ?? (snapshot.assembledPiecewise ? "not fetched" : 0)}`,
        months.length > 0
          ? `Months: ${months.length} (${months[0]!.month} to ${months[months.length - 1]!.month}), with per-category detail`
          : `Months: 0`,
        `Server Knowledge: ${snapshot.serverKnowledge}`,
        `API calls used: ${apiCalls}`,
      ];
      if (snapshot.assembledPiecewise) {
        summary.push(
          `Note: the full export timed out (503), so this was assembled from the per-resource endpoints.`,
          `It has no plan-level server knowledge, so each refresh re-assembles it. Scheduled transactions and payee locations are not fetched.`
        );
      }
      return textResult(summary.join("\n"), { budget_id: snapshot.budgetId, name: b.name, counts: { accounts: b.accounts?.length ?? 0, categories: b.categories?.length ?? 0, transactions: b.transactions?.length ?? 0 }, months: months.map(m => m.month), fetched_at: new Date(snapshot.fetchedAt).toISOString(), assembled_piecewise: snapshot.assembledPiecewise, server_knowledge: snapshot.serverKnowledge, api_calls: apiCalls });
    } catch (e: any) {
      return errorResult(e);
    }
  });

  registerTool(server, "get_budget_settings", {
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
      return textResult(lines.join("\n"), response.data);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
