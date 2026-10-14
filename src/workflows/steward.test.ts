import { test } from "node:test";
import assert from "node:assert/strict";
import type { BudgetSnapshot } from "../budget-snapshot.js";
import { BudgetModel } from "./lib/budget-model.js";
import { findIntegrityProblems, planRepairs } from "./lib/integrity.js";
import { planMonth } from "./lib/month-plan.js";
import { suggestCategories } from "./lib/categorize.js";

/* A tiny budget: one card, one checking account, three months. */

const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01"];
const TODAY = "2026-03-15";

interface Cell { budgeted?: number; activity?: number; balance: number; goal?: Record<string, unknown> }

function snapshot(opts: {
  cells: Record<string, Record<string, Cell>>; // category id -> month -> cell
  tbb: number[];
  transactions: { id: string; date: string; amount: number; account: string; category?: string | null; payee?: string; approved?: boolean; transfer?: string }[];
  groups?: Record<string, string>; // category id -> group name
  cardBalance?: number;
}): BudgetSnapshot {
  const groups = opts.groups ?? {};
  const groupNames = Array.from(new Set(["Credit Card Payments", "Internal Master Category", ...Object.values(groups)]));
  const groupId = (name: string) => `g-${name}`;
  const categoryIds = ["card-pay", "uncat", "rta", ...Object.keys(opts.cells).filter((c) => !["card-pay"].includes(c))];
  const internal = new Set(["card-pay", "uncat", "rta"]);
  const name = (id: string) => ({ "card-pay": "Card", uncat: "Uncategorized", rta: "Inflow: Ready to Assign" } as Record<string, string>)[id] ?? id;
  const group = (id: string) =>
    id === "card-pay" ? groupId("Credit Card Payments") : internal.has(id) ? groupId("Internal Master Category") : groupId(groups[id] ?? "Spending");
  const category = (id: string, cell?: Cell) => ({
    id, name: name(id), category_group_id: group(id), hidden: false, deleted: false, internal: internal.has(id),
    budgeted: cell?.budgeted ?? 0, activity: cell?.activity ?? 0, balance: cell?.balance ?? 0, ...(cell?.goal ?? {}),
  });
  const cardTx = opts.transactions.filter((t) => t.account === "card").reduce((s, t) => s + t.amount, 0);
  const plan = {
    id: "b", name: "b",
    accounts: [
      { id: "card", name: "Card", type: "creditCard", on_budget: true, closed: false, deleted: false, balance: opts.cardBalance ?? cardTx },
      { id: "chk", name: "Checking", type: "checking", on_budget: true, closed: false, deleted: false, balance: 0 },
    ],
    payees: [{ id: "p-apple", name: "Apple", deleted: false }, { id: "p-shop", name: "Shop", deleted: false }],
    category_groups: [...groupNames, "Spending"].map((n) => ({ id: groupId(n), name: n, hidden: false, deleted: false, internal: n === "Credit Card Payments" || n === "Internal Master Category" })),
    categories: categoryIds.map((id) => category(id)),
    months: MONTHS.map((m, i) => ({
      month: m, deleted: false, income: 0, budgeted: 0, activity: 0, to_be_budgeted: opts.tbb[i] ?? 0,
      categories: categoryIds.map((id) => category(id, opts.cells[id]?.[m] ?? { balance: 0 })),
    })),
    transactions: opts.transactions.map((t) => ({
      id: t.id, date: t.date, amount: t.amount, account_id: t.account, category_id: t.category ?? null,
      payee_id: t.payee ?? null, approved: t.approved ?? true, deleted: false, memo: null, cleared: "cleared",
      transfer_account_id: t.transfer ?? null,
    })),
    subtransactions: [],
  };
  return { budgetId: "b", plan: plan as never, serverKnowledge: 1, fetchedAt: 0, assembledPiecewise: false };
}

