import { getClient } from "../../ynab-client.js";
import { formatCurrency } from "../../utils/formatting.js";

export interface MergeResult {
  output: string;
  apiCalls: number;
  executed: boolean;
  sourceName: string;
  targetName: string;
  transactionsMoved: number;
  monthsAdjusted: number;
  skippedTransactions: number;
  uninspectedOldMonths: number;
}

// YNAB rejects writes to dates over 5 years old. Use a 7-day buffer to avoid
// edge cases around the rolling window.
function fiveYearCutoff(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Re-categorizes all transactions on the source category to the target and
 * moves all historical budgeted amounts. When dryRun is true, no writes occur.
 */
export async function performCategoryMerge(
  budgetId: string,
  sourceCategoryId: string,
  targetCategoryId: string,
  dryRun: boolean
): Promise<MergeResult> {
  let apiCalls = 0;

  const [sourceRes, targetRes] = await Promise.all([
    getClient().categories.getCategoryById(budgetId, sourceCategoryId),
    getClient().categories.getCategoryById(budgetId, targetCategoryId),
  ]);
  apiCalls += 2;

  const sourceCat = sourceRes.data.category;
  const targetCat = targetRes.data.category;

  const cutoff = fiveYearCutoff();

  const txnRes = await getClient().transactions.getTransactionsByCategory(
    budgetId, sourceCategoryId
  );
  apiCalls += 1;
  const allTransactions = txnRes.data.transactions;
  const transactions = allTransactions.filter((t) => t.date >= cutoff);
  const skippedTransactions = allTransactions.length - transactions.length;

  const monthsRes = await getClient().months.getPlanMonths(budgetId);
  apiCalls += 1;
  const allMonths = monthsRes.data.months.filter((m) => m.month >= cutoff);
  const uninspectedOldMonths = monthsRes.data.months.length - allMonths.length;

  const monthsToAdjust: Array<{
    month: string;
    sourceBudgeted: number;
    targetBudgeted: number;
  }> = [];

  for (const monthSummary of allMonths) {
    const monthDetail = await getClient().months.getPlanMonth(budgetId, monthSummary.month);
    apiCalls += 1;

    const categories = monthDetail.data.month.categories ?? [];
    const sourceMonthCat = categories.find((c) => c.id === sourceCategoryId);
    const targetMonthCat = categories.find((c) => c.id === targetCategoryId);

    if (sourceMonthCat && sourceMonthCat.budgeted !== 0) {
      monthsToAdjust.push({
        month: monthSummary.month,
        sourceBudgeted: sourceMonthCat.budgeted,
        targetBudgeted: targetMonthCat?.budgeted ?? 0,
      });
    }
  }

  const projectedUpdateCalls =
    (transactions.length > 0 ? 1 : 0) +
    monthsToAdjust.length * 2;

  const skipParts: string[] = [];
  if (skippedTransactions > 0) {
    skipParts.push(`${skippedTransactions} transaction(s) older than 5 years remain on "${sourceCat.name}"`);
  }
  if (uninspectedOldMonths > 0) {
    skipParts.push(`${uninspectedOldMonths} month(s) prior to the 5-year cutoff were not inspected (YNAB rejects writes to dates that old) and may still hold budget allocations on "${sourceCat.name}"`);
  }
  const skipNote = skipParts.length > 0
    ? `\nNot migrated (YNAB API 5-year write constraint):\n  - ${skipParts.join("\n  - ")}\nIf any of these exist, they will block deletion in the YNAB app until edited manually.`
    : "";

  if (dryRun) {
    const lines = [
      `[DRY RUN] Merge "${sourceCat.name}" -> "${targetCat.name}"`,
      ``,
      `Transactions to re-categorize: ${transactions.length}`,
      `Monthly budgets to adjust: ${monthsToAdjust.length} months`,
    ];

    if (skipNote) lines.push(skipNote);
    lines.push(``);

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
    lines.push(`Additional calls needed to execute: ${transactions.length > 0 ? 1 : 0} (transactions) + ${monthsToAdjust.length * 2} (budget updates) = ${projectedUpdateCalls}`);
    lines.push(`Total estimated: ${apiCalls + projectedUpdateCalls}`);

    return {
      output: lines.join("\n"),
      apiCalls,
      executed: false,
      sourceName: sourceCat.name,
      targetName: targetCat.name,
      transactionsMoved: 0,
      monthsAdjusted: 0,
      skippedTransactions,
      uninspectedOldMonths,
    };
  }

  let transactionsMoved = 0;
  if (transactions.length > 0) {
    await getClient().transactions.updateTransactions(budgetId, {
      transactions: transactions.map((t) => ({
        id: t.id,
        category_id: targetCategoryId,
      })),
    });
    apiCalls += 1;
    transactionsMoved = transactions.length;
  }

  let monthsAdjusted = 0;
  for (const m of monthsToAdjust) {
    const newTargetBudgeted = m.targetBudgeted + m.sourceBudgeted;

    await getClient().categories.updateMonthCategory(
      budgetId, m.month, targetCategoryId,
      { category: { budgeted: newTargetBudgeted } }
    );
    apiCalls += 1;

    await getClient().categories.updateMonthCategory(
      budgetId, m.month, sourceCategoryId,
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
  ];
  if (skipNote) lines.push(skipNote);
  lines.push(`Total API calls used: ${apiCalls}`);

  return {
    output: lines.join("\n"),
    apiCalls,
    executed: true,
    sourceName: sourceCat.name,
    targetName: targetCat.name,
    transactionsMoved,
    monthsAdjusted,
    skippedTransactions,
    uninspectedOldMonths,
  };
}
