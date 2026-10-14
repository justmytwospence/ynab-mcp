import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { getClient } from "../ynab-client.js";
import { getBudgetSnapshot, invalidateBudgetSnapshot } from "../budget-snapshot.js";
import { textResult, errorResult, jsonResult, formatCurrency } from "../utils/formatting.js";
import { describeError } from "../utils/errors.js";
import { BudgetModel } from "./lib/budget-model.js";
import { findIntegrityProblems, planRepairs, type Findings, type RepairPlan, type Repair } from "./lib/integrity.js";
import { planMonth, type MonthPlan } from "./lib/month-plan.js";
import { suggestCategories, type Suggestion } from "./lib/categorize.js";
import { planEnrichment, type EnrichPlan } from "./lib/enrich.js";
import { ItemStore } from "./lib/item-store.js";

const budgetId = z.string().default("last-used").describe("Budget ID or 'last-used'");
const format = z.enum(["text", "json"]).default("text").describe("text for people, json for automation");
const today = z
  .string()
  .optional()
  .describe("Treat this date (YYYY-MM-DD) as today; months before its month are history. Default: today.");

const money = (m: number) => formatCurrency(m);
const month7 = (m: string) => m.substring(0, 7);

export function registerStewardTools(server: McpServer) {
  server.registerTool("audit_budget_integrity", {
    title: "Audit Budget Integrity",
    description:
      "[1 API call to audit, +1 per write] [Workflow] Finds what makes later numbers untrustworthy, across every " +
      "month from the cached export: overspent category-months (a re-categorized old transaction leaves these " +
      "behind; cash ones come out of the next month's Ready to Assign, credit ones become card debt), months whose " +
      "Ready to Assign went negative, uncategorized spending, and every month-end where a card's payment category " +
      "Available differs from what the card owes. Plans repairs: cover from Ready to Assign when that month and every " +
      "later one can afford it, otherwise 'bridge' from categories holding unused money and give it back when Ready " +
      "to Assign can absorb it, so today's balances are unchanged. Card gaps are planned once no credit cover is " +
      "pending (run again after applying). apply=true writes the plan (assigned amounts in past months).",
    inputSchema: z.object({
      budget_id: budgetId,
      since_month: z.string().optional().describe("Only audit months on or after this (YYYY-MM-01)"),
      include_current_month: z.boolean().default(true).describe("Also cover the current month's overspending"),
      apply: z.boolean().default(false).describe("Write the repair plan (default false: audit only)"),
      allow_negative_ready_to_assign: z.boolean().default(false).describe("Last resort: cover even when Ready to Assign goes negative somewhere"),
      protected_groups: z.array(z.string()).default([]).describe("Category group names never used as bridge sources"),
      max_writes: z.number().int().default(60).describe("Stop applying after this many writes (whole repairs only)"),
      today,
      format,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args) => {
    try {
      const { snapshot, apiCalls } = await getBudgetSnapshot(args.budget_id);
      const model = new BudgetModel(snapshot, args.today);
      const findings = findIntegrityProblems(model, {
        sinceMonth: args.since_month,
        includeCurrentMonth: args.include_current_month,
      });
      const plan = planRepairs(model, findings, {
        allowNegativeReadyToAssign: args.allow_negative_ready_to_assign,
        protectedGroups: args.protected_groups,
      });
      const applied = args.apply ? await applyRepairs(snapshot.budgetId, model, plan.repairs, args.max_writes) : null;
      if (applied) invalidateBudgetSnapshot(args.budget_id);
      const calls = apiCalls + (applied?.writes ?? 0);
      if (args.format === "json") return jsonResult({ findings, plan, applied, api_calls: calls });
      return textResult(renderIntegrity(findings, plan, applied, calls));
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool("plan_month", {
    title: "Plan Month",
    description:
      "[1 API call to plan, +1 per write] [Workflow] Budgets a month by the house rules: every Variable Costs " +
      "category gets what it spent the month before (run after that month closes), every Fixed Costs goal is " +
      "funded to its target (assigned + underfunded), other groups are untouched. Flags fixed costs charged with " +
      "no goal, goals whose charge stopped, and monthly charges that no longer match their goal. apply=true writes " +
      "the changed categories, only if Ready to Assign covers the increase.",
    inputSchema: z.object({
      budget_id: budgetId,
      month: z.string().describe("Month to plan (YYYY-MM-01), or 'current' / 'next'"),
      variable_group: z.string().default("Variable Costs"),
      fixed_group: z.string().default("Fixed Costs"),
      apply: z.boolean().default(false),
      today,
      format,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => {
    try {
      const { snapshot, apiCalls } = await getBudgetSnapshot(args.budget_id);
      const model = new BudgetModel(snapshot, args.today);
      const month =
        args.month === "current" ? model.currentMonth
          : args.month === "next" ? nextMonth(model.currentMonth)
            : args.month;
      const plan = planMonth(model, month, { variableGroup: args.variable_group, fixedGroup: args.fixed_group });
      let applied: { writes: number; failed: string[]; skipped?: string } | null = null;
      if (args.apply) {
        if (!plan.affordable) {
          applied = { writes: 0, failed: [], skipped: "Ready to Assign does not cover the increase" };
        } else {
          applied = { writes: 0, failed: [] };
          for (const line of plan.lines) {
            try {
              await getClient().categories.updateMonthCategory(snapshot.budgetId, month, line.categoryId, {
                category: { budgeted: line.target },
              });
              applied.writes += 1;
            } catch (e) {
              applied.writes += 1;
              applied.failed.push(`${line.label}: ${describeError(e)}`);
            }
          }
          invalidateBudgetSnapshot(args.budget_id);
        }
      }
      const calls = apiCalls + (applied?.writes ?? 0);
      if (args.format === "json") return jsonResult({ plan, applied, api_calls: calls });
      return textResult(renderPlan(plan, applied, calls));
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool("suggest_categories", {
    title: "Suggest Categories",
    description:
      "[1 API call to suggest, +1 to apply] [Workflow] For uncategorized spending and unapproved transactions, " +
      "suggests a category from your own history: same payee and amount first (a recurring subscription from a " +
      "payee that sells many things), then payee alone. 'obvious' means at least min_count agreeing past " +
      "transactions (2 for an amount match) and min_share of them. apply=true updates every obvious suggestion in " +
      "one bulk call, and approve=true also approves them. Ambiguous ones are returned with their top candidates.",
    inputSchema: z.object({
      budget_id: budgetId,
      include_unapproved: z.boolean().default(true),
      history_months: z.number().int().default(24),
      min_count: z.number().int().default(3),
      min_share: z.number().default(0.9),
      apply: z.boolean().default(false),
      approve: z.boolean().default(false).describe("Also approve the obvious ones when applying"),
      today,
      format,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => {
    try {
      const { snapshot, apiCalls } = await getBudgetSnapshot(args.budget_id);
      const model = new BudgetModel(snapshot, args.today);
      const suggestions = suggestCategories(model, {
        historyMonths: args.history_months,
        minCount: args.min_count,
        minShare: args.min_share,
        includeUnapproved: args.include_unapproved,
      });
      let applied: { updated: number; error?: string } | null = null;
      let calls = apiCalls;
      if (args.apply) {
        const updates = suggestions
          .filter((s) => s.obvious && s.suggestion && (s.changes || (args.approve && !s.approved)))
          .map((s) => ({
            id: s.transactionId,
            category_id: s.suggestion!.categoryId,
            ...(args.approve ? { approved: true } : {}),
          }));
        applied = { updated: 0 };
        if (updates.length > 0) {
          try {
            const res = await getClient().transactions.updateTransactions(snapshot.budgetId, { transactions: updates });
            applied.updated = res.data.transactions?.length ?? updates.length;
          } catch (e) {
            applied.error = describeError(e);
          }
          calls += 1;
          invalidateBudgetSnapshot(args.budget_id);
        }
      }
      if (args.format === "json") return jsonResult({ suggestions, applied, api_calls: calls });
      return textResult(renderSuggestions(suggestions, applied, calls));
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool("enrich_transactions", {
    title: "Enrich Transactions From Receipts",
    description:
      "[1 API call to plan, +1 per split, +1 for the rest] [Workflow] Matches receipts (Apple email receipts, Amazon " +
      "payments with their order items) to YNAB transactions by payee, exact amount and date (+/- date_slack_days), " +
      "and writes the real product names into the memo. Items with a remembered category categorize the " +
      "transaction; items in several categories split it, sharing the charge (tax included) by item price. Nothing " +
      "is split until every item has a category, since a split cannot be edited through the API. Unknown items are " +
      "returned with the category list; teach them with `assign` (remembered for next time). Amounts in receipts " +
      "are dollars.",
    inputSchema: z.object({
      budget_id: budgetId,
      receipts: z.array(z.object({
        id: z.string().describe("Stable receipt id: Apple order id, Amazon order number + charge date"),
        source: z.string().describe("'apple' or 'amazon' (selects the payee pattern), or a payee name"),
        date: z.string().describe("Charge date YYYY-MM-DD"),
        total: z.number().describe("Amount charged in dollars; negative for a refund"),
        items: z.array(z.object({
          key: z.string().describe("Stable item identity: ASIN, product name"),
          name: z.string(),
          amount: z.number().default(0).describe("Item price in dollars (tax may be excluded)"),
        })).default([]),
      })).default([]),
      assign: z.array(z.object({
        source: z.string(),
        key: z.string(),
        name: z.string().default(""),
        category_id: z.string(),
      })).default([]).describe("Item -> category mappings to plan with; remembered only when apply=true"),
      date_slack_days: z.number().int().default(7),
      apply: z.boolean().default(false),
      format,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => {
    try {
      const { snapshot, apiCalls } = await getBudgetSnapshot(args.budget_id);
      const model = new BudgetModel(snapshot);
      const store = ItemStore.open();
      for (const a of args.assign) {
        if (!model.categories.has(a.category_id)) throw new Error(`Unknown category ${a.category_id} for ${a.source}:${a.key}`);
        store.setCategory(a.source, a.key, a.name || a.key, a.category_id);
      }
      // A dry run plans with the new mappings but does not remember them.
      if (args.assign.length > 0 && args.apply) store.save();
      const receipts = args.receipts.map((r) => ({
        ...r,
        total: Math.round(r.total * 1000),
        items: r.items.map((i) => ({ ...i, amount: Math.round(i.amount * 1000) })),
      }));
      const plan = planEnrichment(model, store, receipts, { dateSlackDays: args.date_slack_days });
      let calls = apiCalls;
      const applied = { updated: 0, split: 0, failed: [] as string[] };
      if (args.apply && plan.updates.length > 0) {
        const client = getClient();
        const plain = plan.updates.filter((u) => !u.subtransactions);
        if (plain.length > 0) {
          try {
            await client.transactions.updateTransactions(snapshot.budgetId, {
              transactions: plain.map((u) => ({ id: u.transactionId, memo: u.memo, ...(u.categoryId ? { category_id: u.categoryId } : {}) })),
            });
            applied.updated += plain.length;
            for (const u of plain) if (!u.pending && u.categoryId) store.markEnriched(u.transactionId, u.receiptId);
          } catch (e) {
            applied.failed.push(`bulk update: ${describeError(e)}`);
          }
          calls += 1;
        }
        for (const u of plan.updates.filter((x) => x.subtransactions)) {
          try {
            await client.transactions.updateTransaction(snapshot.budgetId, u.transactionId, {
              transaction: { memo: u.memo, subtransactions: u.subtransactions },
            });
            applied.split += 1;
            store.markEnriched(u.transactionId, u.receiptId);
          } catch (e) {
            applied.failed.push(`split ${u.transactionId}: ${describeError(e)}`);
          }
          calls += 1;
        }
        store.save();
        invalidateBudgetSnapshot(args.budget_id);
      }
      const categories = plan.unknownItems.length > 0
        ? Array.from(model.categories.values())
            .filter((c) => !c.hidden && !model.internalIds.has(c.id))
            .map((c) => ({ id: c.id, label: model.categoryLabel(c.id) }))
        : [];
      const result = { plan, applied: args.apply ? applied : null, categories, api_calls: calls };
      if (args.format === "json") return jsonResult(result);
      return textResult(renderEnrich(plan, args.apply ? applied : null, model, calls));
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool("list_item_categories", {
    title: "List Remembered Item Categories",
    description: "[0 API calls] The item -> category mappings enrich_transactions has learned.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const items = ItemStore.open().list();
    return textResult(items.length === 0 ? "No item mappings yet." : items.map((i) => `${i.key} (${i.name}) -> ${i.categoryId}`).join("\n"));
  });
}

function nextMonth(month: string): string {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().substring(0, 10);
}

interface Applied {
  repairs: number;
  writes: number;
  failed: string[];
  stoppedAt?: string;
}

/**
 * Write repairs in plan order. Each write sets an absolute assigned amount, so
 * a running value per (month, category) carries repairs that touch the same
 * cell. Only whole repairs are written, so a bridge is never left half done by
 * the write cap; a failed write stops everything after it.
 */
async function applyRepairs(budgetId: string, model: BudgetModel, repairs: Repair[], maxWrites: number): Promise<Applied> {
  const running = new Map<string, number>();
  const result: Applied = { repairs: 0, writes: 0, failed: [] };
  for (const repair of repairs) {
    if (result.writes + repair.changes.length > maxWrites) {
      result.stoppedAt = `write cap ${maxWrites} reached before ${repair.kind} ${month7(repair.month)} ${repair.label}`;
      break;
    }
    for (const change of repair.changes) {
      const key = `${change.categoryId}|${change.month}`;
      const from = running.get(key) ?? model.monthCategory(change.month, change.categoryId)?.budgeted ?? 0;
      const to = from + change.delta;
      try {
        await getClient().categories.updateMonthCategory(budgetId, change.month, change.categoryId, {
          category: { budgeted: to },
        });
        running.set(key, to);
        result.writes += 1;
      } catch (e) {
        result.writes += 1;
        result.failed.push(`${month7(change.month)} ${model.categoryLabel(change.categoryId)}: ${describeError(e)}`);
        result.stoppedAt = `a write failed; re-run to continue`;
        return result;
      }
    }
    result.repairs += 1;
  }
  return result;
}

function renderIntegrity(findings: Findings, plan: RepairPlan, applied: Applied | null, calls: number): string {
  const lines: string[] = [`Budget integrity (current month ${month7(findings.currentMonth)})`];

  lines.push(``, `Overspent category-months: ${findings.overspends.length}`);
  for (const o of findings.overspends) {
    lines.push(
      `  ${month7(o.month)} ${o.category}: ${money(-o.amount)}` +
        (o.credit > 0 ? ` (${money(o.credit)} on credit)` : "") +
        (o.isCurrentMonth ? " [current month]" : "")
    );
    for (const t of o.transactions) lines.push(`      ${t.date} ${t.payee} ${money(t.amount)} (${t.account}) [${t.id}]`);
    if (o.transactions.length === 0) lines.push(`      no spending that month: a negative assigned amount`);
  }

  lines.push(``, `Negative Ready to Assign months: ${findings.negativeReadyToAssign.length}`);
  for (const r of findings.negativeReadyToAssign) lines.push(`  ${month7(r.month)}: ${money(r.amount)}`);

  if (findings.uncategorized.length > 0) {
    lines.push(``, `Uncategorized spending (categorize it; suggest_categories helps):`);
    for (const u of findings.uncategorized) {
      lines.push(`  ${month7(u.month)}: ${money(-u.amount)}`);
      for (const t of u.transactions) lines.push(`      ${t.date} ${t.payee} ${money(t.amount)} (${t.account}) [${t.id}]`);
    }
  }

  lines.push(``, `Card month-ends where payment Available != amount owed:`);
  for (const c of findings.cards) {
    if (c.skipped) {
      lines.push(`  ${c.card}: skipped, ${c.skipped}`);
      continue;
    }
    if (c.months.length === 0) {
      lines.push(`  ${c.card}: every month-end matches`);
      continue;
    }
    lines.push(`  ${c.card}: ${c.months.length} month(s) off`);
    for (const m of c.months) {
      if (Math.abs(m.change) < 10) continue;
      lines.push(
        `    ${month7(m.month)}: owed ${money(m.owed)}, available ${money(m.available)}, gap ${money(m.gap)} ` +
          `(changed ${money(m.change)}` +
          (m.creditOverspending ? `; credit overspending ${money(m.creditOverspending)}` : "") +
          `)`
      );
    }
  }

  lines.push(``, `Repair plan: ${plan.repairs.length} repair(s), ${plan.writes.length} write(s)`);
  for (const r of plan.repairs) {
    const how =
      r.method === "bridge"
        ? `bridge from ${r.sources.map((s) => `${s.label} ${money(s.amount)}`).join(", ")}`
        : r.method === "release" ? "release from the payment category" : "from Ready to Assign";
    lines.push(`  ${r.kind} ${month7(r.month)} ${r.label}: ${money(r.amount)} ${how}`);
  }
  if (plan.deferredCardGaps) lines.push(`  Card gaps are planned after these covers are applied (they move card money).`);
  if (plan.unresolved.length > 0) {
    lines.push(``, `Needs a decision (${plan.unresolved.length}):`);
    for (const u of plan.unresolved) lines.push(`  ${u.kind} ${month7(u.month)} ${u.label}: ${money(u.shortBy)} short, ${u.reason}`);
  }
  lines.push(``, `Cost to today's Ready to Assign: ${money(-plan.readyToAssignChange)}`);

  if (applied) {
    lines.push(``, `Applied ${applied.repairs} repair(s) in ${applied.writes} write(s).`);
    for (const f of applied.failed) lines.push(`  failed: ${f}`);
    if (applied.stoppedAt) lines.push(`  stopped: ${applied.stoppedAt}`);
  } else if (plan.repairs.length > 0) {
    lines.push(`Set apply=true to write it.`);
  }
  lines.push(`API calls used: ${calls}`);
  return lines.join("\n");
}

function renderPlan(plan: MonthPlan, applied: { writes: number; failed: string[]; skipped?: string } | null, calls: number): string {
  const lines = [`Plan for ${month7(plan.month)} (variable costs from ${month7(plan.basedOn)} spending)`];
  for (const l of plan.lines) lines.push(`  ${l.label}: ${money(l.current)} -> ${money(l.target)} (${l.rule})`);
  if (plan.lines.length === 0) lines.push(`  Nothing to change.`);
  lines.push(
    ``,
    `Net change ${money(plan.increase)}; Ready to Assign from ${month7(plan.month)} on: ${money(plan.readyToAssign)}` +
      (plan.affordable ? "" : " - NOT ENOUGH")
  );
  if (plan.flags.length > 0) {
    lines.push(``, `Fixed costs to look at:`);
    for (const f of plan.flags) lines.push(`  ${f.label}: ${f.issue.replace(/_/g, " ")} - ${f.detail}`);
  }
  if (applied) {
    lines.push(``, applied.skipped ? `Not applied: ${applied.skipped}` : `Applied ${applied.writes - applied.failed.length} write(s).`);
    for (const f of applied.failed) lines.push(`  failed: ${f}`);
  }
  lines.push(`API calls used: ${calls}`);
  return lines.join("\n");
}

function renderSuggestions(suggestions: Suggestion[], applied: { updated: number; error?: string } | null, calls: number): string {
  const obvious = suggestions.filter((s) => s.obvious);
  const ambiguous = suggestions.filter((s) => !s.obvious);
  const line = (s: Suggestion) =>
    `  ${s.date} ${s.payee} ${money(s.amount)} (${s.account})${s.currentLabel ? ` now ${s.currentLabel}` : " uncategorized"}` +
    (s.suggestion ? ` -> ${s.suggestion.label} (${Math.round(s.confidence * 100)}% of ${s.suggestion.count}, by ${s.basis})` : " -> no history") +
    ` [${s.transactionId}]`;
  const lines = [`Obvious (${obvious.length}):`, ...obvious.map(line), ``, `Ambiguous (${ambiguous.length}):`];
  for (const s of ambiguous) {
    lines.push(line(s));
    if (s.candidates.length > 1) {
      lines.push(`      candidates: ${s.candidates.map((c) => `${c.label} ${Math.round(c.share * 100)}%`).join(", ")}`);
    }
  }
  if (applied) lines.push(``, applied.error ? `Apply failed: ${applied.error}` : `Updated ${applied.updated} transaction(s).`);
  lines.push(`API calls used: ${calls}`);
  return lines.join("\n");
}

function renderEnrich(plan: EnrichPlan, applied: { updated: number; split: number; failed: string[] } | null, model: BudgetModel, calls: number): string {
  const lines = [`Matched ${plan.updates.length} receipt(s); ${plan.alreadyDone} already done; ${plan.unmatched.length} unmatched.`];
  for (const u of plan.updates) {
    const what = u.subtransactions
      ? `split ${u.subtransactions.map((s) => `${model.categoryLabel(s.category_id)} ${money(s.amount)}`).join(", ")}`
      : u.categoryId ? `-> ${model.categoryLabel(u.categoryId)}` : u.pending ? "(memo only: items need categories)" : "(memo only)";
    lines.push(`  ${u.date} ${u.payee} ${money(u.amount)}: "${u.memo}" ${what}`);
  }
  if (plan.unknownItems.length > 0) {
    lines.push(``, `Items without a category (teach with assign):`);
    for (const i of plan.unknownItems) lines.push(`  ${i.source}:${i.key} "${i.name}"`);
  }
  for (const u of plan.unmatched) lines.push(`  unmatched ${u.source} ${u.date} ${money(u.total)} (${u.receiptId}): ${u.reason}`);
  if (applied) {
    lines.push(``, `Updated ${applied.updated}, split ${applied.split}.`);
    for (const f of applied.failed) lines.push(`  failed: ${f}`);
  }
  lines.push(`API calls used: ${calls}`);
  return lines.join("\n");
}
