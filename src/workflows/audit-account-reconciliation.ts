import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";
import { getReconciliationAnchor } from "./lib/reconciliation.js";

const RECONCILE_ADJUSTMENT_PAYEE = "Reconciliation Balance Adjustment";

export function registerAccountReconciliationAuditTool(server: McpServer) {
  server.registerTool("audit_account_reconciliation", {
    title: "Audit Account Reconciliation",
    description:
      "[2-4 API calls] [Workflow] Audit an account's reconciliation state. " +
      "Reports last reconciliation anchor, cleared balance, unreconciled cleared transactions, and " +
      "(if target_balance is provided) the discrepancy between YNAB and the bank. " +
      "Set apply=true to close out the reconciliation: marks all unreconciled cleared transactions " +
      "as reconciled and, when target_balance is provided and a gap exists, creates a " +
      "Reconciliation Balance Adjustment transaction to absorb it. " +
      "Costs 2 API calls (account + transactions) for the audit, plus 1-2 more if apply=true.",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      account_id: z.string().describe("The account to audit"),
      target_balance: z.number().optional().describe(
        "The actual current balance shown by the bank, in dollars (e.g. -4499.74 for a credit card). " +
        "When provided, the tool reports the discrepancy against YNAB's cleared balance."
      ),
      apply: z.boolean().default(false).describe(
        "Close out the reconciliation. Marks unreconciled cleared transactions as reconciled and, " +
        "when target_balance != cleared_balance, creates a Reconciliation Balance Adjustment for the gap. " +
        "Default: false (audit only)."
      ),
    }),
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, account_id, target_balance, apply }) => {
    try {
      let apiCalls = 0;

      const accountRes = await getClient().accounts.getAccountById(budget_id, account_id);
      apiCalls += 1;
      const account = accountRes.data.account;

      const anchor = await getReconciliationAnchor(budget_id, account_id);
      apiCalls += 1;

      const targetMilli = target_balance !== undefined ? dollarsToMilliunits(target_balance) : null;
      const discrepancy = targetMilli !== null ? account.cleared_balance - targetMilli : null;

      const lines: string[] = [];
      lines.push(`Reconciliation Audit: ${account.name}`);
      lines.push(``);
      lines.push(`Current state:`);
      lines.push(`  Working Balance: ${formatCurrency(account.balance)}`);
      lines.push(`  Cleared Balance: ${formatCurrency(account.cleared_balance)} (what YNAB will reconcile to)`);
      lines.push(`  Uncleared Balance: ${formatCurrency(account.uncleared_balance)}`);

      lines.push(``);
      lines.push(`Reconciliation anchor:`);
      if (anchor.lastReconciledDate) {
        const sourceNote = anchor.lastReconciledDateSource === "transaction"
          ? " (lower bound — derived from most recent reconciled transaction; no balance adjustment found)"
          : "";
        lines.push(`  Last Reconciled Date: ${anchor.lastReconciledDate}${sourceNote}`);
      } else {
        lines.push(`  Last Reconciled Date: Never reconciled`);
      }
      lines.push(`  Reconciled Balance: ${formatCurrency(anchor.reconciledBalance)}`);
      lines.push(
        `  Unreconciled cleared activity: ${anchor.unreconciledTransactions.length} transaction(s), ` +
        `net ${formatCurrency(anchor.unreconciledNet)}`
      );

      if (targetMilli !== null && discrepancy !== null) {
        lines.push(``);
        lines.push(`Bank reconciliation:`);
        lines.push(`  Target Balance (bank): ${formatCurrency(targetMilli)}`);
        if (discrepancy === 0) {
          lines.push(`  Discrepancy: $0.00 — YNAB matches the bank exactly.`);
        } else {
          const direction = discrepancy > 0 ? "higher than" : "lower than";
          lines.push(
            `  Discrepancy: ${formatCurrency(Math.abs(discrepancy))} ` +
            `(YNAB cleared is ${direction} bank)`
          );
          if (discrepancy > 0) {
            lines.push(
              `  Likely cause: missing charges in YNAB, or refunds in YNAB that haven't posted at the bank.`
            );
          } else {
            lines.push(
              `  Likely cause: missing credits/refunds in YNAB, or charges in YNAB that haven't posted at the bank.`
            );
          }
        }
      }

      if (anchor.unreconciledTransactions.length > 0) {
        lines.push(``);
        lines.push(`Unreconciled cleared transactions (would be folded into next reconciliation):`);
        for (const t of anchor.unreconciledTransactions) {
          const memo = t.memo ? ` "${t.memo}"` : "";
          lines.push(
            `  ${t.date} | ${formatCurrency(t.amount)} | ${t.payee_name ?? "No payee"} | ` +
            `${t.category_name ?? "Uncategorized"}${memo} [ID: ${t.id}]`
          );
        }
      }

      if (apply) {
        lines.push(``);
        lines.push(`Applying reconciliation...`);

        if (targetMilli !== null && discrepancy !== null && discrepancy !== 0) {
          // Bank shows a balance different from YNAB cleared. Create an adjustment for the gap.
          // The adjustment amount should make YNAB match the bank:
          //   new_cleared = cleared + adjustment = target => adjustment = target - cleared = -discrepancy
          const adjustmentAmount = -discrepancy;
          await getClient().transactions.createTransaction(budget_id, {
            transaction: {
              account_id,
              date: new Date().toISOString().slice(0, 10),
              amount: adjustmentAmount,
              payee_name: RECONCILE_ADJUSTMENT_PAYEE,
              memo: "Created by audit_account_reconciliation",
              cleared: "reconciled",
              approved: true,
            },
          });
          apiCalls += 1;
          lines.push(
            `  Created Reconciliation Balance Adjustment: ${formatCurrency(adjustmentAmount)} ` +
            `(brings YNAB cleared to ${formatCurrency(targetMilli)})`
          );
        }

        if (anchor.unreconciledTransactions.length > 0) {
          await getClient().transactions.updateTransactions(budget_id, {
            transactions: anchor.unreconciledTransactions.map((t) => ({
              id: t.id,
              cleared: "reconciled",
            })),
          });
          apiCalls += 1;
          lines.push(`  Marked ${anchor.unreconciledTransactions.length} transaction(s) as reconciled.`);
        } else if (targetMilli === null || discrepancy === 0) {
          lines.push(`  Nothing to do — no unreconciled cleared transactions and no discrepancy.`);
        }
      } else {
        const apply_eligible =
          anchor.unreconciledTransactions.length > 0 ||
          (targetMilli !== null && discrepancy !== null && discrepancy !== 0);
        if (apply_eligible) {
          lines.push(``);
          lines.push(
            `Set apply=true to close out: mark cleared transactions as reconciled` +
            (targetMilli !== null && discrepancy !== null && discrepancy !== 0
              ? ` and create the ${formatCurrency(-discrepancy)} balance adjustment.`
              : `.`)
          );
        }
      }

      lines.push(``);
      lines.push(`API calls used: ${apiCalls}`);

      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
