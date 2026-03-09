import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

export function registerWorkflowTools(server: McpServer) {
  server.registerTool("merge_category", {
    title: "Merge Category",
    description:
      "[Variable API calls] [Workflow] Merges a source category into a target category: re-categorizes all transactions and moves all historical budgeted amounts. " +
      "Dry run costs 4 + N calls (N = number of budget months). Execution costs additional 1 + 2*M calls (M = months with non-zero budgets). " +
      "Defaults to dry_run=true to preview changes before executing. " +
      "After merging, the source category will have zero transactions and zero budgeted amounts across all months - you can then manually hide/delete it in the YNAB app.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      source_category_id: z.string().describe("Category ID to merge FROM (will be emptied)"),
      target_category_id: z.string().describe("Category ID to merge INTO (will receive transactions and budgeted amounts)"),
      dry_run: z.boolean().default(true).describe("Preview changes without executing (default: true)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, source_category_id, target_category_id, dry_run }) => {
    try {
      let apiCalls = 0;

      // Step 1: Validate both categories exist
      const [sourceRes, targetRes] = await Promise.all([
        getClient().categories.getCategoryById(budget_id, source_category_id),
        getClient().categories.getCategoryById(budget_id, target_category_id),
      ]);
      apiCalls += 2;

      const sourceCat = sourceRes.data.category;
      const targetCat = targetRes.data.category;

      // Step 2: Get all transactions for source category
      const txnRes = await getClient().transactions.getTransactionsByCategory(
        budget_id, source_category_id
      );
      apiCalls += 1;

      const transactions = txnRes.data.transactions;

      // Step 3: Get all months and find which ones have non-zero source budget
      const monthsRes = await getClient().months.getPlanMonths(budget_id);
      apiCalls += 1;

      const allMonths = monthsRes.data.months;

      // For each month, we need to check the source category's budgeted amount.
      // get_month returns all categories in one call, which is more efficient
      // than calling get_month_category for each month individually.
      const monthsToAdjust: Array<{
        month: string;
        sourceBudgeted: number;
        targetBudgeted: number;
      }> = [];

      for (const monthSummary of allMonths) {
        const monthDetail = await getClient().months.getPlanMonth(budget_id, monthSummary.month);
        apiCalls += 1;

        const categories = monthDetail.data.month.categories ?? [];
        const sourceMonthCat = categories.find((c) => c.id === source_category_id);
        const targetMonthCat = categories.find((c) => c.id === target_category_id);

        if (sourceMonthCat && sourceMonthCat.budgeted !== 0) {
          monthsToAdjust.push({
            month: monthSummary.month,
            sourceBudgeted: sourceMonthCat.budgeted,
            targetBudgeted: targetMonthCat?.budgeted ?? 0,
          });
        }
      }

      // Calculate estimated total API calls for the full operation
      const updateCalls = dry_run ? 0 : (
        (transactions.length > 0 ? 1 : 0) + // bulk update transactions
        monthsToAdjust.length * 2 // update target + zero source per month
      );
      const totalEstimatedCalls = apiCalls + updateCalls;

      if (dry_run) {
        const lines = [
          `[DRY RUN] Merge "${sourceCat.name}" -> "${targetCat.name}"`,
          ``,
          `Transactions to re-categorize: ${transactions.length}`,
          `Monthly budgets to adjust: ${monthsToAdjust.length} months`,
          ``,
        ];

        if (monthsToAdjust.length > 0) {
          lines.push(`Budget adjustments:`);
          for (const m of monthsToAdjust) {
            lines.push(
              `  ${m.month}: ${formatCurrency(m.sourceBudgeted)} from "${sourceCat.name}" -> "${targetCat.name}" (currently ${formatCurrency(m.targetBudgeted)}, would become ${formatCurrency(m.targetBudgeted + m.sourceBudgeted)})`
            );
          }
          lines.push(``);
        }

        lines.push(`API calls used so far: ${apiCalls}`);
        lines.push(`Additional calls needed to execute: ${transactions.length > 0 ? 1 : 0} (transactions) + ${monthsToAdjust.length * 2} (budget updates) = ${updateCalls}`);
        lines.push(`Total estimated: ${totalEstimatedCalls}`);
        lines.push(``);
        lines.push(`Set dry_run=false to execute.`);

        return textResult(lines.join("\n"));
      }

      // Execute: re-categorize transactions
      let transactionsMoved = 0;
      if (transactions.length > 0) {
        await getClient().transactions.updateTransactions(budget_id, {
          transactions: transactions.map((t) => ({
            id: t.id,
            category_id: target_category_id,
          })),
        });
        apiCalls += 1;
        transactionsMoved = transactions.length;
      }

      // Execute: move budgeted amounts
      let monthsAdjusted = 0;
      for (const m of monthsToAdjust) {
        const newTargetBudgeted = m.targetBudgeted + m.sourceBudgeted;

        await getClient().categories.updateMonthCategory(
          budget_id, m.month, target_category_id,
          { category: { budgeted: newTargetBudgeted } }
        );
        apiCalls += 1;

        await getClient().categories.updateMonthCategory(
          budget_id, m.month, source_category_id,
          { category: { budgeted: 0 } }
        );
        apiCalls += 1;

        monthsAdjusted += 1;
      }

      const lines = [
        `Merged "${sourceCat.name}" -> "${targetCat.name}"`,
        ``,
        `Transactions re-categorized: ${transactionsMoved}`,
        `Monthly budgets adjusted: ${monthsAdjusted}`,
        `Total API calls used: ${apiCalls}`,
        ``,
        `"${sourceCat.name}" now has zero transactions and zero budgeted amounts.`,
        `You can hide or delete it manually in the YNAB app.`,
      ];

      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
