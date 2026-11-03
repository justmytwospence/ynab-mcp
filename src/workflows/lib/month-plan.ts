import { BudgetModel, SUB_CENT, addMonths } from "./budget-model.js";
import { formatCurrency } from "../../utils/formatting.js";

/**
 * A month's assignments by rules the caller gives. The server holds no house rules: a
 * category takes the first rule that selects it (by group name or category id), and
 * categories no rule selects are left alone.
 *
 * - spent: what the category spent in the month before (YNAB's "Spent Last Month").
 *   whenNothingSpent "source_budgeted" uses that month's assigned amount instead of 0;
 *   atLeastSourceBudgeted never goes below that month's assigned amount, so a plan made
 *   while that month is still running does not shrink on its first small charge.
 * - goal: fund each active goal (assigned + goal_under_funded); with flags (default),
 *   report charges with no goal, goals whose charge stopped, and monthly charges that no
 *   longer match their goal.
 *
 * Only Ready to Assign pays for increases. funding "all_or_nothing" funds the whole plan or
 * nothing; "in_order" funds lines in rule order (decreases free their money first) until
 * Ready to Assign runs out, part-funding the line it runs out on.
 */

interface RuleTarget {
  group?: string;
  categoryIds?: string[];
}

export type PlanRule =
  | (RuleTarget & { kind: "spent"; whenNothingSpent?: "zero" | "source_budgeted"; atLeastSourceBudgeted?: boolean })
  | (RuleTarget & { kind: "goal"; flags?: boolean });

export type Funding = "all_or_nothing" | "in_order";

export interface PlanLine {
  categoryId: string;
  label: string;
  /** Index of the rule that set it. */
  rule: number;
  kind: PlanRule["kind"];
  /** Why this target, for people. */
  basis: string;
  current: number;
  target: number;
  delta: number;
  /** The part of delta Ready to Assign pays for: all of a decrease, 0..delta of an increase. */
  funded: number;
}

export interface PlanFlag {
  categoryId: string;
  label: string;
  issue: "no_goal" | "goal_without_charges" | "charge_differs_from_goal";
  detail: string;
}

export interface MonthPlan {
  month: string;
  basedOn: string;
  funding: Funding;
  lines: PlanLine[];
  flags: PlanFlag[];
  /** Net change if every line were funded. */
  increase: number;
  /** Net change the plan writes (sum of funded). */
  fundedIncrease: number;
  /** Increases Ready to Assign cannot pay for. */
  shortfall: number;
  /** Lowest Ready to Assign from the month on, before the plan. */
  readyToAssign: number;
  /** The whole plan fits in Ready to Assign. */
  affordable: boolean;
}

export interface MonthPlanOptions {
  funding?: Funding;
}