test("a past credit overspend is found and covered from Ready to Assign", () => {
  const snap = snapshot({
    cells: {
      food: { "2026-01-01": { activity: -50_000, balance: -50_000 } },
      "card-pay": { "2026-01-01": { balance: 0 }, "2026-02-01": { balance: 0 }, "2026-03-01": { balance: 0 } },
    },
    tbb: [500_000, 500_000, 500_000],
    transactions: [{ id: "t1", date: "2026-01-10", amount: -50_000, account: "card", category: "food" }],
  });
  const model = new BudgetModel(snap, TODAY);
  const findings = findIntegrityProblems(model);
  assert.equal(findings.overspends.length, 1);
  assert.equal(findings.overspends[0]!.credit, 50_000);
  assert.equal(findings.cards[0]!.months[0]!.gap, 50_000);
  const plan = planRepairs(model, findings);
  assert.equal(plan.repairs[0]!.method, "ready_to_assign");
  assert.deepEqual(plan.writes, [{ month: "2026-01-01", categoryId: "food", label: "Spending: food", from: 0, to: 50_000 }]);
  // The card gap is the same money: it must wait for the cover, not be fixed twice.
  assert.equal(plan.deferredCardGaps, true);
  assert.equal(plan.repairs.filter((r) => r.kind === "card_gap").length, 0);
});

test("an unaffordable cover is bridged from unused money and given back later", () => {
  const snap = snapshot({
    cells: {
      food: { "2026-01-01": { activity: -30_000, balance: -30_000 } },
      saved: { "2026-01-01": { budgeted: 100_000, balance: 100_000 }, "2026-02-01": { balance: 100_000 }, "2026-03-01": { balance: 100_000 } },
    },
    tbb: [0, 50_000, 50_000],
    transactions: [{ id: "t1", date: "2026-01-10", amount: -30_000, account: "chk", category: "food" }],
  });
  const model = new BudgetModel(snap, TODAY);
  const plan = planRepairs(model, findIntegrityProblems(model));
  const repair = plan.repairs[0]!;
  assert.equal(repair.method, "bridge");
  assert.deepEqual(repair.sources.map((s) => [s.categoryId, s.amount]), [["saved", 30_000]]);
  // Taken in January, given back in February, whose RTA can absorb it.
  assert.deepEqual(
    plan.writes.map((w) => [w.month, w.categoryId, w.to - w.from]),
    [["2026-01-01", "food", 30_000], ["2026-01-01", "saved", -30_000], ["2026-02-01", "saved", 30_000]]
  );
});

test("a negative Ready to Assign month is bridged to the following month", () => {
  const snap = snapshot({
    cells: { saved: { "2026-01-01": { budgeted: 80_000, balance: 80_000 }, "2026-02-01": { balance: 80_000 }, "2026-03-01": { balance: 80_000 } } },
    tbb: [-20_000, 10_000, 10_000],
    transactions: [],
  });
  const model = new BudgetModel(snap, TODAY);
  const findings = findIntegrityProblems(model);
  assert.deepEqual(findings.negativeReadyToAssign, [{ month: "2026-01-01", amount: -20_000 }]);
  const plan = planRepairs(model, findings);
  assert.equal(plan.repairs[0]!.kind, "rta_shortfall");
  assert.deepEqual(plan.writes.map((w) => [w.month, w.to - w.from]), [["2026-01-01", -20_000], ["2026-02-01", 20_000]]);
  assert.equal(plan.unresolved.length, 0);
});

test("with no covers pending, a card gap is assigned to the payment category in its month", () => {
  const snap = snapshot({
    cells: { "card-pay": { "2026-01-01": { balance: 40_000 }, "2026-02-01": { balance: 40_000 }, "2026-03-01": { balance: 40_000 } } },
    tbb: [500_000, 500_000, 500_000],
    transactions: [{ id: "t1", date: "2026-01-10", amount: -45_000, account: "card", category: "food" }],
  });
  const model = new BudgetModel(snap, TODAY);
  const plan = planRepairs(model, findIntegrityProblems(model));
  assert.deepEqual(plan.repairs.map((r) => [r.kind, r.month, r.amount]), [["card_gap", "2026-01-01", 5_000]]);
});

