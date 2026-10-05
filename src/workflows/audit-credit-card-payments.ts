import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type { AccountBase, CategoryBase, TransactionSummaryBase } from "ynab";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";
import {
  getBudgetSnapshot,
  internalCategoryIds,
  invalidateBudgetSnapshot,
  snapshotMonths,
  type BudgetSnapshot,
} from "../budget-snapshot.js";
import { describeError } from "../utils/errors.js";

const CREDIT_ACCOUNT_TYPES = new Set(["creditCard", "lineOfCredit"]);

/**
 * What the audit checks.
 *
 * The naive check - "the payment category's Available should equal the card
 * balance" - is only true for a card that started at zero and has never been
 * overspent on. Pre-YNAB debt and credit overspending break the equality by
 * construction, so on those budgets it fires every month forever.
 *
 * So instead of testing `gap == 0`, this audits the *change* in the gap:
 *
 *   owed(M)   = -(card balance at end of M)      // never abs; an overpaid card is negative
 *   funded(M) = payment category balance at end of M
 *   gap(M)    = owed(M) - funded(M)              // expected nonzero and roughly constant
 *   dGap(M)   = gap(M) - gap(M-1)                // this is what must be explainable
 *
 * Each month's dGap is attributed to named causes - Starting Balance debt
 * recorded that month, and credit overspending that month - and only the
 * unattributed residual is reported as a problem.
 */
interface MonthAudit {
  month: string;
  owed: number;
  funded: number;
  gap: number;
  dGap: number;
  startingBalanceDebt: number;
  creditOverspending: number;
  overspendingIsEstimate: boolean;
  residual: number;
  budgeted: number;
  activity: number;
  /** balance(M) - balance(M-1) - budgeted(M) - activity(M): money YNAB moved automatically. */
  autoMoved: number;
  toBeBudgeted: number;
}

