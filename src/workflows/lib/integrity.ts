import { BudgetModel, SUB_CENT, addMonths, type Leg } from "./budget-model.js";
import { formatCurrency } from "../../utils/formatting.js";

/**
 * Budget integrity: the history checks that make every later number trustworthy.
 *
 * YNAB never revisits a closed month on its own. Re-categorizing an old
 * transaction can leave a category overspent in a month nobody looks at again:
 * cash overspending silently comes out of the next month's Ready to Assign, and
 * credit overspending leaves the card's payment category short forever. Both
 * corrupt every month after it.
 *
 * The rule enforced here is the strict one: at the end of every month, each
 * card's payment category Available must equal what the card owes after that
 * month's last transaction.
 */

export interface TransactionRef {
  id: string;
  date: string;
  amount: number;
  payee: string;
  account: string;
  memo: string | null;
}

export interface Overspend {
  month: string;
  categoryId: string;
  category: string;
  /** Positive: how far below zero the category ended the month. */
  amount: number;
  /** Portion attributable to card spending (YNAB turns it into card debt). */
  credit: number;
  isCurrentMonth: boolean;
  transactions: TransactionRef[];
}

export interface NegativeReadyToAssign {
  month: string;
  amount: number;
}

export interface CardMonth {
  month: string;
  owed: number;
  available: number;
  /** owed - available; must be zero. Positive: underfunded. */
  gap: number;
  change: number;
  /** Credit overspending on this card in this month, which explains a positive change. */
  creditOverspending: number;
}

export interface CardReport {
  cardId: string;
  card: string;
  paymentCategoryId: string | null;
  skipped?: string;
  /** Months whose gap is nonzero. */
  months: CardMonth[];
}

export interface UncategorizedSpending {
  month: string;
  amount: number;
  transactions: TransactionRef[];
}

export interface Findings {
  currentMonth: string;
  overspends: Overspend[];
  negativeReadyToAssign: NegativeReadyToAssign[];
  uncategorized: UncategorizedSpending[];
  cards: CardReport[];
}

export interface IntegrityOptions {
  /** Only months on or after this (YYYY-MM-01). */
  sinceMonth?: string;
  /** Include the current month's overspending (normal mid-month, but it becomes history). */
  includeCurrentMonth?: boolean;
  /** Max transactions listed per finding. */
  transactionLimit?: number;
}

function ref(model: BudgetModel, leg: Leg): TransactionRef {
  return {
    id: leg.transactionId,
    date: leg.date,
    amount: leg.amount,
    payee: leg.payeeName,
    account: model.accounts.get(leg.accountId)?.name ?? leg.accountId,
    memo: leg.memo,
  };
}

/** Largest outflows first: those are the transactions most likely to have caused it. */
function topOutflows(model: BudgetModel, legs: Leg[], limit: number): TransactionRef[] {
  return [...legs].sort((a, b) => a.amount - b.amount).slice(0, limit).map((l) => ref(model, l));
}

export function findIntegrityProblems(model: BudgetModel, options: IntegrityOptions = {}): Findings {
  const { sinceMonth, includeCurrentMonth = true, transactionLimit = 5 } = options;
  const lastMonth = model.currentMonth;
  const months = model.months.filter((m) => m <= lastMonth && (!sinceMonth || m >= sinceMonth));
  const uncategorizedId = model.uncategorizedId;

  const overspends: Overspend[] = [];
  const uncategorized: UncategorizedSpending[] = [];
  for (const month of months) {
    const isCurrentMonth = month === model.currentMonth;
    if (isCurrentMonth && !includeCurrentMonth) continue;
    for (const c of model.monthCategories.get(month)?.values() ?? []) {
      if (c.balance > -SUB_CENT) continue;
      if (c.id === uncategorizedId) {
        uncategorized.push({
          month,
          amount: -c.balance,
          transactions: topOutflows(model, model.legsFor(c.id, month), transactionLimit),
        });
        continue;
      }
      // Payment categories are judged by the card check; other internal ones never go negative.
      if (model.internalIds.has(c.id)) continue;
      const amount = -c.balance;
      const creditSpend = Array.from(model.creditSpendByCard(c.id, month).values()).reduce((s, x) => s + x, 0);
      overspends.push({
        month,
        categoryId: c.id,
        category: model.categoryLabel(c.id),
        amount,
        credit: Math.max(0, Math.min(amount, creditSpend)),
        isCurrentMonth,
        transactions: topOutflows(model, model.legsFor(c.id, month), transactionLimit),
      });
    }
  }

  const negativeReadyToAssign = months
    .filter((m) => m < model.currentMonth)
    .map((m) => ({ month: m, amount: model.toBeBudgeted.get(m) ?? 0 }))
    .filter((r) => r.amount <= -SUB_CENT);

  const cards = model.cards.map((card) => cardReport(model, card.id, months));

  return { currentMonth: model.currentMonth, overspends, negativeReadyToAssign, uncategorized, cards };
}

