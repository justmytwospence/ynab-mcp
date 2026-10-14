import { BudgetModel, SUB_CENT, addMonths, type Leg } from "./budget-model.js";

/**
 * Category suggestions from your own history, no model involved.
 *
 * A payee whose past spending lands in one category is obvious. A payee that
 * spans categories (Apple, Amazon, PayPal) is often still obvious per amount:
 * a $0.99 charge from Apple on the 5th is the same subscription every month.
 * Everything else is returned as ambiguous with the leading candidates, for a
 * person or an agent to decide.
 */

export interface Candidate {
  categoryId: string;
  label: string;
  share: number;
  count: number;
}

export interface Suggestion {
  transactionId: string;
  date: string;
  amount: number;
  payee: string;
  account: string;
  memo: string | null;
  /** The category it has now (YNAB's own guess for imported transactions), if any. */
  currentCategoryId: string | null;
  currentLabel: string | null;
  approved: boolean;
  reason: "uncategorized" | "unapproved";
  suggestion: Candidate | null;
  /** "amount": same payee and amount; "payee": payee alone. */
  basis: "amount" | "payee" | null;
  confidence: number;
  obvious: boolean;
  /** True when the suggestion differs from the current category. */
  changes: boolean;
  candidates: Candidate[];
}

export interface CategorizeOptions {
  /** History window in months (default 24). */
  historyMonths?: number;
  /** Minimum agreeing past transactions for an obvious call (default 3). */
  minCount?: number;
  /** Minimum share of the payee's (or payee+amount's) history (default 0.9). */
  minShare?: number;
  includeUnapproved?: boolean;
}

export function suggestCategories(model: BudgetModel, options: CategorizeOptions = {}): Suggestion[] {
  const { historyMonths = 24, minCount = 3, minShare = 0.9, includeUnapproved = true } = options;
  const since = addMonths(model.currentMonth, -historyMonths);
  const uncategorizedId = model.uncategorizedId;
  const usable = (id: string | null): id is string => {
    if (!id || id === uncategorizedId || model.internalIds.has(id)) return false;
    const c = model.categories.get(id);
    return Boolean(c && !c.hidden && !c.deleted);
  };

  // History: approved, categorized, non-transfer spending.
  const byPayee = new Map<string, Leg[]>();
  for (const leg of model.legs) {
    if (!leg.approved || leg.isTransfer || leg.month < since || !usable(leg.categoryId) || !leg.payeeId) continue;
    const list = byPayee.get(leg.payeeId) ?? [];
    list.push(leg);
    byPayee.set(leg.payeeId, list);
  }

  const tally = (legs: Leg[]): Candidate[] => {
    const counts = new Map<string, number>();
    for (const l of legs) counts.set(l.categoryId!, (counts.get(l.categoryId!) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([categoryId, count]) => ({ categoryId, label: model.categoryLabel(categoryId), count, share: count / legs.length }))
      .sort((a, b) => b.count - a.count);
  };

  const result: Suggestion[] = [];
  for (const leg of model.legs) {
    if (leg.isTransfer || leg.isSplitLeg || !model.isOnBudget(leg.accountId)) continue;
    const uncategorized = !leg.categoryId || leg.categoryId === uncategorizedId;
    // Uncategorized inflows are income to Ready to Assign, which needs no category.
    if (uncategorized && leg.amount >= 0) continue;
    const reason = uncategorized ? "uncategorized" : !leg.approved && includeUnapproved ? "unapproved" : null;
    if (!reason) continue;

    const history = (leg.payeeId && byPayee.get(leg.payeeId)) || [];
    const sameAmount = history.filter((h) => Math.abs(h.amount - leg.amount) < SUB_CENT);
    const byAmount = tally(sameAmount);
    const byPayeeOnly = tally(history);

    let suggestion: Candidate | null = null;
    let basis: Suggestion["basis"] = null;
    if (byAmount[0] && byAmount[0].count >= 2 && byAmount[0].share >= minShare) {
      suggestion = byAmount[0];
      basis = "amount";
    } else if (byPayeeOnly[0]) {
      suggestion = byPayeeOnly[0];
      basis = "payee";
    }
    const obvious = Boolean(
      suggestion &&
        ((basis === "amount" && suggestion.count >= 2) || (basis === "payee" && suggestion.count >= minCount)) &&
        suggestion.share >= minShare
    );

    result.push({
      transactionId: leg.transactionId,
      date: leg.date,
      amount: leg.amount,
      payee: leg.payeeName,
      account: model.accounts.get(leg.accountId)?.name ?? leg.accountId,
      memo: leg.memo,
      currentCategoryId: uncategorized ? null : leg.categoryId,
      currentLabel: uncategorized ? null : model.categoryLabel(leg.categoryId!),
      approved: leg.approved,
      reason,
      suggestion,
      basis,
      confidence: suggestion?.share ?? 0,
      obvious,
      changes: Boolean(suggestion && suggestion.categoryId !== leg.categoryId),
      candidates: (basis === "amount" ? byAmount : byPayeeOnly).slice(0, 3),
    });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
