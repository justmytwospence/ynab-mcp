import type { TransactionDetail } from "ynab";
import { getClient } from "../../ynab-client.js";

const RECONCILE_ADJUSTMENT_PAYEE = "Reconciliation Balance Adjustment";

export interface ReconciliationAnchor {
  lastReconciledDate: string | null;
  lastReconciledDateSource: "adjustment" | "transaction" | "none";
  reconciledBalance: number;
  unreconciledTransactions: TransactionDetail[];
  unreconciledNet: number;
}

/**
 * Compute reconciliation state for an account from its transaction history.
 *
 * - reconciledBalance: sum of all transactions with cleared === "reconciled".
 * - lastReconciledDate: date of the most recent Reconciliation Balance Adjustment
 *   transaction (the actual reconciliation event date). Falls back to the date of
 *   the most recent reconciled transaction when no adjustments exist, which is a
 *   lower bound on the true reconciliation date.
 * - unreconciledTransactions: cleared-status transactions (i.e. cleared but not
 *   yet reconciled). These are what would be folded in at the next reconciliation.
 *
 * Costs 1 API call.
 */
export async function getReconciliationAnchor(
  budgetId: string,
  accountId: string
): Promise<ReconciliationAnchor> {
  const response = await getClient().transactions.getTransactionsByAccount(
    budgetId,
    accountId
  );
  const txns = response.data.transactions;

  let reconciledBalance = 0;
  let latestReconciledDate: string | null = null;
  let latestAdjustmentDate: string | null = null;
  const unreconciledTransactions: TransactionDetail[] = [];
  let unreconciledNet = 0;

  for (const t of txns) {
    if (t.cleared === "reconciled") {
      reconciledBalance += t.amount;
      if (latestReconciledDate === null || t.date > latestReconciledDate) {
        latestReconciledDate = t.date;
      }
      if (t.payee_name === RECONCILE_ADJUSTMENT_PAYEE) {
        if (latestAdjustmentDate === null || t.date > latestAdjustmentDate) {
          latestAdjustmentDate = t.date;
        }
      }
    } else if (t.cleared === "cleared") {
      unreconciledTransactions.push(t);
      unreconciledNet += t.amount;
    }
  }

  let lastReconciledDate: string | null;
  let lastReconciledDateSource: "adjustment" | "transaction" | "none";
  if (latestAdjustmentDate) {
    lastReconciledDate = latestAdjustmentDate;
    lastReconciledDateSource = "adjustment";
  } else if (latestReconciledDate) {
    lastReconciledDate = latestReconciledDate;
    lastReconciledDateSource = "transaction";
  } else {
    lastReconciledDate = null;
    lastReconciledDateSource = "none";
  }

  unreconciledTransactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    lastReconciledDate,
    lastReconciledDateSource,
    reconciledBalance,
    unreconciledTransactions,
    unreconciledNet,
  };
}