test("a sub-cent difference between transactions and balance does not skip the card", () => {
  const snap = snapshot({
    cells: {},
    tbb: [0, 0, 0],
    transactions: [{ id: "t1", date: "2026-01-10", amount: -8_539, account: "card", category: "food" }],
    cardBalance: -8_540,
  });
  const model = new BudgetModel(snap, TODAY);
  assert.equal(findIntegrityProblems(model).cards[0]!.skipped, undefined);
});

test("an amount match beats the payee's majority category", () => {
  const history = [
    ...[1, 2, 3].map((i) => ({ id: `s${i}`, date: `2026-0${i}-05`, amount: -990, account: "card", category: "icloud", payee: "p-apple" })),
    ...[1, 2, 3, 4, 5].map((i) => ({ id: `m${i}`, date: `2026-01-1${i}`, amount: -25_000 - i, account: "card", category: "misc", payee: "p-apple" })),
  ];
  const snap = snapshot({
    cells: { icloud: {}, misc: {} },
    tbb: [0, 0, 0],
    transactions: [
      ...history,
      { id: "new", date: "2026-03-05", amount: -990, account: "card", category: "misc", payee: "p-apple", approved: false },
      { id: "refund", date: "2026-03-06", amount: 5_000, account: "chk", category: null, payee: "p-shop" },
    ],
  });
  const model = new BudgetModel(snap, TODAY);
  const s = suggestCategories(model);
  assert.equal(s.length, 1, "an uncategorized inflow goes to Ready to Assign and needs no category");
  assert.equal(s[0]!.suggestion?.categoryId, "icloud");
  assert.equal(s[0]!.basis, "amount");
  assert.equal(s[0]!.obvious, true);
  assert.equal(s[0]!.changes, true);
});

test("plan_month: variable costs get last month's spending, fixed goals get funded", () => {
  const snap = snapshot({
    cells: {
      groceries: { "2026-02-01": { activity: -400_000, balance: 0 }, "2026-03-01": { budgeted: 300_000, balance: 300_000 } },
      rent: { "2026-03-01": { budgeted: 1_000_000, balance: 1_000_000, goal: { goal_type: "NEED", goal_target: 3_000_000, goal_under_funded: 2_000_000, goal_cadence: 1, goal_creation_month: "2025-01-01" } } },
      gym: {},
    },
    groups: { groceries: "Variable Costs", rent: "Fixed Costs", gym: "Fixed Costs" },
    tbb: [5_000_000, 5_000_000, 5_000_000],
    transactions: [
      { id: "g", date: "2026-02-03", amount: -40_000, account: "card", category: "gym" },
      { id: "r", date: "2026-02-01", amount: -3_000_000, account: "chk", category: "rent" },
    ],
  });
  const model = new BudgetModel(snap, TODAY);
  const plan = planMonth(model, "2026-03-01");
  assert.deepEqual(
    plan.lines.map((l) => [l.categoryId, l.target]),
    [["rent", 3_000_000], ["groceries", 400_000]]
  );
  assert.deepEqual(plan.flags.map((f) => [f.categoryId, f.issue]), [["gym", "no_goal"]]);
  assert.equal(plan.affordable, true);
});

import { ItemStore } from "./lib/item-store.js";
import { planEnrichment, prorate } from "./lib/enrich.js";

function enrichModel() {
  const snap = snapshot({
    cells: { groceries: {}, household: {} },
    tbb: [0, 0, 0],
    transactions: [
      { id: "amz", date: "2026-03-04", amount: -32_400, account: "card", category: "household", payee: "p-amazon" },
      { id: "apl", date: "2026-03-05", amount: -990, account: "card", category: null, payee: "p-apple" },
    ],
  });
  (snap.plan.payees as { id: string; name: string; deleted: boolean }[]).push({ id: "p-amazon", name: "Amazon", deleted: false });
  return new BudgetModel(snap, TODAY);
}