function cardReport(model: BudgetModel, cardId: string, months: string[]): CardReport {
  const card = model.accounts.get(cardId)!;
  const paymentCategoryId = model.paymentCategoryByCard.get(cardId) ?? null;
  const report: CardReport = { cardId, card: card.name, paymentCategoryId, months: [] };
  if (!paymentCategoryId) {
    report.skipped = "no payment category could be identified";
    return report;
  }
  const { byMonth, unreconciled } = model.cardBalanceAtEndOf(cardId);
  if (Math.abs(unreconciled) >= SUB_CENT) {
    report.skipped = `transactions do not sum to the account balance (off by ${unreconciled} milliunits)`;
    return report;
  }

  const allMonths = model.months.filter((m) => m <= model.currentMonth);
  let previousGap = 0;
  for (const month of allMonths) {
    const owed = -(byMonth.get(month) ?? 0);
    // A card in credit (overpaid, or a refund larger than the balance) has no
    // meaningful target for its payment category: YNAB leaves whatever is there.
    // Judging it would release money one month only to need it back the next.
    if (owed < 0) continue;
    const available = model.monthCategory(month, paymentCategoryId)?.balance ?? 0;
    const gap = owed - available;
    const change = gap - previousGap;
    previousGap = gap;
    if (!months.includes(month) || Math.abs(gap) < SUB_CENT) continue;
    let creditOverspending = 0;
    for (const c of model.monthCategories.get(month)?.values() ?? []) {
      if (c.balance >= 0 || model.internalIds.has(c.id)) continue;
      const spend = model.creditSpendByCard(c.id, month).get(cardId) ?? 0;
      creditOverspending += Math.min(-c.balance, spend);
    }
    report.months.push({ month, owed, available, gap, change, creditOverspending });
  }
  return report;
}

/* ------------------------------------------------------------------------- */
/* Repair planning                                                            */
/* ------------------------------------------------------------------------- */

/** A change to one category's assigned amount in one month. */
export interface AssignmentChange {
  month: string;
  categoryId: string;
  delta: number;
}

export type RepairKind = "rta_shortfall" | "overspend" | "card_gap";
export type RepairMethod = "ready_to_assign" | "bridge" | "release";

export interface Repair {
  /** Stable id: `<kind>:<YYYY-MM>:<categoryId|ready-to-assign>`, as a proposal's key. */
  key: string;
  /** `card:<cardId>` for card-gap repairs, which are applied all or nothing per card. */
  group?: string;
  kind: RepairKind;
  month: string;
  /** The category being fixed (target), or null for an RTA shortfall. */
  categoryId: string | null;
  label: string;
  amount: number;
  method: RepairMethod;
  /** Bridge sources: category, amount taken in the problem month and given back in the current month. */
  sources: { categoryId: string; label: string; amount: number }[];
  changes: AssignmentChange[];
}

export interface Unresolved {
  kind: RepairKind;
  month: string;
  categoryId: string | null;
  label: string;
  amount: number;
  shortBy: number;
  reason: string;
}

/** A source a proposal offers: a category that alone held enough unused money all along. */
export interface ProposalOption {
  categoryId: string;
  label: string;
  /** Its lowest balance over the borrowing stretch, before this repair. */
  spare: number;
}

/**
 * A repair that needs borrowing, asked instead of done (askBeforeBridging). Answer it by
 * passing `bridgeSources[key]`: a category id, or "ready_to_assign" to fund it from Ready
 * to Assign even though that pushes the months in `readyToAssignAnyway` below zero.
 */
