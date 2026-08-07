import { getClient } from "../../ynab-client.js";
import { formatCurrency } from "../../utils/formatting.js";
import { getBudgetSnapshot, invalidateBudgetSnapshot, snapshotMonths } from "../../budget-snapshot.js";

export interface MergeResult {
  output: string;
  apiCalls: number;
  executed: boolean;
  sourceName: string;
  targetName: string;
  transactionsMoved: number;
  monthsAdjusted: number;
  /** Whole transactions eligible to move (before any write failures). */
  transactionsTotal: number;
  /** Months holding a non-zero source budget (before any write failures). */
  monthsTotal: number;
  skippedTransactions: number;
  uninspectedOldMonths: number;
  /** Split legs the API cannot re-categorize; always left in place. */
  splitLegs: number;
  /** Writes that failed and were left unchanged, as human-readable reasons. */
  failures: string[];
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
 *
 * The preview reads the whole budget in a single cached request, so it costs 1
 * API call regardless of how many months the budget spans.
 *
 * Throws when the merge cannot be attempted at all (unknown, deleted, internal,
 * or identical categories). Individual write failures are reported in the
 * result rather than thrown, so a partial merge is never lost.
 */
export async function performCategoryMerge(
  budgetId: string,
  sourceCategoryId: string,
  targetCategoryId: string,
  dryRun: boolean
): Promise<MergeResult> {
  // Reject a self-merge before spending any calls. Merging a category into
  // itself would double its budgeted amount and then immediately zero it,
  // wiping every month with a non-zero budget.
  if (sourceCategoryId === targetCategoryId) {
    throw new Error(
      "source and target are the same category. Merging a category into " +
        "itself would zero out its budget in every month."
    );
  }

  // One request covers categories, groups, transactions, subtransactions,
  // and every month's per-category budgeted amount.
  const { snapshot, apiCalls: readCalls } = await getBudgetSnapshot(budgetId);
  let apiCalls = readCalls;
  const plan = snapshot.plan;

  const categories = plan.categories ?? [];
  const sourceCat = categories.find((c) => c.id === sourceCategoryId);
  const targetCat = categories.find((c) => c.id === targetCategoryId);

  if (!sourceCat) throw new Error(`Source category ${sourceCategoryId} not found in this budget.`);
  if (!targetCat) throw new Error(`Target category ${targetCategoryId} not found in this budget.`);
  if (sourceCat.deleted) throw new Error(`Source category "${sourceCat.name}" is deleted; there is nothing to merge.`);
  if (targetCat.deleted) throw new Error(`Target category "${targetCat.name}" is deleted and cannot receive a merge.`);

  // Internal groups hold Credit Card Payment categories and Inflow: Ready to
  // Assign. The API rejects writes to them, and it would do so partway through
  // the sequential loop, after some months had been rewritten.
  const internalGroupIds = new Set(
    (plan.category_groups ?? []).filter((g) => g.internal).map((g) => g.id)
  );
  if (internalGroupIds.has(targetCat.category_group_id)) {
    throw new Error(
      `Target category "${targetCat.name}" belongs to an internal category group ` +
        `(Credit Card Payments or Inflow: Ready to Assign). The API does not permit assigning ` +
        `transactions to it.`
    );
  }
  if (internalGroupIds.has(sourceCat.category_group_id)) {
    throw new Error(
      `Source category "${sourceCat.name}" belongs to an internal category group and cannot be merged.`
    );
  }

  const cutoff = fiveYearCutoff();

  // Transactions to move. Split legs are subtransactions: the API cannot update
  // subtransactions on an existing split, and a bulk update keyed by the
  // subtransaction id would silently address the wrong record.
  const sourceTransactions = (plan.transactions ?? []).filter(
    (t) => !t.deleted && t.category_id === sourceCategoryId
  );
  const transactions = sourceTransactions.filter((t) => t.date >= cutoff);
  const skippedTransactions = sourceTransactions.length - transactions.length;

  const parentById = new Map((plan.transactions ?? []).map((t) => [t.id, t]));
  const splitLegs = (plan.subtransactions ?? []).filter(
    (s) => !s.deleted && s.category_id === sourceCategoryId
  );

  // Months where the source category holds a budgeted amount.
  const allMonths = snapshotMonths(snapshot);
  const months = allMonths.filter((m) => m.month >= cutoff);
  const uninspectedOldMonths = allMonths.length - months.length;

  const monthsToAdjust: Array<{ month: string; sourceBudgeted: number; targetBudgeted: number }> = [];
  for (const month of months) {
    const sourceMonthCat = month.categories.find((c) => c.id === sourceCategoryId);
    if (!sourceMonthCat || sourceMonthCat.budgeted === 0) continue;
    const targetMonthCat = month.categories.find((c) => c.id === targetCategoryId);
    monthsToAdjust.push({
      month: month.month,
      sourceBudgeted: sourceMonthCat.budgeted,
      targetBudgeted: targetMonthCat?.budgeted ?? 0,
    });
  }

  const writeCalls = (transactions.length > 0 ? 1 : 0) + monthsToAdjust.length * 2;

  const splitLines = (indent: string) =>
    splitLegs.map((leg) => {
      const parent = parentById.get(leg.transaction_id);
      const where = parent ? `${parent.date} ` : "";
      return `${indent}${where}${formatCurrency(leg.amount)} (split leg of transaction ${leg.transaction_id})`;
    });

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

    if (splitLegs.length > 0) {
      lines.push(
        `Cannot be moved: ${splitLegs.length} split transaction leg(s). The API does not support`,
        `updating subtransactions on an existing split, so these must be re-categorized in the YNAB app:`,
        ...splitLines("  "),
        ``
      );
    }

    lines.push(`API calls used: ${apiCalls}`);
    lines.push(`Additional calls needed to execute: ${transactions.length > 0 ? 1 : 0} (transactions) + ${monthsToAdjust.length * 2} (budget updates) = ${writeCalls}`);

    return {
      output: lines.join("\n"),
      apiCalls,
      executed: false,
      sourceName: sourceCat.name,
      targetName: targetCat.name,
      transactionsMoved: 0,
      monthsAdjusted: 0,
      transactionsTotal: transactions.length,
      monthsTotal: monthsToAdjust.length,
      skippedTransactions,
      uninspectedOldMonths,
      splitLegs: splitLegs.length,
      failures: [],
    };
  }