export function registerCreditCardAuditTools(server: McpServer) {
  server.registerTool("audit_credit_card_payments", {
    title: "Audit Credit Card Payments",
    description:
      "[1 API call] [Workflow] Audits credit card and line-of-credit payment categories across every budget month. " +
      "Reads the whole budget in a single cached request. " +
      "A payment category's Available is NOT supposed to equal the card balance - pre-YNAB debt and credit " +
      "overspending make a permanent, legitimate gap. This audits the month-over-month CHANGE in that gap, " +
      "attributes each change to Starting Balance debt or credit overspending, and reports only the " +
      "unattributed residual, which is what 'the numbers drifted' actually means. " +
      "Set apply=true to correct residual months by adjusting the assigned amount (adds 1 API call per month).",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      since_month: z.string().optional().describe("Only audit months on or after this date (YYYY-MM-DD, first of month)"),
      account_id: z.string().optional().describe("Audit a specific credit account only (by account ID)"),
      include_closed: z.boolean().default(true).describe("Include closed cards, which still had balances in prior months (default: true)"),
      tolerance: z.number().default(0).describe("Ignore residuals at or below this many dollars (default: 0, exact)"),
      verbose: z.boolean().default(false).describe("Show every month, not just months with an unattributed residual"),
      apply: z.boolean().default(false).describe("Assign money to close the unattributed residual in each flagged month (default: false, audit only)"),
      allow_negative_ready_to_assign: z.boolean().default(false).describe("Permit corrections that drive a month's Ready to Assign below zero"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, since_month, account_id, include_closed, tolerance, verbose, apply, allow_negative_ready_to_assign }) => {
    try {
      const { snapshot, apiCalls: readCalls } = await getBudgetSnapshot(budget_id);
      let apiCalls = readCalls;
      const plan = snapshot.plan;
      const toleranceMilliunits = Math.abs(dollarsToMilliunits(tolerance));

      let cards = (plan.accounts ?? []).filter(
        (a) => !a.deleted && CREDIT_ACCOUNT_TYPES.has(a.type) && a.on_budget
      );
      if (!include_closed) cards = cards.filter((a) => !a.closed);
      if (account_id) {
        cards = cards.filter((a) => a.id === account_id);
        if (cards.length === 0) {
          return errorResult(
            `Account ${account_id} is not an on-budget credit card or line of credit in this budget` +
              (include_closed ? "." : ", or is closed (set include_closed=true).")
          );
        }
      }
      if (cards.length === 0) return textResult("No on-budget credit card or line of credit accounts found.");

      const allMonths = snapshotMonths(snapshot).map((m) => m.month);
      let months = allMonths;
      if (since_month) months = months.filter((m) => m >= since_month);
      if (months.length === 0) return textResult("No months found in the specified range.");

      // The gap is a level, not a signal: only its month-over-month change means
      // anything. So the first audited month needs the month before it to
      // subtract from. Without it, a since_month audit reports the whole
      // accumulated gap as a single drift event at the window boundary.
      const priorMonth = allMonths[allMonths.indexOf(months[0]!) - 1];

      const monthCategories = new Map<string, CategoryBase[]>(
        snapshotMonths(snapshot).map((m) => [m.month, m.categories])
      );
      const monthToBeBudgeted = new Map<string, number>(
        snapshotMonths(snapshot).map((m) => [m.month, m.to_be_budgeted])
      );

      const paymentCategoryIds = paymentCategoryIdsByCard(snapshot);
      const startingBalancePayeeIds = new Set(
        (plan.payees ?? []).filter((p) => p.name === "Starting Balance").map((p) => p.id)
      );
      const categorySpendByCard = spendByCardCategoryMonth(snapshot);

      const lines: string[] = [
        since_month ? `Credit Card Payment Audit (since ${since_month})` : `Credit Card Payment Audit`,
        `Months: ${months[0]} to ${months[months.length - 1]!} (${months.length})`,
      ];
      if (toleranceMilliunits > 0) lines.push(`Tolerance: ${formatCurrency(toleranceMilliunits)}`);

      const corrections: Correction[] = [];
      const warnings: string[] = [];
      let totalResidualMonths = 0;

      for (const card of cards) {
        const categoryId = paymentCategoryIds.get(card.id);
        lines.push(``, `=== ${card.name}${card.closed ? " (closed)" : ""} ===`);

        if (!categoryId) {
          warnings.push(`"${card.name}": no payment category could be identified, skipped`);
          lines.push(`  Skipped: no payment category could be identified for this account.`);
          continue;
        }

        const cardTransactions = (plan.transactions ?? []).filter(
          (t) => !t.deleted && t.account_id === card.id
        );

        const walk = forwardBalanceWalk(card, cardTransactions, priorMonth ? [priorMonth, ...months] : months);
        lines.push(
          `  Working balance ${formatCurrency(card.balance)} | ` +
            `Cleared ${formatCurrency(card.cleared_balance)} | Uncleared ${formatCurrency(card.uncleared_balance)}`
        );
        if (card.debt_original_balance != null && card.debt_original_balance !== 0) {
          lines.push(`  Pre-YNAB debt (debt_original_balance): ${formatCurrency(card.debt_original_balance)}`);
        }
        if (walk.unreconciled !== 0) {
          // The forward walk is self-validating: summing every transaction must
          // reproduce the account's working balance. If it does not, the
          // transaction set is incomplete and no reconstructed month-end
          // balance can be trusted.
          warnings.push(
            `"${card.name}": transactions sum to ${formatCurrency(walk.total)} but the account balance is ` +
              `${formatCurrency(card.balance)} (off by ${formatCurrency(walk.unreconciled)}), skipped`
          );
          lines.push(
            `  Skipped: the ${cardTransactions.length} transactions in this budget sum to ` +
              `${formatCurrency(walk.total)}, which does not match the account balance ` +
              `${formatCurrency(card.balance)}. Month-end balances cannot be reconstructed.`
          );
          continue;
        }
        if (walk.afterLastMonth !== 0) {
          lines.push(
            `  Note: ${formatCurrency(walk.afterLastMonth)} of transactions are dated after ` +
              `${months[months.length - 1]!} and are excluded from month-end balances.`
          );
        }

        const audits: MonthAudit[] = [];
        let previousGap: number | null = null;
        let previousBalance = 0;
        let cumulativeDelta = 0; // cascade from corrections made in earlier months

        // Seed from the month before the window so the first audited month
        // reports a change rather than a level. At the plan's genuine first
        // month there is nothing to seed from, and the level is correct: it is
        // the opening debt, which the Starting Balance term below accounts for.
        if (priorMonth) {
          const priorCategory = (monthCategories.get(priorMonth) ?? []).find((c) => c.id === categoryId);
          const priorBalance = walk.balanceAtEndOf.get(priorMonth);
          if (priorCategory && priorBalance !== undefined) {
            previousGap = -priorBalance - priorCategory.balance;
            previousBalance = priorCategory.balance;
          }
        }

        for (const month of months) {
          const categories = monthCategories.get(month) ?? [];
          const monthCategory = categories.find((c) => c.id === categoryId);
          if (!monthCategory) {
            warnings.push(`"${card.name}": no payment category data for ${month}, month skipped`);
            continue;
          }

          const owed = -walk.balanceAtEndOf.get(month)!;
          const funded = monthCategory.balance + cumulativeDelta;
          const gap = owed - funded;
          const dGap = previousGap === null ? gap : gap - previousGap;

          const startingBalanceDebt = -cardTransactions
            .filter((t) => inMonth(t, month) && t.payee_id != null && startingBalancePayeeIds.has(t.payee_id))
            .reduce((sum, t) => sum + t.amount, 0);

          const overspending = creditOverspending(categories, card.id, month, categorySpendByCard);

          const residual = dGap - startingBalanceDebt - overspending.amount;

          audits.push({
            month,
            owed,
            funded,
            gap,
            dGap,
            startingBalanceDebt,
            creditOverspending: overspending.amount,
            overspendingIsEstimate: overspending.isEstimate,
            residual,
            budgeted: monthCategory.budgeted,
            activity: monthCategory.activity,
            autoMoved: monthCategory.balance - previousBalance - monthCategory.budgeted - monthCategory.activity,
            toBeBudgeted: monthToBeBudgeted.get(month) ?? 0,
          });

          previousGap = gap;
          previousBalance = monthCategory.balance;

          if (Math.abs(residual) > toleranceMilliunits) {
            // Correct by moving the assigned amount, never below zero: the API
            // accepts a negative budgeted, but it is almost never what the user
            // means and it silently moves money out of the month.
            const recommended = Math.max(0, monthCategory.budgeted + residual);
            corrections.push({
              month,
              categoryId,
              budgeted: recommended,
              previousBudgeted: monthCategory.budgeted,
              cardName: card.name,
            });
            cumulativeDelta += recommended - monthCategory.budgeted;
            totalResidualMonths += 1;
          }
        }

        lines.push(...renderCard(audits, toleranceMilliunits, verbose));
      }

      if (warnings.length > 0) {
        lines.push(``, `Warnings:`);
        for (const w of warnings) lines.push(`  - ${w}`);
      }

      const { affordable, blocked } = allow_negative_ready_to_assign
        ? { affordable: corrections, blocked: [] as BlockedCorrection[] }
        : screenAffordability(corrections, months, monthToBeBudgeted);

      if (blocked.length > 0) {
        lines.push(
          ``,
          `${blocked.length} correction(s) skipped: assigning there would drive Ready to Assign below zero, ` +
            `in that month or a later one. Set allow_negative_ready_to_assign=true to apply them anyway.`
        );
        for (const b of blocked) {
          lines.push(
            `  - ${b.correction.month} (${b.correction.cardName}): ` +
              `+${formatCurrency(b.correction.budgeted - b.correction.previousBudgeted)} would leave ` +
              `${formatCurrency(b.worstReadyToAssign)} in ${b.worstMonth}`
          );
        }
      }

      if (apply && affordable.length > 0) {
        lines.push(``, `Applying ${affordable.length} correction(s)...`);
        const applied: string[] = [];
        const failed: string[] = [];

        for (const c of affordable) {
          try {
            await getClient().categories.updateMonthCategory(budget_id, c.month, c.categoryId, {
              category: { budgeted: c.budgeted },
            });
            applied.push(`${c.month} (${c.cardName}): assigned ${formatCurrency(c.budgeted)}`);
          } catch (e: unknown) {
            // Keep going: a failure part way through must not hide which months
            // were already rewritten.
            failed.push(`${c.month} (${c.cardName}): ${describeError(e)}`);
          }
          apiCalls += 1;
        }

        invalidateBudgetSnapshot(budget_id);
        lines.push(`Applied ${applied.length} of ${affordable.length}:`);
        for (const a of applied) lines.push(`  ${a}`);
        if (failed.length > 0) {
          lines.push(`Not applied (${failed.length}):`);
          for (const f of failed) lines.push(`  ${f}`);
          lines.push(`Months not listed as applied were left unchanged. Re-run to retry.`);
        }
      } else if (affordable.length > 0) {
        lines.push(
          ``,
          `Set apply=true to assign money in these ${affordable.length} month(s). This writes to historical ` +
            `months and lowers Ready to Assign in each one - review the residuals first.`
        );
      }

      lines.push(
        ``,
        `Summary: ${cards.length} account(s), ${months.length} month(s), ` +
          `${totalResidualMonths} month(s) with an unattributed residual`,
        `API calls used: ${apiCalls}`
      );

      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });
}

function inMonth(t: TransactionSummaryBase, month: string): boolean {
  return t.date.substring(0, 7) === month.substring(0, 7);
}

/**
 * Reconstruct each month's ending balance by accumulating transactions forward.
 *
 * A backward walk from the account's current balance silently absorbs any
 * future-dated transaction into the anchor, shifting every reconstructed month
 * by a constant. Accumulating forward is self-validating instead: the total of
 * all transactions must equal the account's working balance.
 */
function forwardBalanceWalk(card: AccountBase, transactions: TransactionSummaryBase[], months: string[]) {
  const byMonth = new Map<string, number>();
  let total = 0;
  for (const t of transactions) {
    total += t.amount;
    const key = t.date.substring(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + t.amount);
  }

  const lastMonth = months[months.length - 1]!.substring(0, 7);
  let afterLastMonth = 0;
  for (const [key, amount] of byMonth) {
    if (key > lastMonth) afterLastMonth += amount;
  }

  // Start from the first transaction, not from the first audited month, so a
  // since_month window still sees the balance the card had carried into it.
  const balanceAtEndOf = new Map<string, number>();
  const allKeys = Array.from(byMonth.keys()).sort();
  const firstKey = allKeys[0] ?? months[0]!.substring(0, 7);
  let running = 0;
  let cursor = firstKey;
  const monthKeys = months.map((m) => m.substring(0, 7));
  for (const key of dedupeSorted([...allKeys, ...monthKeys])) {
    if (key < cursor) continue;
    running += byMonth.get(key) ?? 0;
    balanceAtEndOf.set(key, running);
    cursor = key;
  }
  // Months before the card's first transaction have a zero balance.
  for (const month of months) {
    const key = month.substring(0, 7);
    if (!balanceAtEndOf.has(key)) balanceAtEndOf.set(key, key < firstKey ? 0 : running);
  }
  // Map back to the full YYYY-MM-DD month keys the caller uses.
  const byFullMonth = new Map<string, number>(
    months.map((m) => [m, balanceAtEndOf.get(m.substring(0, 7)) ?? 0])
  );

  return {
    balanceAtEndOf: byFullMonth,
    total,
    unreconciled: card.balance - total,
    afterLastMonth,
  };
}

function dedupeSorted(keys: string[]): string[] {
  return Array.from(new Set(keys)).sort();
}

interface Correction {
  month: string;
  categoryId: string;
  budgeted: number;
  previousBudgeted: number;
  cardName: string;
}

interface BlockedCorrection {
  correction: Correction;
  worstMonth: string;
  worstReadyToAssign: number;
}

/**
 * Refuse corrections the budget cannot fund.
 *
 * Assigning more in month M lowers Ready to Assign in M *and in every month
 * after it*, because the money is taken from the same pool that rolls forward.
 * So a correction that looks affordable against its own month can still drive a
 * later month negative, and several small corrections can do it together when
 * none of them would alone.
 *
 * Corrections are screened oldest first, each against the cascade of the ones
 * already accepted. A correction that lowers the assigned amount frees money and
 * is never blocked.
 */
export function screenAffordability(
  corrections: Correction[],
  months: string[],
  toBeBudgeted: Map<string, number>
): { affordable: Correction[]; blocked: BlockedCorrection[] } {
  const chronological = [...corrections].sort((a, b) => a.month.localeCompare(b.month));
  const affordable: Correction[] = [];
  const blocked: BlockedCorrection[] = [];

  for (const candidate of chronological) {
    // Lowering the assigned amount hands money back to Ready to Assign, so it
    // can never make a month worse - not even one that is already negative.
    if (candidate.budgeted <= candidate.previousBudgeted) {
      affordable.push(candidate);
      continue;
    }

    const deltaByMonth = new Map<string, number>();
    for (const c of [...affordable, candidate]) {
      deltaByMonth.set(c.month, (deltaByMonth.get(c.month) ?? 0) + (c.budgeted - c.previousBudgeted));
    }

    let cumulative = 0;
    let worstMonth = "";
    let worstReadyToAssign = Number.POSITIVE_INFINITY;
    for (const month of months) {
      cumulative += deltaByMonth.get(month) ?? 0;
      if (month < candidate.month) continue;
      const projected = (toBeBudgeted.get(month) ?? 0) - cumulative;
      if (projected < worstReadyToAssign) {
        worstReadyToAssign = projected;
        worstMonth = month;
      }
    }

    if (worstReadyToAssign < 0) {
      blocked.push({ correction: candidate, worstMonth, worstReadyToAssign });
    } else {
      affordable.push(candidate);
    }
  }

  return { affordable, blocked };
}

/**
 * Estimate the credit overspending that occurred in a month.
 *
 * When a spending category ends a month negative, the purchase money never
 * reached the payment category, which widens the gap legitimately. The API does
 * not say which card an overspent category was overspent on, so attribute at
 * most this card's own spending in that category. That is exact when one card
 * spent in the category and an estimate when several did.
 */
function creditOverspending(
  categories: CategoryBase[],
  cardId: string,
  month: string,
  spendByCard: Map<string, Map<string, Map<string, number>>>
): { amount: number; isEstimate: boolean } {
  const cardSpend = spendByCard.get(cardId)?.get(month);
  if (!cardSpend) return { amount: 0, isEstimate: false };

  let amount = 0;
  let isEstimate = false;
  for (const category of categories) {
    if (category.balance >= 0) continue;
    const spend = cardSpend.get(category.id);
    if (!spend) continue;
    amount += Math.min(-category.balance, spend);

    const anotherCardSpentHere = Array.from(spendByCard.entries()).some(
      ([otherId, byMonth]) => otherId !== cardId && (byMonth.get(month)?.get(category.id) ?? 0) > 0
    );
    if (anotherCardSpentHere) isEstimate = true;
  }
  return { amount, isEstimate };
}

/** cardId -> month (YYYY-MM-DD, first of month) -> categoryId -> amount spent. */
function spendByCardCategoryMonth(snapshot: BudgetSnapshot) {
  const plan = snapshot.plan;
  const cardIds = new Set(
    (plan.accounts ?? [])
      .filter((a) => !a.deleted && CREDIT_ACCOUNT_TYPES.has(a.type) && a.on_budget)
      .map((a) => a.id)
  );
  const legsByTransaction = new Map<string, typeof plan.subtransactions>();
  for (const leg of plan.subtransactions ?? []) {
    if (leg.deleted) continue;
    const legs = legsByTransaction.get(leg.transaction_id) ?? [];
    legs.push(leg);
    legsByTransaction.set(leg.transaction_id, legs);
  }

  const result = new Map<string, Map<string, Map<string, number>>>();
  const add = (cardId: string, month: string, categoryId: string | null | undefined, amount: number) => {
    if (!categoryId || amount >= 0) return; // only outflows are spending
    const byMonth = result.get(cardId) ?? new Map<string, Map<string, number>>();
    const byCategory = byMonth.get(month) ?? new Map<string, number>();
    byCategory.set(categoryId, (byCategory.get(categoryId) ?? 0) + -amount);
    byMonth.set(month, byCategory);
    result.set(cardId, byMonth);
  };

  for (const t of plan.transactions ?? []) {
    if (t.deleted || !cardIds.has(t.account_id)) continue;
    const month = `${t.date.substring(0, 7)}-01`;
    const legs = legsByTransaction.get(t.id);
    if (legs && legs.length > 0) {
      for (const leg of legs) add(t.account_id, month, leg.category_id, leg.amount);
    } else {
      add(t.account_id, month, t.category_id, t.amount);
    }
  }
  return result;
}

/**
 * Map each credit account to its payment category.
 *
 * The API exposes no account-to-payment-category key, but a payment transfer
 * into the card carries the payment category id, which is a real link rather
 * than a name guess. Fall back to matching the account name against the
 * categories flagged internal.
 */
function paymentCategoryIdsByCard(snapshot: BudgetSnapshot): Map<string, string> {
  const plan = snapshot.plan;
  const internalIds = internalCategoryIds(snapshot);

  const result = new Map<string, string>();
  for (const t of plan.transactions ?? []) {
    if (t.deleted || !t.transfer_account_id || !t.category_id) continue;
    if (!internalIds.has(t.category_id)) continue;
    if (!result.has(t.transfer_account_id)) result.set(t.transfer_account_id, t.category_id);
  }

  const cards = (plan.accounts ?? []).filter(
    (a) => !a.deleted && CREDIT_ACCOUNT_TYPES.has(a.type) && a.on_budget
  );
  for (const card of cards) {
    if (result.has(card.id)) continue;
    const named = (plan.categories ?? []).find(
      (c) => internalIds.has(c.id) && !c.deleted && c.name === card.name
    );
    if (named) result.set(card.id, named.id);
  }
  return result;
}

function renderCard(audits: MonthAudit[], tolerance: number, verbose: boolean): string[] {
  if (audits.length === 0) return [`  No month data.`];

  const flagged = audits.filter((a) => Math.abs(a.residual) > tolerance);
  const last = audits[audits.length - 1]!;
  const lines: string[] = [
    `  As of ${last.month}: owed ${formatCurrency(last.owed)} | funded ${formatCurrency(last.funded)} | ` +
      `gap ${formatCurrency(last.gap)}`,
    `  The gap is expected to be nonzero and steady - it is unfunded pre-YNAB debt plus past credit overspending.`,
  ];

  const shown = verbose ? audits : flagged;
  for (const a of shown) {
    const flag = Math.abs(a.residual) > tolerance ? "RESIDUAL" : "ok";
    lines.push(
      `  ${a.month.substring(0, 7)}: owed ${formatCurrency(a.owed)} | funded ${formatCurrency(a.funded)} | ` +
        `gap ${formatCurrency(a.gap)} (change ${formatCurrency(a.dGap)}) | ${flag}`
    );
    if (a.startingBalanceDebt !== 0) {
      lines.push(`           - ${formatCurrency(a.startingBalanceDebt)} starting balance debt recorded this month`);
    }
    if (a.creditOverspending !== 0) {
      lines.push(
        `           - ${formatCurrency(a.creditOverspending)} credit overspending this month` +
          (a.overspendingIsEstimate ? " (estimate: another card also spent in an overspent category)" : "")
      );
    }
    if (Math.abs(a.residual) > tolerance) {
      lines.push(
        `           -> ${formatCurrency(a.residual)} unattributed. Assigned ${formatCurrency(a.budgeted)}, ` +
          `activity ${formatCurrency(a.activity)}, moved automatically ${formatCurrency(a.autoMoved)}. ` +
          `Ready to Assign that month: ${formatCurrency(a.toBeBudgeted)}`
      );
    }
  }

  if (flagged.length === 0) {
    lines.push(`  Every month's change in the gap is fully explained. No drift.`);
  }
  return lines;
}