export interface Proposal {
  key: string;
  group?: string;
  kind: RepairKind;
  month: string;
  categoryId: string | null;
  label: string;
  amount: number;
  /** Borrowed from `month` through the month before `giveBack`, and given back in `giveBack`. */
  giveBack: string | null;
  options: ProposalOption[];
  /** What funding it from Ready to Assign anyway does; null when that is not possible. */
  readyToAssignAnyway: { months: string[]; lowest: { month: string; readyToAssign: number } } | null;
  /** Set when an answer was given but could not be used, saying why. */
  reason?: string;
}

export interface RepairPlan {
  repairs: Repair[];
  /** Repairs that need borrowing, waiting for a choice (askBeforeBridging only). */
  proposals: Proposal[];
  unresolved: Unresolved[];
  /** Card gaps are left for the next run while covers are pending: covers move card money themselves. */
  deferredCardGaps: boolean;
  /** Net assigned-amount writes, one API call each. */
  writes: { month: string; categoryId: string; label: string; from: number; to: number }[];
  /** How much the plan changes Ready to Assign from the current month on (negative: it costs that much). */
  readyToAssignChange: number;
}

/**
 * Simulates assigned-amount changes against the export's month figures.
 *
 * Ready to Assign: an extra assignment in month M lowers RTA in M and every
 * later month. (Covering cash overspending is cheaper than that, because the
 * overspend stops coming out of next month's RTA, but treating every cover as
 * persistent keeps the affordability check conservative.)
 *
 * Category balances: a change in M carries into later months for as long as
 * the category stays non-negative; YNAB resets a negative balance to zero at
 * the month boundary, which stops the carry.
 */
class Simulation {
  private readonly deltas = new Map<string, number>(); // `${cat}|${month}` -> delta
  private readonly rtaDeltas = new Map<string, number>(); // month -> delta to RTA

  constructor(private readonly model: BudgetModel) {}

  change(month: string, categoryId: string, delta: number) {
    const key = `${categoryId}|${month}`;
    this.deltas.set(key, (this.deltas.get(key) ?? 0) + delta);
    this.rtaDeltas.set(month, (this.rtaDeltas.get(month) ?? 0) - delta);
  }

  /** RTA from `month` onward, the worst (lowest) one, after all changes so far. */
  minReadyToAssignFrom(month: string): number {
    let cumulative = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (const m of this.model.months) {
      cumulative += this.rtaDeltas.get(m) ?? 0;
      if (m < month) continue;
      worst = Math.min(worst, (this.model.toBeBudgeted.get(m) ?? 0) + cumulative);
    }
    return worst === Number.POSITIVE_INFINITY ? 0 : worst;
  }

  /** The month from `month` onward with the lowest RTA. */
  worstMonthFrom(month: string): string | null {
    let cumulative = 0;
    let worst: { m: string; v: number } | null = null;
    for (const m of this.model.months) {
      cumulative += this.rtaDeltas.get(m) ?? 0;
      if (m < month) continue;
      const v = (this.model.toBeBudgeted.get(m) ?? 0) + cumulative;
      if (!worst || v < worst.v) worst = { m, v };
    }
    return worst?.m ?? null;
  }

  readyToAssign(month: string): number {
    let cumulative = 0;
    for (const m of this.model.months) {
      if (m > month) break;
      cumulative += this.rtaDeltas.get(m) ?? 0;
    }
    return (this.model.toBeBudgeted.get(month) ?? 0) + cumulative;
  }

  /** The category's balance in every month from `from` through `through`, after changes. */
  balances(categoryId: string, from: string, through: string): number[] {
    const result: number[] = [];
    let previousOriginal: number | null = null;
    let previousAdjusted: number | null = null;
    for (const m of this.model.months) {
      if (m > through) break;
      const original = this.model.monthCategory(m, categoryId)?.balance ?? 0;
      const delta = this.deltas.get(`${categoryId}|${m}`) ?? 0;
      let adjusted: number;
      if (previousOriginal === null || previousAdjusted === null) {
        adjusted = original + delta;
      } else {
        // This month's own budgeted + activity, re-based on the adjusted carry-in.
        const own = original - Math.max(previousOriginal, 0);
        adjusted = Math.max(previousAdjusted, 0) + own + delta;
      }
      previousOriginal = original;
      previousAdjusted = adjusted;
      if (m >= from) result.push(adjusted);
    }
    return result;
  }

