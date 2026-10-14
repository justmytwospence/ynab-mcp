import type { AccountBase, CategoryBase, TransactionSummaryBase } from "ynab";
import { internalCategoryIds, snapshotMonths, type BudgetSnapshot } from "../../budget-snapshot.js";

export const CREDIT_ACCOUNT_TYPES = new Set(["creditCard", "lineOfCredit"]);

/** Differences smaller than one cent (10 milliunits) are rounding, not money. */
export const SUB_CENT = 10;

/** One categorized piece of a transaction: the whole transaction, or one split leg. */
export interface Leg {
  transactionId: string;
  date: string;
  /** First of the transaction's month, YYYY-MM-01. */
  month: string;
  amount: number;
  categoryId: string | null;
  accountId: string;
  payeeId: string | null;
  payeeName: string;
  memo: string | null;
  approved: boolean;
  isTransfer: boolean;
  isSplitLeg: boolean;
}

export function monthOf(date: string): string {
  return `${date.substring(0, 7)}-01`;
}

export function addMonths(month: string, n: number): string {
  const y = Number.parseInt(month.substring(0, 4), 10);
  const m = Number.parseInt(month.substring(5, 7), 10) - 1 + n;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${year}-${String(mon + 1).padStart(2, "0")}-01`;
}

/**
 * Indexed, read-only view of a budget export, built once per tool call.
 *
 * Everything the integrity, planning and categorization workflows need is
 * derived here from the single cached getPlanById response, so none of them
 * spends more than the one API call the snapshot costs.
 */
export class BudgetModel {
  readonly months: string[];
  /** The month containing `today`; months before it are history. */
  readonly currentMonth: string;
  readonly toBeBudgeted = new Map<string, number>();
  readonly monthCategories = new Map<string, Map<string, CategoryBase>>();
  readonly categories = new Map<string, CategoryBase>();
  readonly groupNames = new Map<string, string>();
  readonly internalIds: Set<string>;
  readonly accounts = new Map<string, AccountBase>();
  readonly cards: AccountBase[];
  /** card account id -> its payment category id */
  readonly paymentCategoryByCard: Map<string, string>;
  readonly payeeNames = new Map<string, string>();
  readonly legs: Leg[] = [];
  private readonly legsByCategoryMonth = new Map<string, Leg[]>();

  constructor(readonly snapshot: BudgetSnapshot, today: string = new Date().toISOString().substring(0, 10)) {
    const plan = snapshot.plan;
    this.currentMonth = monthOf(today);

    for (const m of snapshotMonths(snapshot)) {
      this.toBeBudgeted.set(m.month, m.to_be_budgeted);
      this.monthCategories.set(m.month, new Map((m.categories ?? []).filter((c) => !c.deleted).map((c) => [c.id, c])));
    }
    this.months = Array.from(this.monthCategories.keys()).sort();

    for (const c of plan.categories ?? []) if (!c.deleted) this.categories.set(c.id, c);
    for (const g of plan.category_groups ?? []) if (!g.deleted) this.groupNames.set(g.id, g.name);
    this.internalIds = internalCategoryIds(snapshot);
    for (const a of plan.accounts ?? []) if (!a.deleted) this.accounts.set(a.id, a);
    this.cards = Array.from(this.accounts.values()).filter((a) => CREDIT_ACCOUNT_TYPES.has(a.type) && a.on_budget);
    for (const p of plan.payees ?? []) if (!p.deleted) this.payeeNames.set(p.id, p.name);
    this.paymentCategoryByCard = this.findPaymentCategories();

    const splits = new Map<string, NonNullable<typeof plan.subtransactions>>();
    for (const s of plan.subtransactions ?? []) {
      if (s.deleted) continue;
      const list = splits.get(s.transaction_id) ?? [];
      list.push(s);
      splits.set(s.transaction_id, list);
    }
    for (const t of plan.transactions ?? []) {
      if (t.deleted) continue;
      const pieces = splits.get(t.id);
      if (pieces && pieces.length > 0) {
        for (const s of pieces) {
          this.addLeg(t, {
            amount: s.amount,
            categoryId: s.category_id ?? null,
            payeeId: s.payee_id ?? t.payee_id ?? null,
            memo: s.memo ?? t.memo ?? null,
            isTransfer: Boolean(s.transfer_account_id),
            isSplitLeg: true,
          });
        }
      } else {
        this.addLeg(t, {
          amount: t.amount,
          categoryId: t.category_id ?? null,
          payeeId: t.payee_id ?? null,
          memo: t.memo ?? null,
          isTransfer: Boolean(t.transfer_account_id),
          isSplitLeg: false,
        });
      }
    }
  }

  private addLeg(
    t: TransactionSummaryBase,
    piece: Pick<Leg, "amount" | "categoryId" | "payeeId" | "memo" | "isTransfer" | "isSplitLeg">
  ) {
    const leg: Leg = {
      transactionId: t.id,
      date: t.date,
      month: monthOf(t.date),
      accountId: t.account_id,
      approved: t.approved,
      payeeName: (piece.payeeId && this.payeeNames.get(piece.payeeId)) || "(no payee)",
      ...piece,
    };
    this.legs.push(leg);
    if (leg.categoryId) {
      const key = `${leg.categoryId}|${leg.month}`;
      const list = this.legsByCategoryMonth.get(key) ?? [];
      list.push(leg);
      this.legsByCategoryMonth.set(key, list);
    }
  }

  /**
   * The API has no account -> payment category key. A payment transfer into the
   * card carries the payment category, which is a real link; fall back to the
   * internal category with the card's name.
   */
  private findPaymentCategories(): Map<string, string> {
    const result = new Map<string, string>();
    for (const t of this.snapshot.plan.transactions ?? []) {
      if (t.deleted || !t.transfer_account_id || !t.category_id) continue;
      if (!this.internalIds.has(t.category_id)) continue;
      if (!result.has(t.transfer_account_id)) result.set(t.transfer_account_id, t.category_id);
    }
    for (const card of this.cards) {
      if (result.has(card.id)) continue;
      const named = Array.from(this.categories.values()).find((c) => this.internalIds.has(c.id) && c.name === card.name);
      if (named) result.set(card.id, named.id);
    }
    return result;
  }

  isCard(accountId: string): boolean {
    return this.cards.some((c) => c.id === accountId);
  }

  isOnBudget(accountId: string): boolean {
    return this.accounts.get(accountId)?.on_budget ?? false;
  }

  isPaymentCategory(categoryId: string): boolean {
    return Array.from(this.paymentCategoryByCard.values()).includes(categoryId);
  }

  /** The "Uncategorized" internal category, if present. */
  get uncategorizedId(): string | undefined {
    return Array.from(this.categories.values()).find((c) => this.internalIds.has(c.id) && c.name === "Uncategorized")?.id;
  }

  /** The "Inflow: Ready to Assign" internal category, if present. */
  get readyToAssignId(): string | undefined {
    return Array.from(this.categories.values()).find(
      (c) => this.internalIds.has(c.id) && /ready to assign|to be budgeted/i.test(c.name)
    )?.id;
  }

  categoryLabel(categoryId: string): string {
    const c = this.categories.get(categoryId);
    if (!c) return categoryId;
    const group = this.groupNames.get(c.category_group_id);
    return group ? `${group}: ${c.name}` : c.name;
  }

  groupOf(categoryId: string): string | undefined {
    const c = this.categories.get(categoryId);
    return c ? this.groupNames.get(c.category_group_id) : undefined;
  }

  monthCategory(month: string, categoryId: string): CategoryBase | undefined {
    return this.monthCategories.get(month)?.get(categoryId);
  }

  legsFor(categoryId: string, month: string): Leg[] {
    return this.legsByCategoryMonth.get(`${categoryId}|${month}`) ?? [];
  }

  /** Outflows (as a positive number) from credit accounts in a category-month, per card. */
  creditSpendByCard(categoryId: string, month: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const leg of this.legsFor(categoryId, month)) {
      if (!this.isCard(leg.accountId)) continue;
      result.set(leg.accountId, (result.get(leg.accountId) ?? 0) - leg.amount);
    }
    return result;
  }

  /** Card balance at the end of each month, accumulated forward from its first transaction. */
  cardBalanceAtEndOf(cardId: string): { byMonth: Map<string, number>; unreconciled: number } {
    const perMonth = new Map<string, number>();
    let total = 0;
    for (const t of this.snapshot.plan.transactions ?? []) {
      if (t.deleted || t.account_id !== cardId) continue;
      total += t.amount;
      const m = monthOf(t.date);
      perMonth.set(m, (perMonth.get(m) ?? 0) + t.amount);
    }
    const byMonth = new Map<string, number>();
    let running = 0;
    // Transactions dated before the plan's first month still count toward it.
    for (const [m, amount] of perMonth) if (m < (this.months[0] ?? m)) running += amount;
    for (const m of this.months) {
      running += perMonth.get(m) ?? 0;
      byMonth.set(m, running);
    }
    return { byMonth, unreconciled: (this.accounts.get(cardId)?.balance ?? 0) - total };
  }
}
