import { BudgetModel, SUB_CENT, addMonths } from "./budget-model.js";

/**
 * Next month's assignments, by the house rules:
 *
 * - Variable Costs: assign what the category spent last month (YNAB's
 *   "Spent Last Month"), so run this once last month is closed.
 * - Fixed Costs: fund each goal (assigned + goal_under_funded), and flag the
 *   ones that need attention: charges with no goal, goals whose charge stopped,
 *   and charges that no longer match the goal.
 * - Every other group is left alone.
 */

export interface PlanLine {
  categoryId: string;
  label: string;
  group: "variable" | "fixed";
  rule: string;
  current: number;
  target: number;
  delta: number;
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
  lines: PlanLine[];
  flags: PlanFlag[];
  increase: number;
  /** Lowest Ready to Assign from the month on, before the plan. */
  readyToAssign: number;
  affordable: boolean;
}

export interface MonthPlanOptions {
  variableGroup?: string;
  fixedGroup?: string;
}

export function planMonth(model: BudgetModel, month: string, options: MonthPlanOptions = {}): MonthPlan {
  const { variableGroup = "Variable Costs", fixedGroup = "Fixed Costs" } = options;
  const target = model.monthCategories.get(month);
  if (!target) throw new Error(`Month ${month} is not in the budget (it has ${model.months[0]} to ${model.months.at(-1)}).`);
  const previous = addMonths(month, -1);
  const lines: PlanLine[] = [];
  const flags: PlanFlag[] = [];

  for (const c of target.values()) {
    if (c.hidden || model.internalIds.has(c.id)) continue;
    const group = model.groupOf(c.id)?.trim();
    const label = model.categoryLabel(c.id);

    if (group === variableGroup) {
      const activity = model.monthCategory(previous, c.id)?.activity ?? 0;
      const spent = Math.max(0, -activity);
      lines.push({
        categoryId: c.id, label, group: "variable", rule: `spent in ${previous.substring(0, 7)}`,
        current: c.budgeted, target: spent, delta: spent - c.budgeted,
      });
      continue;
    }

    if (group !== fixedGroup) continue;
    const outflows = recentOutflows(model, c.id, month, 12);
    if (!c.goal_type) {
      if (outflows.length > 0) {
        flags.push({
          categoryId: c.id, label, issue: "no_goal",
          detail: `${outflows.length} charge(s) in the last 12 months, latest ${outflows[0]!.date} ${outflows[0]!.amount}`,
        });
      }
      continue;
    }
    if (c.goal_snoozed_at) continue;
    const underFunded = c.goal_under_funded ?? 0;
    lines.push({
      categoryId: c.id, label, group: "fixed", rule: "goal underfunded",
      current: c.budgeted, target: c.budgeted + underFunded, delta: underFunded,
    });

    // A goal repeating every N months should have seen a charge within 2N months.
    const cycle = cycleMonths(c.goal_cadence, c.goal_cadence_frequency);
    if (cycle && c.goal_creation_month && c.goal_creation_month <= addMonths(month, -2 * cycle)) {
      const window = recentOutflows(model, c.id, month, 2 * cycle);
      if (window.length === 0) {
        flags.push({
          categoryId: c.id, label, issue: "goal_without_charges",
          detail: `goal ${c.goal_target} repeats every ${cycle} month(s) but nothing was charged in the last ${2 * cycle}`,
        });
      }
    }
    // A charge that no longer matches a goal it fully funds: price change.
    const latest = outflows[0];
    if (latest && c.goal_target && Math.abs(-latest.amount - c.goal_target) >= SUB_CENT && cycle === 1) {
      flags.push({
        categoryId: c.id, label, issue: "charge_differs_from_goal",
        detail: `latest charge ${-latest.amount} on ${latest.date} vs goal ${c.goal_target}`,
      });
    }
  }

  const changed = lines.filter((l) => Math.abs(l.delta) >= SUB_CENT);
  const increase = changed.reduce((s, l) => s + l.delta, 0);
  let readyToAssign = Number.POSITIVE_INFINITY;
  for (const m of model.months) if (m >= month) readyToAssign = Math.min(readyToAssign, model.toBeBudgeted.get(m) ?? 0);
  if (readyToAssign === Number.POSITIVE_INFINITY) readyToAssign = 0;

  return {
    month,
    basedOn: previous,
    lines: changed.sort((a, b) => a.label.localeCompare(b.label)),
    flags,
    increase,
    readyToAssign,
    affordable: increase <= readyToAssign,
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
