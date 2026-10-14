import type { TransactionSummaryBase } from "ynab";
import { BudgetModel, SUB_CENT } from "./budget-model.js";
import { ItemStore } from "./item-store.js";

/**
 * Receipt enrichment: say what a charge actually was.
 *
 * A receipt (an Apple email receipt, an Amazon payment from the order history)
 * is matched to the YNAB transaction it paid for by payee, exact amount and a
 * few days' slack on the date. The transaction's memo gets the real product
 * names. When every item has a known category the transaction is categorized,
 * and when the items span categories it is split, with the charge (tax and
 * shipping included) shared out in proportion to item prices.
 *
 * A split cannot be edited through the API afterwards, so nothing is split
 * until every item on the receipt has a category.
 */

export interface ReceiptItem {
  /** Stable identity for remembering its category: an ASIN, an Apple product name. */
  key: string;
  name: string;
  /** Item price in milliunits, positive; tax may be excluded. */
  amount: number;
}

export interface Receipt {
  id: string;
  source: string;
  date: string;
  /** What was charged, in milliunits: positive for a charge, negative for a refund. */
  total: number;
  items: ReceiptItem[];
}

export interface UnknownItem {
  source: string;
  key: string;
  name: string;
  receiptId: string;
  transactionId: string;
}

export interface EnrichUpdate {
  transactionId: string;
  receiptId: string;
  date: string;
  amount: number;
  payee: string;
  memo: string;
  /** Set when every item maps to one category. */
  categoryId?: string;
  /** Set when items map to several categories. */
  subtransactions?: { amount: number; category_id: string; memo: string }[];
  /** Memo only: some items have no category yet. */
  pending: boolean;
}

export interface EnrichPlan {
  updates: EnrichUpdate[];
  unknownItems: UnknownItem[];
  unmatched: { receiptId: string; source: string; date: string; total: number; reason: string }[];
  alreadyDone: number;
}

const PAYEE_PATTERNS: Record<string, RegExp> = {
  amazon: /amazon|amzn|whole foods/i,
  apple: /apple|itunes/i,
};

const MEMO_LIMIT = 200;

export function planEnrichment(
  model: BudgetModel,
  store: ItemStore,
  receipts: Receipt[],
  options: { dateSlackDays?: number } = {}
): EnrichPlan {
  const slack = options.dateSlackDays ?? 7;
  const plan: EnrichPlan = { updates: [], unknownItems: [], unmatched: [], alreadyDone: 0 };
  const taken = new Set<string>();
  const splitIds = new Set((model.snapshot.plan.subtransactions ?? []).filter((s) => !s.deleted).map((s) => s.transaction_id));

  const pool = (model.snapshot.plan.transactions ?? []).filter(
    (t) => !t.deleted && !t.transfer_account_id && model.isOnBudget(t.account_id)
  );

  for (const r of [...receipts].sort((a, b) => a.date.localeCompare(b.date))) {
    if (store.receiptUsed(r.id)) {
      plan.alreadyDone += 1;
      continue;
    }
    const pattern = PAYEE_PATTERNS[r.source.toLowerCase()] ?? new RegExp(escape(r.source), "i");
    const candidates = pool
      .filter((t) => !taken.has(t.id) && !store.enrichedReceipt(t.id))
      .filter((t) => Math.abs(t.amount + r.total) < SUB_CENT)
      .filter((t) => pattern.test(payeeName(model, t)))
      .map((t) => ({ t, days: Math.abs(daysBetween(t.date, r.date)) }))
      .filter((c) => c.days <= slack)
      .sort((a, b) => a.days - b.days);
    if (candidates.length === 0) {
      plan.unmatched.push({ receiptId: r.id, source: r.source, date: r.date, total: r.total, reason: "no transaction with that payee and amount near that date" });
      continue;
    }
    if (candidates.length > 1 && candidates[0]!.days === candidates[1]!.days) {
      plan.unmatched.push({ receiptId: r.id, source: r.source, date: r.date, total: r.total, reason: "two transactions match equally well" });
      continue;
    }
    const t = candidates[0]!.t;
    taken.add(t.id);

    const memo = buildMemo(r, t.memo ?? null);
    const update: EnrichUpdate = {
      transactionId: t.id, receiptId: r.id, date: t.date, amount: t.amount, payee: payeeName(model, t), memo, pending: false,
    };

    const mapped = r.items.map((i) => ({ item: i, categoryId: store.categoryFor(r.source, i.key) }));
    const unknown = mapped.filter((m) => !m.categoryId || !model.categories.has(m.categoryId));
    if (unknown.length > 0 || r.items.length === 0 || splitIds.has(t.id)) {
      update.pending = unknown.length > 0;
      for (const u of unknown) {
        plan.unknownItems.push({ source: r.source, key: u.item.key, name: u.item.name, receiptId: r.id, transactionId: t.id });
      }
    } else {
      const byCategory = new Map<string, ReceiptItem[]>();
      for (const m of mapped) byCategory.set(m.categoryId!, [...(byCategory.get(m.categoryId!) ?? []), m.item]);
      if (byCategory.size === 1) {
        update.categoryId = byCategory.keys().next().value!;
      } else {
        update.subtransactions = prorate(t.amount, byCategory);
      }
    }
    plan.updates.push(update);
  }
  return plan;
}

/** Share `amount` across categories by item price, in whole cents, remainder to the largest. */
export function prorate(amount: number, byCategory: Map<string, ReceiptItem[]>) {
  const groups = Array.from(byCategory.entries()).map(([categoryId, items]) => ({
    categoryId,
    items,
    weight: items.reduce((s, i) => s + Math.max(0, i.amount), 0),
  }));
  // No prices at all: share equally.
  const priced = groups.some((g) => g.weight > 0);
  const weightOf = (g: (typeof groups)[number]) => (priced ? g.weight : 1);
  const totalWeight = groups.reduce((s, g) => s + weightOf(g), 0);
  const legs = groups.map((g) => ({
    category_id: g.categoryId,
    amount: Math.round((amount * weightOf(g)) / totalWeight / 10) * 10,
    memo: truncate(g.items.map((i) => i.name).join("; "), MEMO_LIMIT),
  }));
  const remainder = amount - legs.reduce((s, l) => s + l.amount, 0);
  const largest = legs.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
  largest.amount += remainder;
  return legs;
}

function buildMemo(r: Receipt, existing: string | null): string {
  const names = r.items.map((i) => truncate(i.name, 60)).join("; ");
  const prefix = r.source.toLowerCase() === "amazon" ? "Amazon: " : "";
  const ours = truncate(`${prefix}${names}`, MEMO_LIMIT);
  if (!existing || existing === ours || existing.startsWith(ours)) return ours;
  return truncate(`${ours} | ${existing}`, MEMO_LIMIT);
}

function payeeName(model: BudgetModel, t: TransactionSummaryBase): string {
  return (t.payee_id && model.payeeNames.get(t.payee_id)) || "";
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.substring(0, n - 1)}…`;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
