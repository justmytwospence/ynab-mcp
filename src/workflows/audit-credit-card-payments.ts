import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

export function registerCreditCardAuditTools(server: McpServer) {
  server.registerTool("audit_credit_card_payments", {
    title: "Audit Credit Card Payments",
    description:
      "[Variable API calls] [Workflow] Audits credit card payment categories by comparing each card's month-end balance " +
      "against the payment category's available balance. Recommends exact budgeted amount corrections, accounting for " +
      "cascading effects across months. Audit costs 3 + C + M API calls (C = credit cards, M = months). " +
      "Set apply=true to automatically fix mismatches (adds 1 API call per mismatch).",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      since_month: z.string().optional().describe("Only audit months on or after this date (YYYY-MM-DD, first of month)"),
      account_id: z.string().optional().describe("Audit a specific credit card account only (by account ID)"),
      apply: z.boolean().default(false).describe("Apply recommended corrections automatically (default: false, audit only)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, since_month, account_id, apply }) => {
    try {
      let apiCalls = 0;

      // Step 1: Fetch accounts, categories, and months in parallel
      const [accountsRes, categoriesRes, monthsRes] = await Promise.all([
        getClient().accounts.getAccounts(budget_id),
        getClient().categories.getCategories(budget_id),
        getClient().months.getPlanMonths(budget_id),
      ]);
      apiCalls += 3;

      // Step 2: Filter to credit card accounts
      let creditCards = accountsRes.data.accounts.filter(
        (a) => a.type === "creditCard" && !a.closed
      );

      if (account_id) {
        creditCards = creditCards.filter((a) => a.id === account_id);
        if (creditCards.length === 0) {
          return errorResult(
            `Account ${account_id} not found or is not an open credit card account.`
          );
        }
      }

      if (creditCards.length === 0) {
        return textResult("No open credit card accounts found.");
      }

      // Step 3: Map credit card accounts to their payment categories
      const ccPaymentGroup = categoriesRes.data.category_groups.find(
        (g) => g.name === "Credit Card Payments"
      );

      if (!ccPaymentGroup) {
        return errorResult("Credit Card Payments category group not found.");
      }

      const cardCategoryMap = new Map<string, { accountName: string; categoryId: string }>();
      const unmatchedCards: string[] = [];

      for (const card of creditCards) {
        const matchingCategory = ccPaymentGroup.categories.find(
          (c) => c.name === card.name
        );
        if (matchingCategory) {
          cardCategoryMap.set(card.id, {
            accountName: card.name,
            categoryId: matchingCategory.id,
          });
        } else {
          unmatchedCards.push(card.name);
        }
      }

      // Step 4: Filter and sort months chronologically
      let months = monthsRes.data.months
        .map((m) => m.month)
        .sort();

      if (since_month) {
        months = months.filter((m) => m >= since_month);
      }

      if (months.length === 0) {
        return textResult("No months found in the specified range.");
      }

      const earliestMonth = months[0];

      // Step 5: Fetch transactions per card and month details in parallel
      const cardIds = Array.from(cardCategoryMap.keys());

      const [transactionResults, monthDetailResults] = await Promise.all([
        Promise.all(
          cardIds.map((cardId) =>
            getClient().transactions.getTransactionsByAccount(
              budget_id,
              cardId,
              since_month || earliestMonth
            )
          )
        ),
        Promise.all(
          months.map((month) =>
            getClient().months.getPlanMonth(budget_id, month)
          )
        ),
      ]);
      apiCalls += cardIds.length + months.length;

      // Index transactions by card ID
      const transactionsByCard = new Map<string, typeof transactionResults[0]["data"]["transactions"]>();
      cardIds.forEach((cardId, i) => {
        transactionsByCard.set(cardId, transactionResults[i].data.transactions);
      });

      // Index month details by month string
      const monthDetails = new Map<string, typeof monthDetailResults[0]["data"]["month"]>();
      months.forEach((month, i) => {
        monthDetails.set(month, monthDetailResults[i].data.month);
      });

      // Step 6: Audit each card
      const lines: string[] = [];
      let totalMismatches = 0;
      const corrections: Array<{ month: string; categoryId: string; budgeted: number }> = [];

      if (since_month) {
        lines.push(`Credit Card Payment Audit (since ${since_month})`);
      } else {
        lines.push(`Credit Card Payment Audit`);
      }

      for (const card of creditCards) {
        const cardId = card.id;
        const mapped = cardCategoryMap.get(cardId);
        if (!mapped) continue;
        const { accountName, categoryId } = mapped;
        const transactions = transactionsByCard.get(cardId) || [];

        // Sum transaction amounts by month (YYYY-MM)
        const monthTotals = new Map<string, number>();
        for (const txn of transactions) {
          const txnMonth = txn.date.substring(0, 7); // YYYY-MM
          monthTotals.set(txnMonth, (monthTotals.get(txnMonth) ?? 0) + txn.amount);
        }

        // Compute ending balance for each month by working backwards from current account balance.
        // current balance = ending balance after all transactions to date.
        // ending_balance(M) = current_balance - sum(transactions after month M)
        const endingBalanceByMonth = new Map<string, number>();
        let runningBalance = card.balance; // current account balance (milliunits, negative for CC)

        // Walk months in reverse, peeling off each month's transactions
        for (let i = months.length - 1; i >= 0; i--) {
          const monthKey = months[i].substring(0, 7);
          endingBalanceByMonth.set(monthKey, runningBalance);
          const monthTotal = monthTotals.get(monthKey) ?? 0;
          runningBalance -= monthTotal; // remove this month's activity to get prior month's ending balance
        }

        lines.push(``);
        lines.push(`=== ${accountName} ===`);

        let cumulativeDelta = 0;
        let cardMismatches = 0;

        for (const month of months) {
          const monthKey = month.substring(0, 7); // YYYY-MM from YYYY-MM-DD
          const monthDetail = monthDetails.get(month);
          const categories = monthDetail?.categories ?? [];
          const monthCategory = categories.find((c) => c.id === categoryId);

          if (!monthCategory) {
            lines.push(`  ${monthKey}: Category data not found`);
            continue;
          }

          const currentBudgeted = monthCategory.budgeted;
          const currentBalance = monthCategory.balance;

          const cardEndingBalance = endingBalanceByMonth.get(monthKey);
          if (cardEndingBalance === undefined) {
            lines.push(`  ${monthKey}: No balance data`);
            continue;
          }

          // Card balance is negative (liability); amount owed is the absolute value
          const amountOwed = Math.abs(cardEndingBalance);

          // Effective balance after accounting for prior corrections
          const effectiveBalance = currentBalance + cumulativeDelta;

          // Gap between what's available and what's owed
          const gap = amountOwed - effectiveBalance;

          if (Math.abs(gap) > 10) {
            // Mismatch
            const recommendedBudgeted = currentBudgeted + gap;
            const sign = gap > 0 ? "+" : "";

            lines.push(
              `  ${monthKey}: Owed ${formatCurrency(amountOwed)} | ` +
              `Budgeted ${formatCurrency(currentBudgeted)} | ` +
              `Available ${formatCurrency(currentBalance)} | MISMATCH`
            );
            lines.push(
              `           -> Change budgeted to ${formatCurrency(recommendedBudgeted)} ` +
              `(${sign}${formatCurrency(gap)})`
            );

            if (cumulativeDelta !== 0) {
              lines.push(
                `              (includes ${formatCurrency(cumulativeDelta)} cascading from prior corrections)`
              );
            }

            corrections.push({ month, categoryId, budgeted: recommendedBudgeted });
            cumulativeDelta += gap;
            cardMismatches++;
            totalMismatches++;
          } else {
            lines.push(
              `  ${monthKey}: Owed ${formatCurrency(amountOwed)} | ` +
              `Budgeted ${formatCurrency(currentBudgeted)} | ` +
              `Available ${formatCurrency(effectiveBalance)} | OK`
            );
          }
        }

        if (cardMismatches === 0) {
          lines.push(`  All months OK`);
        }
      }

      if (unmatchedCards.length > 0) {
        lines.push(``);
        lines.push(`Warnings:`);
        for (const name of unmatchedCards) {
          lines.push(`  - "${name}": No matching payment category found, skipped`);
        }
      }

      // Step 7: Apply corrections if requested
      if (apply && corrections.length > 0) {
        lines.push(``);
        lines.push(`Applying ${corrections.length} correction(s)...`);

        for (const { month, categoryId: catId, budgeted } of corrections) {
          await getClient().categories.updateMonthCategory(budget_id, month, catId, {
            category: { budgeted },
          });
          apiCalls += 1;
        }

        lines.push(`Applied ${corrections.length} correction(s) successfully.`);
      } else if (!apply && corrections.length > 0) {
        lines.push(``);
        lines.push(`Set apply=true to automatically fix these ${corrections.length} mismatch(es).`);
      }

      lines.push(``);
      lines.push(
        `Summary: ${cardIds.length} card(s), ${months.length} month(s), ${totalMismatches} mismatch(es)`
      );
      lines.push(`API calls used: ${apiCalls}`);

      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