export function planMonth(model: BudgetModel, month: string, rules: PlanRule[], options: MonthPlanOptions = {}): MonthPlan {
  const funding = options.funding ?? "all_or_nothing";
  const target = model.monthCategories.get(month);
  if (!target) throw new Error(`Month ${month} is not in the budget (it has ${model.months[0]} to ${model.months.at(-1)}).`);
  if (rules.length === 0) throw new Error("Give at least one rule.");
  const groupNames = new Set(Array.from(model.groupNames.values(), (n) => n.trim()));
  rules.forEach((r, i) => {
    const n = i + 1;
    if ((r.group === undefined) === (r.categoryIds === undefined)) throw new Error(`Rule ${n}: give exactly one of group or category_ids.`);
    if (r.group !== undefined && !groupNames.has(r.group.trim())) throw new Error(`Rule ${n}: no category group named "${r.group}".`);
    for (const id of r.categoryIds ?? []) if (!model.categories.has(id)) throw new Error(`Rule ${n}: unknown category ${id}.`);
  });

  const previous = addMonths(month, -1);
  const source = previous.substring(0, 7);
  const lines: PlanLine[] = [];
  const flags: PlanFlag[] = [];
  const line = (categoryId: string, current: number, label: string, rule: number, kind: PlanRule["kind"], basis: string, value: number): PlanLine =>
    ({ categoryId, label, rule, kind, basis, current, target: value, delta: value - current, funded: 0 });

  for (const c of target.values()) {
    if (c.hidden || model.internalIds.has(c.id)) continue;
    const group = model.groupOf(c.id)?.trim();
    const index = rules.findIndex((r) => (r.categoryIds ? r.categoryIds.includes(c.id) : r.group!.trim() === group));
    if (index < 0) continue;
    const rule = rules[index]!;
    const label = model.categoryLabel(c.id);

    if (rule.kind === "spent") {
      const before = model.monthCategory(previous, c.id);
      const spent = Math.max(0, -(before?.activity ?? 0));
      const assigned = Math.max(0, before?.budgeted ?? 0);
      let value = spent;
      let basis = `spent in ${source}`;
      if (spent < SUB_CENT && rule.whenNothingSpent === "source_budgeted") {
        value = assigned;
        basis = `nothing spent in ${source}; its assigned`;
      }
      if (rule.atLeastSourceBudgeted && assigned > value) {
        value = assigned;
        basis = `${source}'s assigned (more than spent)`;
      }
      lines.push(line(c.id, c.budgeted, label, index, "spent", basis, value));
      continue;
    }

    const wantFlags = rule.flags !== false;
    const outflows = recentOutflows(model, c.id, month, 12);
    if (!c.goal_type) {
      if (wantFlags && outflows.length > 0) {
        flags.push({
          categoryId: c.id, label, issue: "no_goal",
          detail: `${outflows.length} charge(s) in the last 12 months, latest ${outflows[0]!.date} ${formatCurrency(-outflows[0]!.amount)}`,
        });
      }
      continue;
    }
    if (c.goal_snoozed_at) continue;
    lines.push(line(c.id, c.budgeted, label, index, "goal", "goal underfunded", c.budgeted + (c.goal_under_funded ?? 0)));
    if (!wantFlags) continue;

    // A goal repeating every N months should have seen a charge within 2N months.
    const cycle = cycleMonths(c.goal_cadence, c.goal_cadence_frequency);
    if (cycle && c.goal_creation_month && c.goal_creation_month <= addMonths(month, -2 * cycle)) {
      if (recentOutflows(model, c.id, month, 2 * cycle).length === 0) {
        flags.push({
          categoryId: c.id, label, issue: "goal_without_charges",
          detail: `goal ${formatCurrency(c.goal_target ?? 0)} repeats every ${cycle} month(s) but nothing was charged in the last ${2 * cycle}`,
        });
      }
    }
    // A charge that no longer matches a goal it fully funds: price change.
    const latest = outflows[0];
    if (latest && c.goal_target && Math.abs(-latest.amount - c.goal_target) >= SUB_CENT && cycle === 1) {
      flags.push({
        categoryId: c.id, label, issue: "charge_differs_from_goal",
        detail: `latest charge ${formatCurrency(-latest.amount)} on ${latest.date} vs goal ${formatCurrency(c.goal_target)}`,
      });
    }
  }

  const changed = lines
    .filter((l) => Math.abs(l.delta) >= SUB_CENT)
    .sort((a, b) => a.rule - b.rule || a.label.localeCompare(b.label));
  const increase = changed.reduce((s, l) => s + l.delta, 0);
  let readyToAssign = Number.POSITIVE_INFINITY;
  for (const m of model.months) if (m >= month) readyToAssign = Math.min(readyToAssign, model.toBeBudgeted.get(m) ?? 0);
  if (readyToAssign === Number.POSITIVE_INFINITY) readyToAssign = 0;
  const affordable = increase <= readyToAssign;

  if (funding === "all_or_nothing") {
    for (const l of changed) l.funded = affordable ? l.delta : 0;
  } else {
    let remaining = readyToAssign + changed.reduce((s, l) => s + Math.max(0, -l.delta), 0);
    for (const l of changed) {
      if (l.delta < 0) {
        l.funded = l.delta;
        continue;
      }
      l.funded = Math.max(0, Math.min(l.delta, remaining));
      remaining -= l.funded;
    }
  }

  return {
    month,
    basedOn: previous,
    funding,
    lines: changed,
    flags,
    increase,
    fundedIncrease: changed.reduce((s, l) => s + l.funded, 0),
    shortfall: changed.reduce((s, l) => s + (l.delta > 0 ? l.delta - l.funded : 0), 0),
    readyToAssign,
    affordable,
  };
}

/** Outflows in a category in the `months` months before `month`, newest first. */
function recentOutflows(model: BudgetModel, categoryId: string, month: string, months: number) {
  const out: { date: string; amount: number }[] = [];
  for (let i = 1; i <= months; i++) {
    for (const leg of model.legsFor(categoryId, addMonths(month, -i))) {
      if (leg.amount < 0) out.push({ date: leg.date, amount: leg.amount });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Goal cadence in months, or null for weekly / one-time goals. */
function cycleMonths(cadence: number | null | undefined, frequency: number | null | undefined): number | null {
  const every = frequency && frequency > 0 ? frequency : 1;
  if (cadence === 1) return every;
  if (cadence === 13) return 12 * every;
  if (cadence != null && cadence >= 3 && cadence <= 12) return frequency && frequency > 1 ? frequency : cadence;
  return null;
}
