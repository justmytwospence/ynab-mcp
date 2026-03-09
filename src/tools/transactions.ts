import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";
import type { TransactionDetail, HybridTransaction } from "ynab";

const CLEARED_VALUES = ["cleared", "uncleared", "reconciled"] as const;
const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
const TRANSACTION_TYPES = ["uncategorized", "unapproved"] as const;

function formatTransaction(t: TransactionDetail | HybridTransaction): string {
  const cleared = t.cleared === "cleared" ? "C" : t.cleared === "reconciled" ? "R" : " ";
  const approved = t.approved ? "A" : " ";
  const flag = t.flag_color ? ` [${t.flag_color}]` : "";
  return `- ${t.date} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"} | ${t.category_name ?? "Uncategorized"} | ${t.account_name} [${cleared}${approved}]${flag} ${t.memo ? `"${t.memo}"` : ""} [ID: ${t.id}]`;
}

export function registerTransactionTools(server: McpServer) {
  server.registerTool("list_transactions", {
    title: "List Transactions",
    description: "List transactions for a budget with optional filters. Returns most recent transactions first.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      since_date: z.string().optional().describe("Only return transactions on or after this date (YYYY-MM-DD)"),
      type: z.enum(TRANSACTION_TYPES).optional().describe("Filter by 'uncategorized' or 'unapproved'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, since_date, type, last_knowledge_of_server }) => {
    try {
      const response = await getClient().transactions.getTransactions(
        budget_id, since_date, type, last_knowledge_of_server
      );
      const txns = response.data.transactions;
      if (txns.length === 0) return textResult("No transactions found.");
      const lines = txns.map(formatTransaction);
      return textResult(
        `Transactions (${txns.length}):\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_transaction", {
    title: "Get Transaction",
    description: "Get details for a single transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      transaction_id: z.string().describe("The transaction ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, transaction_id }) => {
    try {
      const response = await getClient().transactions.getTransactionById(budget_id, transaction_id);
      const t = response.data.transaction;
      const lines = [
        `Date: ${t.date}`,
        `Amount: ${formatCurrency(t.amount)}`,
        `Payee: ${t.payee_name ?? "None"} (ID: ${t.payee_id ?? "N/A"})`,
        `Category: ${t.category_name ?? "Uncategorized"} (ID: ${t.category_id ?? "N/A"})`,
        `Account: ${t.account_name} (ID: ${t.account_id})`,
        `Memo: ${t.memo ?? "None"}`,
        `Cleared: ${t.cleared}`,
        `Approved: ${t.approved}`,
        `Flag: ${t.flag_color ?? "None"}`,
        `Transfer Account: ${t.transfer_account_id ?? "None"}`,
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

  server.registerTool("create_transaction", {
    title: "Create Transaction",
    description: "Create a new transaction. Amounts are in dollars (positive for inflows, negative for outflows). For split transactions, set category_id to null and provide subtransactions.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("Account ID for the transaction"),
      date: z.string().describe("Transaction date (YYYY-MM-DD)"),
      amount: z.number().describe("Amount in dollars (negative for outflows, e.g., -25.50)"),
      payee_id: z.string().optional().describe("Payee ID (if known)"),
      payee_name: z.string().optional().describe("Payee name (will match or create payee)"),
      category_id: z.string().optional().describe("Category ID (omit for split transactions)"),
      memo: z.string().optional().describe("Transaction memo"),
      cleared: z.enum(CLEARED_VALUES).optional().describe("Cleared status"),
      approved: z.boolean().optional().describe("Whether the transaction is approved (default: false)"),
      flag_color: z.enum(FLAG_COLORS).optional().describe("Flag color"),
      subtransactions: z.array(z.object({
        amount: z.number().describe("Subtransaction amount in dollars"),
        payee_id: z.string().optional(),
        payee_name: z.string().optional(),
        category_id: z.string().optional(),
        memo: z.string().optional(),
      })).optional().describe("Split transaction parts (amounts must sum to the total)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, account_id, date, amount, payee_id, payee_name, category_id, memo, cleared, approved, flag_color, subtransactions }) => {
    try {
      const response = await getClient().transactions.createTransaction(budget_id, {
        transaction: {
          account_id,
          date,
          amount: dollarsToMilliunits(amount),
          payee_id,
          payee_name,
          category_id,
          memo,
          cleared,
          approved,
          flag_color: flag_color ?? null,
          subtransactions: subtransactions?.map((s) => ({
            amount: dollarsToMilliunits(s.amount),
            payee_id: s.payee_id,
            payee_name: s.payee_name,
            category_id: s.category_id,
            memo: s.memo,
          })),
        },
      });
      const t = response.data.transaction;
      if (t) {
        return textResult(
          `Created transaction: ${t.date} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"} | ${t.category_name ?? "Uncategorized"}\nID: ${t.id}`
        );
      }
      const txns = response.data.transactions;
      return textResult(`Created ${txns?.length ?? 0} transaction(s).`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("create_transactions", {
    title: "Create Multiple Transactions",
    description: "Create multiple transactions at once. Each transaction needs account_id, date, and amount at minimum.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      transactions: z.array(z.object({
        account_id: z.string().describe("Account ID"),
        date: z.string().describe("Date (YYYY-MM-DD)"),
        amount: z.number().describe("Amount in dollars (negative for outflows)"),
        payee_id: z.string().optional(),
        payee_name: z.string().optional(),
        category_id: z.string().optional(),
        memo: z.string().optional(),
        cleared: z.enum(CLEARED_VALUES).optional(),
        approved: z.boolean().optional(),
        flag_color: z.enum(FLAG_COLORS).optional(),
      })).describe("Array of transactions to create"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, transactions }) => {
    try {
      const response = await getClient().transactions.createTransaction(budget_id, {
        transactions: transactions.map((t) => ({
          account_id: t.account_id,
          date: t.date,
          amount: dollarsToMilliunits(t.amount),
          payee_id: t.payee_id,
          payee_name: t.payee_name,
          category_id: t.category_id,
          memo: t.memo,
          cleared: t.cleared,
          approved: t.approved,
          flag_color: t.flag_color ?? null,
        })),
      });
      const created = response.data.transactions;
      return textResult(`Created ${created?.length ?? 0} transaction(s).`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_transaction", {
    title: "Update Transaction",
    description: "Update an existing transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      transaction_id: z.string().describe("The transaction ID to update"),
      account_id: z.string().optional().describe("New account ID"),
      date: z.string().optional().describe("New date (YYYY-MM-DD)"),
      amount: z.number().optional().describe("New amount in dollars"),
      payee_id: z.string().optional().describe("New payee ID"),
      payee_name: z.string().optional().describe("New payee name"),
      category_id: z.string().optional().describe("New category ID"),
      memo: z.string().optional().describe("New memo"),
      cleared: z.enum(CLEARED_VALUES).optional().describe("New cleared status"),
      approved: z.boolean().optional().describe("New approval status"),
      flag_color: z.enum(FLAG_COLORS).optional().describe("New flag color"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, transaction_id, ...fields }) => {
    try {
      const data: any = { ...fields };
      if (data.amount != null) data.amount = dollarsToMilliunits(data.amount);
      if (data.flag_color !== undefined) data.flag_color = data.flag_color ?? null;
      const response = await getClient().transactions.updateTransaction(budget_id, transaction_id, {
        transaction: data,
      });
      const t = response.data.transaction;
      return textResult(
        `Updated transaction: ${t.date} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"}\nID: ${t.id}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_transactions", {
    title: "Bulk Update Transactions",
    description: "Update multiple transactions at once. Each must include either id or import_id to identify the transaction.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      transactions: z.array(z.object({
        id: z.string().optional().describe("Transaction ID"),
        import_id: z.string().optional().describe("Import ID"),
        account_id: z.string().optional(),
        date: z.string().optional(),
        amount: z.number().optional().describe("Amount in dollars"),
        payee_id: z.string().optional(),
        payee_name: z.string().optional(),
        category_id: z.string().optional(),
        memo: z.string().optional(),
        cleared: z.enum(CLEARED_VALUES).optional(),
        approved: z.boolean().optional(),
        flag_color: z.enum(FLAG_COLORS).optional(),
      })).describe("Transactions to update"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, transactions }) => {
    try {
      const response = await getClient().transactions.updateTransactions(budget_id, {
        transactions: transactions.map((t) => ({
          ...t,
          amount: t.amount != null ? dollarsToMilliunits(t.amount) : undefined,
          flag_color: t.flag_color ?? null,
        })),
      });
      const updated = response.data.transactions;
      return textResult(`Updated ${updated?.length ?? 0} transaction(s).`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("delete_transaction", {
    title: "Delete Transaction",
    description: "Delete a transaction",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      transaction_id: z.string().describe("The transaction ID to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, transaction_id }) => {
    try {
      const response = await getClient().transactions.deleteTransaction(budget_id, transaction_id);
      const t = response.data.transaction;
      return textResult(`Deleted transaction: ${t.date} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"}\nID: ${t.id}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("import_transactions", {
    title: "Import Transactions",
    description: "Trigger an import of transactions from linked financial institutions",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id }) => {
    try {
      const response = await getClient().transactions.importTransactions(budget_id);
      const data = response.data;
      return textResult(
        `Import complete:\n  Transaction IDs imported: ${data.transaction_ids?.length ?? 0}`
      );
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("list_account_transactions", {
    title: "List Account Transactions",
    description: "List transactions for a specific account",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("The account ID"),
      since_date: z.string().optional().describe("Only return transactions on or after this date (YYYY-MM-DD)"),
      type: z.enum(TRANSACTION_TYPES).optional().describe("Filter by type"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, account_id, since_date, type, last_knowledge_of_server }) => {
    try {
      const response = await getClient().transactions.getTransactionsByAccount(
        budget_id, account_id, since_date, type, last_knowledge_of_server
      );
      const txns = response.data.transactions;
      if (txns.length === 0) return textResult("No transactions found for this account.");
      const lines = txns.map(formatTransaction);
      return textResult(`Account Transactions (${txns.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("list_category_transactions", {
    title: "List Category Transactions",
    description: "List transactions for a specific category",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      category_id: z.string().describe("The category ID"),
      since_date: z.string().optional().describe("Only return transactions on or after this date (YYYY-MM-DD)"),
      type: z.enum(TRANSACTION_TYPES).optional().describe("Filter by type"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, category_id, since_date, type, last_knowledge_of_server }) => {
    try {
      const response = await getClient().transactions.getTransactionsByCategory(
        budget_id, category_id, since_date, type, last_knowledge_of_server
      );
      const txns = response.data.transactions;
      if (txns.length === 0) return textResult("No transactions found for this category.");
      const lines = txns.map(formatTransaction);
      return textResult(`Category Transactions (${txns.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("list_payee_transactions", {
    title: "List Payee Transactions",
    description: "List transactions for a specific payee",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
      since_date: z.string().optional().describe("Only return transactions on or after this date (YYYY-MM-DD)"),
      type: z.enum(TRANSACTION_TYPES).optional().describe("Filter by type"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, payee_id, since_date, type, last_knowledge_of_server }) => {
    try {
      const response = await getClient().transactions.getTransactionsByPayee(
        budget_id, payee_id, since_date, type, last_knowledge_of_server
      );
      const txns = response.data.transactions;
      if (txns.length === 0) return textResult("No transactions found for this payee.");
      const lines = txns.map(formatTransaction);
      return textResult(`Payee Transactions (${txns.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("list_month_transactions", {
    title: "List Month Transactions",
    description: "List transactions for a specific month",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month)"),
      since_date: z.string().optional().describe("Only return transactions on or after this date"),
      type: z.enum(TRANSACTION_TYPES).optional().describe("Filter by type"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, month, since_date, type, last_knowledge_of_server }) => {
    try {
      const response = await getClient().transactions.getTransactionsByMonth(
        budget_id, month, since_date, type, last_knowledge_of_server
      );
      const txns = response.data.transactions;
      if (txns.length === 0) return textResult(`No transactions found for ${month}.`);
      const lines = txns.map(formatTransaction);
      return textResult(`Month Transactions for ${month} (${txns.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
