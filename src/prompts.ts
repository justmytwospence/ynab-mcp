import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer) {
  server.registerPrompt("monthly-review", {
    title: "Monthly Budget Review",
    description:
      "Review a budget month: overspent categories, spending changes, underfunded goals, and credit card mismatches",
    argsSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month to review (YYYY-MM-DD, first of month, e.g. 2026-03-01)"),
    },
  }, async ({ budget_id, month }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Perform a monthly budget review for budget "${budget_id}", month ${month}. Follow these steps:`,
            "",
            "1. Fetch the month detail using get_month to see all category balances.",
            "2. Identify any overspent categories (negative balance) and list them with amounts.",
            "3. Compare budgeted vs. activity for each category to find the biggest spending variances.",
            "4. Check for categories with goals that are underfunded.",
            "5. Run audit_credit_card_payments for this month to check for payment category mismatches.",
            "6. Summarize findings with actionable recommendations.",
            "",
            "Present results in clear sections with currency amounts formatted for readability.",
          ].join("\n"),
        },
      },
    ],
  }));

  server.registerPrompt("transaction-audit", {
    title: "Transaction Audit",
    description:
      "Audit recent transactions for uncategorized, unapproved, possible duplicates, and unusual amounts",
    argsSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("Account ID to audit"),
      since_date: z.string().describe("Start date for audit window (YYYY-MM-DD)"),
    },
  }, async ({ budget_id, account_id, since_date }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Audit transactions for account "${account_id}" in budget "${budget_id}" since ${since_date}. Follow these steps:`,
            "",
            "1. Fetch transactions using list_account_transactions with the given since_date.",
            "2. Flag any uncategorized transactions (no category assigned).",
            "3. Flag any unapproved transactions.",
            "4. Look for possible duplicates: same payee + same amount within 3 days of each other.",
            "5. Identify unusually large transactions (more than 3x the median amount for that payee).",
            "6. Present findings grouped by issue type, with transaction details (date, payee, amount, memo).",
          ].join("\n"),
        },
      },
    ],
  }));

  server.registerPrompt("budget-setup-guide", {
    title: "Budget Setup Guide",
    description:
      "Guided walkthrough for setting up a new or existing budget: accounts, categories, targets, and scheduled transactions",
    argsSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
  }, async ({ budget_id }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Walk me through setting up budget "${budget_id}". Check each area and suggest improvements:`,
            "",
            "1. List all accounts and check if any are missing or need to be closed.",
            "2. Review category groups and categories -- suggest any that might be missing for a typical household budget.",
            "3. Check which categories have spending targets/goals set, and which don't but probably should.",
            "4. Review scheduled transactions -- are recurring bills covered?",
            "5. Check the current month's To Be Budgeted amount and suggest how to allocate unbudgeted funds.",
            "",
            "Ask me questions along the way if you need clarification about my financial situation.",
          ].join("\n"),
        },
      },
    ],
  }));

  server.registerPrompt("spending-analysis", {
    title: "Spending Analysis",
    description:
      "Analyze spending patterns: category breakdown, budget vs. actual, and top payees",
    argsSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month to analyze (YYYY-MM-DD, first of month, e.g. 2026-03-01)"),
    },
  }, async ({ budget_id, month }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Analyze spending for budget "${budget_id}", month ${month}:`,
            "",
            "1. Fetch the month detail to get all category activity.",
            "2. Rank categories by spending (highest activity first), excluding internal transfers and credit card payments.",
            "3. For each major spending category, show budgeted vs. actual and the variance (over/under).",
            "4. Fetch transactions for the month and identify the top 10 payees by total spend.",
            "5. Calculate total income vs. total spending for the month.",
            "6. Provide a brief summary of spending health and any areas of concern.",
          ].join("\n"),
        },
      },
    ],
  }));

  server.registerPrompt("credit-card-audit", {
    title: "Credit Card Payment Audit",
    description:
      "Audit that each credit card's running balance matches its payment category's available balance, with optional auto-fix",
    argsSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      since_month: z.string().optional().describe("Only audit months on or after this date (YYYY-MM-DD, first of month)"),
    },
  }, async ({ budget_id, since_month }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Audit credit card payment categories for budget "${budget_id}"${since_month ? ` since ${since_month}` : ""}:`,
            "",
            `1. Run audit_credit_card_payments with budget_id="${budget_id}"${since_month ? `, since_month="${since_month}"` : ""}, apply=false (dry run first).`,
            "2. Present the results clearly, explaining any mismatches found.",
            "3. For each mismatch, explain what it means: the payment category doesn't have enough budgeted to cover the card balance.",
            "4. If there are mismatches, ask me whether I'd like to apply the corrections automatically.",
            "5. Only if I confirm, run the audit again with apply=true to fix the mismatches.",
            "",
            "Important: Always do the dry run first and get my approval before making any changes.",
          ].join("\n"),
        },
      },
    ],
  }));
}