  snapshot() {
    return { deltas: new Map(this.deltas), rtaDeltas: new Map(this.rtaDeltas) };
  }

  restore(state: { deltas: Map<string, number>; rtaDeltas: Map<string, number> }) {
    this.deltas.clear();
    for (const [k, v] of state.deltas) this.deltas.set(k, v);
    this.rtaDeltas.clear();
    for (const [k, v] of state.rtaDeltas) this.rtaDeltas.set(k, v);
  }

  netChanges(): AssignmentChange[] {
    return Array.from(this.deltas.entries())
      .filter(([, d]) => d !== 0)
      .map(([key, delta]) => {
        const [categoryId, month] = key.split("|") as [string, string];
        return { month, categoryId, delta };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || a.categoryId.localeCompare(b.categoryId));
  }
}

export interface RepairOptions {
  /** Permit a repair to leave Ready to Assign negative somewhere, as a last resort. */
  allowNegativeReadyToAssign?: boolean;
  /**
   * Treat a past month whose Ready to Assign is already negative as blocking every repair
   * dated before it. Off by default: such a month is settled history (later income
   * absorbed it), so a repair may lower it further as long as no month that is fine
   * stays fine and the current month and later never go negative.
   */
  strictReadyToAssign?: boolean;
  /** Group names never used as bridge sources (e.g. savings you never want touched). */
  protectedGroups?: string[];
  /** Ask before borrowing: a repair that needs a bridge becomes a Proposal, not a repair. */
  askBeforeBridging?: boolean;
  /** Answers to proposals, by key: a source category id, or "ready_to_assign". */
  bridgeSources?: Record<string, string>;
}

export const READY_TO_ASSIGN = "ready_to_assign";
export const repairKey = (kind: RepairKind, month: string, categoryId: string | null) =>
  `${kind}:${month.substring(0, 7)}:${categoryId ?? "ready-to-assign"}`;

/**
 * Plan repairs, cheapest first.
 *
 * Every repair either assigns from Ready to Assign, or "bridges": it takes
 * money from categories that held it unused in the problem month and gives it
 * back to them in the first later month whose Ready to Assign can absorb it.
 * A bridge never changes a category's balance outside that window, so goals
 * and balances today are untouched; only the month(s) in between see less.
 *
 * 1. Negative Ready to Assign months, oldest first: bridge the shortfall,
 *    giving it back the following month (whose RTA already absorbed it).
 * 2. Overspent category-months, oldest first: assign from RTA when that month
 *    and every later one can afford it, otherwise bridge.
 * 3. Card gaps, only when no credit cover is pending (a cover moves card money
 *    itself): assign the change in the gap to the payment category in the
 *    month it appeared, or release it when the category was overfunded.
 *
 * Whatever is still uncovered is reported, never forced, unless
 * allowNegativeReadyToAssign is set.
 */
export function planRepairs(model: BudgetModel, findings: Findings, options: RepairOptions = {}): RepairPlan {
  const {
    allowNegativeReadyToAssign = false, strictReadyToAssign = false, protectedGroups = [],
    askBeforeBridging = false, bridgeSources = {},
  } = options;
  const sim = new Simulation(model);
  const repairs: Repair[] = [];
  const proposals: Proposal[] = [];
  const unresolved: Unresolved[] = [];
  const current = model.currentMonth;
  const lastMonth = model.months[model.months.length - 1] ?? current;
  const protectedSet = new Set(protectedGroups);

  const isBridgeSource = (categoryId: string, month: string) => {
    if (model.internalIds.has(categoryId)) return false;
    const c = model.categories.get(categoryId);
    if (!c || c.deleted) return false;
    const group = model.groupOf(categoryId);
    if (group && protectedSet.has(group)) return false;
    return model.monthCategory(month, categoryId) !== undefined;
  };


  interface Bridge {
    giveBack: string;
    sources: Repair["sources"];
    found: number;
  }

  /** A category's lowest balance from `month` until `giveBack` (what it can lend), 0 at worst. */
  const spareOf = (id: string, month: string, giveBack: string) => {
    const series = sim.balances(id, month, addMonths(giveBack, -1));
    return series.length > 0 ? Math.max(0, Math.min(...series)) : 0;
  };

  /** Categories that held unused money from `month` until `giveBack`, most first. */
  const lenders = (month: string, exclude: string | null, giveBack: string) =>
    Array.from(model.monthCategories.get(month)?.keys() ?? [])
      .filter((id) => id !== exclude && isBridgeSource(id, month))
      .map((id) => ({ id, spare: spareOf(id, month, giveBack) }))
      .filter((c) => c.spare >= SUB_CENT)
      .sort((a, b) => b.spare - a.spare || a.id.localeCompare(b.id));

  /** Find up to `needed` in categories unused from `month` until `giveBack`. */
  const findBridge = (month: string, needed: number, exclude: string | null, giveBack: string | null): Bridge | null => {
    if (!giveBack) return null;
    const candidates = lenders(month, exclude, giveBack);
    const sources: Repair["sources"] = [];
    let remaining = needed;
    for (const c of candidates) {
      if (remaining < SUB_CENT) break;
      const take = Math.min(c.spare, remaining);
      sources.push({ categoryId: c.id, label: model.categoryLabel(c.id), amount: take });
      remaining -= take;
    }
    const found = needed - Math.max(0, remaining);
    return found >= SUB_CENT ? { giveBack, sources, found } : null;
  };

  const applyBridge = (month: string, b: Bridge, sign = 1) => {
    for (const s of b.sources) {
      sim.change(month, s.categoryId, -s.amount * sign);
      sim.change(b.giveBack, s.categoryId, s.amount * sign);
    }
  };

  // 1. Negative Ready to Assign months.
  for (const r of [...findings.negativeReadyToAssign].sort((a, b) => a.month.localeCompare(b.month))) {
    const shortfall = -sim.readyToAssign(r.month);
    if (shortfall < SUB_CENT) continue;
    const before = sim.netChanges();
    const key = repairKey("rta_shortfall", r.month, null);
    // The following month's RTA already absorbed this shortfall, so giving the
    // money back there leaves it, and every month after, unchanged.
    const giveBack = addMonths(r.month, 1);
    let b: Bridge | null = null;
    let reason: string | undefined;
    const choice = bridgeSources[key];
    if (choice && choice !== READY_TO_ASSIGN) {
      const spare = isBridgeSource(choice, r.month) ? spareOf(choice, r.month, giveBack) : 0;
      if (spare >= shortfall - SUB_CENT) b = { giveBack, sources: [{ categoryId: choice, label: model.categoryLabel(choice), amount: shortfall }], found: shortfall };
      else reason = `${model.categoryLabel(choice)} only had ${formatCurrency(spare)} unused in ${r.month.substring(0, 7)}`;
    }
    if (!b && askBeforeBridging) {
      const options = lenders(r.month, null, giveBack).filter((c) => c.spare >= shortfall - SUB_CENT).slice(0, 3)
        .map((c) => ({ categoryId: c.id, label: model.categoryLabel(c.id), spare: c.spare }));
      // Ready to Assign cannot fund its own shortfall, so with no single lender there is
      // nothing to ask: it is reported as unresolved below.
      if (options.length > 0) {
        proposals.push({
          key, kind: "rta_shortfall", month: r.month, categoryId: null, label: "Ready to Assign", amount: shortfall,
          giveBack, options, readyToAssignAnyway: null, ...(reason ? { reason } : {}),
        });
        continue;
      }
    } else if (!b) {
      b = findBridge(r.month, shortfall, null, giveBack);
    }
    if (b) {
      applyBridge(r.month, b);
      repairs.push({
        key,
        kind: "rta_shortfall",
        month: r.month,
        categoryId: null,
        label: "Ready to Assign",
        amount: b.found,
        method: "bridge",
        sources: b.sources,
        changes: diff(before, sim.netChanges()),
      });
    }
    const found = b?.found ?? 0;
    if (shortfall - found >= SUB_CENT) {
      unresolved.push({
        kind: "rta_shortfall",
        month: r.month,
        categoryId: null,
        label: "Ready to Assign",
        amount: shortfall,
        shortBy: shortfall - found,
        reason: "not enough unused money in that month's categories to take back",
      });
    }
  }

  /** A past month that was already short before this plan: settled history, unless strict. */
  const settled = (m: string) => !strictReadyToAssign && m < current && (model.toBeBudgeted.get(m) ?? 0) < 0;

  /**
   * The month that stops `amount` being assigned in `month`, or null when it can be:
   * every month from then on keeps Ready to Assign at or above zero, except settled ones.
   */
  const blockingMonth = (month: string, amount: number): string | null => {
    for (const m of model.months) {
      if (m < month || settled(m)) continue;
      if (sim.readyToAssign(m) - amount < 0) return m;
    }
    return null;
  };

  /** The earliest month after `month` from which RTA stays at or above `amount` (settled months aside). */
  const absorbingMonth = (month: string, amount: number): string | null => {
    for (let m = addMonths(month, 1); m <= lastMonth; m = addMonths(m, 1)) {
      if (blockingMonth(m, amount) === null) return m;
    }
    return null;
  };

  const blockedReason = (month: string, amount: number) => {
    const short = model.months.filter((m) => m >= month && !settled(m) && sim.readyToAssign(m) - amount < 0);
    const first = short[0] ?? sim.worstMonthFrom(month);
    const rta = first ? sim.readyToAssign(first) : 0;
    if (rta < 0) return `blocked by negative Ready to Assign in ${first?.substring(0, 7)} (${formatCurrency(rta)}); fix that first`;
    const where = short.length > 1
      ? `${short.length} months (${short[0]!.substring(0, 7)} to ${short[short.length - 1]!.substring(0, 7)}; ${first!.substring(0, 7)} has ${formatCurrency(rta)})`
      : `${(first ?? month).substring(0, 7)} (it has ${formatCurrency(rta)})`;
    return `covering it would push Ready to Assign below zero in ${where}, and no category held enough unused money over that time to bridge it`;
  };

  /**
   * Fund `amount` into a category in a month: Ready to Assign first, then a bridge (asked
   * for, with askBeforeBridging, unless already answered in bridgeSources).
   */
  const fund = (kind: RepairKind, month: string, categoryId: string, label: string, amount: number, group?: string): { funded: number; asked: boolean } => {
    const before = sim.netChanges();
    const key = repairKey(kind, month, categoryId);
    const choice = bridgeSources[key];
    const tag = { key, ...(group ? { group } : {}) };
    if (blockingMonth(month, amount) === null || allowNegativeReadyToAssign || choice === READY_TO_ASSIGN) {
      sim.change(month, categoryId, amount);
      repairs.push({
        ...tag, kind, month, categoryId, label, amount, method: "ready_to_assign", sources: [],
        changes: diff(before, sim.netChanges()),
      });
      return { funded: amount, asked: false };
    }
    const giveBack = absorbingMonth(month, amount);
    const bridged = (b: Bridge) => {
      applyBridge(month, b);
      sim.change(month, categoryId, b.found);
      repairs.push({
        ...tag, kind, month, categoryId, label, amount: b.found, method: "bridge", sources: b.sources,
        changes: diff(before, sim.netChanges()),
      });
      return { funded: b.found, asked: false };
    };
    let reason: string | undefined;
    if (choice) {
      const spare = giveBack && choice !== categoryId && isBridgeSource(choice, month) ? spareOf(choice, month, giveBack) : 0;
      if (giveBack && spare >= amount - SUB_CENT) {
        return bridged({ giveBack, sources: [{ categoryId: choice, label: model.categoryLabel(choice), amount }], found: amount });
      }
      reason = giveBack
        ? `${model.categoryLabel(choice)} only had ${formatCurrency(spare)} unused from ${month.substring(0, 7)} to ${addMonths(giveBack, -1).substring(0, 7)}`
        : `Ready to Assign never has room to give borrowed money back`;
    }
    if (askBeforeBridging) {
      const options = giveBack
        ? lenders(month, categoryId, giveBack).filter((c) => c.spare >= amount - SUB_CENT).slice(0, 3)
          .map((c) => ({ categoryId: c.id, label: model.categoryLabel(c.id), spare: c.spare }))
        : [];
      const short = model.months.filter((m) => m >= month && !settled(m) && sim.readyToAssign(m) - amount < 0);
      const lowest = short.reduce<{ month: string; readyToAssign: number } | null>((low, m) => {
        const v = sim.readyToAssign(m) - amount;
        return !low || v < low.readyToAssign ? { month: m, readyToAssign: v } : low;
      }, null);
      proposals.push({
        ...tag, kind, month, categoryId, label, amount, giveBack, options,
        readyToAssignAnyway: lowest ? { months: short, lowest } : null, ...(reason ? { reason } : {}),
      });
      return { funded: 0, asked: true };
    }
    const b = findBridge(month, amount, categoryId, giveBack);
    return b ? bridged(b) : { funded: 0, asked: false };
  };

  // 2. Overspends.
  for (const o of [...findings.overspends].sort((a, b) => a.month.localeCompare(b.month))) {
    const { funded, asked } = fund("overspend", o.month, o.categoryId, o.category, o.amount);
    if (!asked && o.amount - funded >= SUB_CENT) {
      unresolved.push({
        kind: "overspend",
        month: o.month,
        categoryId: o.categoryId,
        label: o.category,
        amount: o.amount,
        shortBy: o.amount - funded,
        reason: blockedReason(o.month, o.amount - funded),
      });
    }
  }

  // 3. Card gaps.
  const creditKeys = new Set(findings.overspends.filter((o) => o.credit > 0).map((o) => `${o.categoryId}|${o.month}`));
  // A cover waiting for an answer is pending too: card gaps wait for it either way.
  const coversPending = [...repairs, ...proposals].some((r) => r.kind === "overspend" && creditKeys.has(`${r.categoryId}|${r.month}`));
  if (!coversPending) {
    for (const card of findings.cards) {
      if (card.skipped || !card.paymentCategoryId) continue;
      const label = `${card.card} payment`;
      const group = `card:${card.cardId}`;
      // All or nothing per card: gap changes often come in pairs (too much one
      // month, too little the next), and fixing only one half makes it worse.
      const checkpoint = { repairs: repairs.length, unresolved: unresolved.length, sim: sim.snapshot() };
      let blocked = false;
      for (const m of card.months) {
        if (Math.abs(m.change) < SUB_CENT) continue;
        if (m.change < 0) {
          const before = sim.netChanges();
          sim.change(m.month, card.paymentCategoryId, m.change);
          repairs.push({
            key: repairKey("card_gap", m.month, card.paymentCategoryId), group,
            kind: "card_gap", month: m.month, categoryId: card.paymentCategoryId, label, amount: m.change,
            method: "release", sources: [], changes: diff(before, sim.netChanges()),
          });
          continue;
        }
        const { funded, asked } = fund("card_gap", m.month, card.paymentCategoryId, label, m.change, group);
        if (asked) { blocked = true; continue; }
        if (m.change - funded >= SUB_CENT) {
          blocked = true;
          unresolved.push({
            kind: "card_gap", month: m.month, categoryId: card.paymentCategoryId, label, amount: m.change,
            shortBy: m.change - funded, reason: blockedReason(m.month, m.change - funded),
          });
        }
      }
      if (blocked) {
        const kept = unresolved.slice(checkpoint.unresolved);
        repairs.length = checkpoint.repairs;
        unresolved.length = checkpoint.unresolved;
        sim.restore(checkpoint.sim);
        for (const u of kept) unresolved.push({ ...u, reason: `${u.reason}; ${card.card}'s other gap fixes are held back with it` });
      }
    }
  }

  const writes = sim.netChanges().map((c) => {
    const from = model.monthCategory(c.month, c.categoryId)?.budgeted ?? 0;
    return { month: c.month, categoryId: c.categoryId, label: model.categoryLabel(c.categoryId), from, to: from + c.delta };
  });

  return {
    repairs,
    proposals,
    unresolved,
    deferredCardGaps: coversPending,
    writes,
    readyToAssignChange: sim.readyToAssign(current) - (model.toBeBudgeted.get(current) ?? 0),
  };
}

/** The changes in `after` that are not already in `before`. */
function diff(before: AssignmentChange[], after: AssignmentChange[]): AssignmentChange[] {
  const prior = new Map(before.map((c) => [`${c.categoryId}|${c.month}`, c.delta]));
  return after
    .map((c) => ({ ...c, delta: c.delta - (prior.get(`${c.categoryId}|${c.month}`) ?? 0) }))
    .filter((c) => c.delta !== 0);
}