test("a receipt whose items span categories splits the charge by price, tax included", () => {
  const store = new ItemStore(null);
  store.setCategory("amazon", "B1", "Coffee", "groceries");
  store.setCategory("amazon", "B2", "Batteries", "household");
  const plan = planEnrichment(enrichModel(), store, [{
    id: "o1", source: "amazon", date: "2026-03-02", total: 32_400,
    items: [{ key: "B1", name: "Coffee", amount: 20_000 }, { key: "B2", name: "Batteries", amount: 10_000 }],
  }]);
  const u = plan.updates[0]!;
  assert.equal(u.transactionId, "amz");
  assert.equal(u.memo, "Amazon: Coffee; Batteries");
  assert.deepEqual(u.subtransactions!.map((s) => [s.category_id, s.amount]), [["groceries", -21_600], ["household", -10_800]]);
});

test("an unknown item only sets the memo and is reported", () => {
  const plan = planEnrichment(enrichModel(), new ItemStore(null), [{
    id: "a1", source: "apple", date: "2026-03-05", total: 990, items: [{ key: "iCloud+ 50 GB", name: "iCloud+ 50 GB", amount: 990 }],
  }]);
  assert.equal(plan.updates[0]!.memo, "iCloud+ 50 GB");
  assert.equal(plan.updates[0]!.pending, true);
  assert.equal(plan.updates[0]!.categoryId, undefined);
  assert.deepEqual(plan.unknownItems.map((i) => i.key), ["iCloud+ 50 GB"]);
});

test("a receipt with no matching amount is unmatched", () => {
  const plan = planEnrichment(enrichModel(), new ItemStore(null), [{ id: "x", source: "amazon", date: "2026-03-04", total: 1_000, items: [] }]);
  assert.equal(plan.unmatched.length, 1);
});

test("prorated legs always sum to the charge", () => {
  const legs = prorate(-10_000, new Map([["a", [{ key: "1", name: "1", amount: 1 }]], ["b", [{ key: "2", name: "2", amount: 1 }]], ["c", [{ key: "3", name: "3", amount: 1 }]]]));
  assert.equal(legs.reduce((s, l) => s + l.amount, 0), -10_000);
});

test("a card's gap fixes are all held back when any one of them cannot be funded", () => {
  // January: the payment category holds 10 too much; February: 10 too little, and RTA is empty.
  const snap = snapshot({
    cells: { "card-pay": { "2026-01-01": { balance: 60_000 }, "2026-02-01": { balance: 50_000 }, "2026-03-01": { balance: 50_000 } } },
    tbb: [0, 0, 0],
    transactions: [
      { id: "t1", date: "2026-01-10", amount: -50_000, account: "card", category: "food" },
      { id: "t2", date: "2026-02-10", amount: -10_000, account: "card", category: "food" },
    ],
  });
  const model = new BudgetModel(snap, TODAY);
  const plan = planRepairs(model, findIntegrityProblems(model));
  assert.equal(plan.repairs.length, 0, "releasing January alone would leave February short");
  assert.equal(plan.writes.length, 0);
  assert.ok(plan.unresolved.some((u) => u.kind === "card_gap"));
});

test("a month where the card is in credit is not judged", () => {
  const snap = snapshot({
    cells: { "card-pay": { "2026-01-01": { balance: 5_000 }, "2026-02-01": { balance: 5_000 }, "2026-03-01": { balance: 5_000 } } },
    tbb: [100_000, 100_000, 100_000],
    transactions: [{ id: "refund", date: "2026-01-10", amount: 20_000, account: "card", category: "food" }],
  });
  const model = new BudgetModel(snap, TODAY);
  assert.equal(findIntegrityProblems(model).cards[0]!.months.length, 0);
});