  // Execute: re-categorize whole transactions.
  const failures: string[] = [];
  let transactionsMoved = 0;
  if (transactions.length > 0) {
    try {
      await getClient().transactions.updateTransactions(budgetId, {
        transactions: transactions.map((t) => ({
          id: t.id,
          category_id: targetCategoryId,
        })),
      });
      transactionsMoved = transactions.length;
    } catch (e: any) {
      failures.push(`transactions: ${e.message}`);
    }
    apiCalls += 1;
  }

  // Execute: move budgeted amounts, one month at a time. A failure part way
  // through leaves earlier months already written, so record exactly which
  // months landed rather than throwing the whole result away.
  let monthsAdjusted = 0;
  for (const m of monthsToAdjust) {
    try {
      await getClient().categories.updateMonthCategory(
        budgetId, m.month, targetCategoryId,
        { category: { budgeted: m.targetBudgeted + m.sourceBudgeted } }
      );
      apiCalls += 1;
      await getClient().categories.updateMonthCategory(
        budgetId, m.month, sourceCategoryId,
        { category: { budgeted: 0 } }
      );
      apiCalls += 1;
      monthsAdjusted += 1;
    } catch (e: any) {
      apiCalls += 1;
      failures.push(`${m.month}: ${e.message}`);
    }
  }

  invalidateBudgetSnapshot(budgetId);

  const lines = [
    `Merged "${sourceCat.name}" -> "${targetCat.name}"`,
    ``,
    `Transactions re-categorized: ${transactionsMoved} of ${transactions.length}`,
    `Monthly budgets adjusted: ${monthsAdjusted} of ${monthsToAdjust.length}`,
  ];
  if (skipNote) lines.push(skipNote);
  lines.push(`Total API calls used: ${apiCalls}`);

  if (splitLegs.length > 0) {
    lines.push(
      ``,
      `Not moved: ${splitLegs.length} split transaction leg(s), which the API cannot re-categorize.`,
      `Re-categorize these in the YNAB app:`,
      ...splitLines("  ")
    );
  }

  if (failures.length > 0) {
    lines.push(
      ``,
      `${failures.length} operation(s) failed and were left unchanged:`,
      ...failures.map((f) => `  - ${f}`),
      ``,
      `Everything not listed above was applied. Re-run to retry the failures.`
    );
  }

  return {
    output: lines.join("\n"),
    apiCalls,
    executed: true,
    sourceName: sourceCat.name,
    targetName: targetCat.name,
    transactionsMoved,
    monthsAdjusted,
    transactionsTotal: transactions.length,
    monthsTotal: monthsToAdjust.length,
    skippedTransactions,
    uninspectedOldMonths,
    splitLegs: splitLegs.length,
    failures,
  };
}
