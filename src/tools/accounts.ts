import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

const ACCOUNT_TYPES = [
  "checking", "savings", "cash", "creditCard", "lineOfCredit",
  "otherAsset", "otherLiability", "mortgage", "autoLoan",
  "studentLoan", "personalLoan", "medicalDebt", "otherDebt",
] as const;

export function registerAccountTools(server: McpServer) {
  server.registerTool("list_accounts", {
    title: "List Accounts",
    description: "[1 API call] List all accounts for a budget including balances and types",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().accounts.getAccounts(budget_id, last_knowledge_of_server);
      const accounts = response.data.accounts;
      const lines = accounts.map((a) => {
        const status = a.closed ? " [CLOSED]" : "";
        const onBudget = a.on_budget ? "On Budget" : "Off Budget";
        return `- ${a.name}${status}: ${formatCurrency(a.balance)} (${a.type}, ${onBudget}) [ID: ${a.id}]`;
      });
      return textResult(
        `Accounts (${accounts.length}):\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("get_account", {
    title: "Get Account",
    description: "[1 API call] Get details for a single account",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("The account ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, account_id }) => {
    try {
      const response = await getClient().accounts.getAccountById(budget_id, account_id);
      const a = response.data.account;
      const lines = [
        `Name: ${a.name}`,
        `Type: ${a.type}`,
        `Balance: ${formatCurrency(a.balance)}`,
        `Cleared Balance: ${formatCurrency(a.cleared_balance)}`,
        `Uncleared Balance: ${formatCurrency(a.uncleared_balance)}`,
        `On Budget: ${a.on_budget}`,
        `Closed: ${a.closed}`,
        `Note: ${a.note ?? "None"}`,
        `ID: ${a.id}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("create_account", {
    title: "Create Account",
    description: "[1 API call] Create a new account in a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      name: z.string().describe("Account name"),
      type: z.enum(ACCOUNT_TYPES).describe("Account type"),
      balance: z.number().describe("Starting balance in dollars (e.g., 1000.50)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, name, type, balance }) => {
    try {
      const response = await getClient().accounts.createAccount(budget_id, {
        account: { name, type, balance: Math.round(balance * 1000) },
      });
      const a = response.data.account;
      return textResult(`Created account "${a.name}" (${a.type}) with balance ${formatCurrency(a.balance)}\nID: ${a.id}`);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
