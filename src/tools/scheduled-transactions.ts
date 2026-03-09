import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";

const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
const FREQUENCIES = [
  "never", "daily", "weekly", "everyOtherWeek", "twiceAMonth",
  "every4Weeks", "monthly", "everyOtherMonth", "every3Months",
  "every4Months", "twiceAYear", "yearly", "everyOtherYear",
] as const;

export function registerScheduledTransactionTools(server: McpServer) {
  server.registerTool("list_scheduled_transactions", {
    title: "List Scheduled Transactions",
    description: "[1 API call] List all scheduled (recurring) transactions for a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().scheduledTransactions.getScheduledTransactions(
        budget_id, last_knowledge_of_server
      );
      const txns = response.data.scheduled_transactions;
      if (txns.length === 0) return textResult("No scheduled transactions found.");
      const lines = txns.map((t) => {
        const freq = t.frequency ?? "once";
        return `- ${t.date_next ?? t.date_first} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"} | ${t.category_name ?? "Uncategorized"} | ${freq} | ${t.account_name} [ID: ${t.id}]`;
      });
      return textResult(
        `Scheduled Transactions (${txns.length}):\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_scheduled_transaction", {
    title: "Get Scheduled Transaction",
    description: "[1 API call] Get details for a single scheduled transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      scheduled_transaction_id: z.string().describe("The scheduled transaction ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, scheduled_transaction_id }) => {
    try {
      const response = await getClient().scheduledTransactions.getScheduledTransactionById(
        budget_id, scheduled_transaction_id
      );
      const t = response.data.scheduled_transaction;
      const lines = [
        `Date (First): ${t.date_first}`,
        `Date (Next): ${t.date_next}`,
        `Amount: ${formatCurrency(t.amount)}`,
        `Frequency: ${t.frequency}`,
        `Payee: ${t.payee_name ?? "None"} (ID: ${t.payee_id ?? "N/A"})`,
        `Category: ${t.category_name ?? "Uncategorized"} (ID: ${t.category_id ?? "N/A"})`,
        `Account: ${t.account_name} (ID: ${t.account_id})`,
        `Memo: ${t.memo ?? "None"}`,
        `Flag: ${t.flag_color ?? "None"}`,
        `ID: ${t.id}`,
      ];
      if (t.subtransactions && t.subtransactions.length > 0) {
        lines.push(`\nSplit Transactions:`);
        for (const sub of t.subtransactions) {
          lines.push(`  - ${formatCurrency(sub.amount)} | ${sub.category_name ?? "Uncategorized"} | ${sub.memo ?? ""}`);
        }
      }
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("create_scheduled_transaction", {
    title: "Create Scheduled Transaction",
    description: "[1 API call] Create a new scheduled (recurring) transaction. Date must be in the future (up to 5 years).",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("Account ID"),
      date: z.string().describe("First occurrence date (YYYY-MM-DD), must be future"),
      amount: z.number().describe("Amount in dollars (negative for outflows)"),
      frequency: z.enum(FREQUENCIES).describe("How often the transaction repeats"),
      payee_id: z.string().optional().describe("Payee ID"),
      payee_name: z.string().optional().describe("Payee name"),
      category_id: z.string().optional().describe("Category ID (cannot be credit card payment)"),
      memo: z.string().optional().describe("Memo"),
      flag_color: z.enum(FLAG_COLORS).optional().describe("Flag color"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, account_id, date, amount, frequency, payee_id, payee_name, category_id, memo, flag_color }) => {
    try {
      const response = await getClient().scheduledTransactions.createScheduledTransaction(budget_id, {
        scheduled_transaction: {
          account_id,
          date,
          amount: dollarsToMilliunits(amount),
          frequency,
          payee_id,
          payee_name,
          category_id,
          memo,
          flag_color: flag_color ?? null,
        },
      });
      const t = response.data.scheduled_transaction;
      return textResult(
        `Created scheduled transaction: ${t.date_first} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"} | ${t.frequency}\nID: ${t.id}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_scheduled_transaction", {
    title: "Update Scheduled Transaction",
    description: "[1 API call] Update an existing scheduled transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      scheduled_transaction_id: z.string().describe("The scheduled transaction ID"),
      account_id: z.string().describe("Account ID (required even if unchanged)"),
      date: z.string().describe("Date (YYYY-MM-DD, required even if unchanged)"),
      amount: z.number().optional().describe("New amount in dollars"),
      frequency: z.enum(FREQUENCIES).optional().describe("New frequency"),
      payee_id: z.string().optional().describe("New payee ID"),
      payee_name: z.string().optional().describe("New payee name"),
      category_id: z.string().optional().describe("New category ID"),
      memo: z.string().optional().describe("New memo"),
      flag_color: z.enum(FLAG_COLORS).optional().describe("New flag color"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, scheduled_transaction_id, account_id, date, amount, frequency, payee_id, payee_name, category_id, memo, flag_color }) => {
    try {
      const response = await getClient().scheduledTransactions.updateScheduledTransaction(
        budget_id, scheduled_transaction_id, {
          scheduled_transaction: {
            account_id,
            date,
            amount: amount != null ? dollarsToMilliunits(amount) : undefined,
            frequency,
            payee_id,
            payee_name,
            category_id,
            memo,
            flag_color: flag_color ?? null,
          },
        }
      );
      const t = response.data.scheduled_transaction;
      return textResult(
        `Updated scheduled transaction: ${t.date_first} | ${formatCurrency(t.amount)} | ${t.frequency}\nID: ${t.id}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("delete_scheduled_transaction", {
    title: "Delete Scheduled Transaction",
    description: "[1 API call] Delete a scheduled transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      scheduled_transaction_id: z.string().describe("The scheduled transaction ID to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, scheduled_transaction_id }) => {
    try {
      const response = await getClient().scheduledTransactions.deleteScheduledTransaction(
        budget_id, scheduled_transaction_id
      );
      const t = response.data.scheduled_transaction;
      return textResult(
        `Deleted scheduled transaction: ${t.date_first} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"}\nID: ${t.id}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
