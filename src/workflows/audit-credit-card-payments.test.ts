import { test } from "node:test";
import assert from "node:assert/strict";
import { screenAffordability } from "./audit-credit-card-payments.js";

const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01"];

function correction(month: string, delta: number, cardName = "Amex") {
  return { month, categoryId: "cat", budgeted: 100_000 + delta, previousBudgeted: 100_000, cardName };
}

function readyToAssign(...amounts: number[]) {
  return new Map(MONTHS.map((m, i) => [m, amounts[i] ?? amounts[amounts.length - 1]!]));
}

test("a correction the month can fund is affordable", () => {
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", 100_000)],
    MONTHS,
    readyToAssign(500_000)
  );
  assert.equal(affordable.length, 1);
  assert.equal(blocked.length, 0);
});

test("a correction larger than Ready to Assign is blocked", () => {
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", 100_000)],
    MONTHS,
    readyToAssign(50_000)
  );
  assert.equal(affordable.length, 0);
  assert.equal(blocked[0]?.worstReadyToAssign, -50_000);
});

test("a correction that sinks a later month is blocked", () => {
  // January can fund it, but the assignment carries forward and March cannot.
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", 100_000)],
    MONTHS,
    readyToAssign(500_000, 400_000, 60_000)
  );
  assert.equal(affordable.length, 0);
  assert.equal(blocked[0]?.worstMonth, "2026-03-01");
});

test("two corrections that only overdraw together block the later one", () => {
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", 100_000, "Amex"), correction("2026-02-01", 100_000, "Visa")],
    MONTHS,
    readyToAssign(120_000)
  );
  assert.deepEqual(affordable.map((c) => c.cardName), ["Amex"]);
  assert.deepEqual(blocked.map((b) => b.correction.cardName), ["Visa"]);
});

test("a correction that frees money is never blocked", () => {
  // Even in an already-negative month: handing money back cannot make it worse.
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", -50_000)],
    MONTHS,
    readyToAssign(-200_000)
  );
  assert.equal(affordable.length, 1);
  assert.equal(blocked.length, 0);
});

test("an already-negative month refuses further assignment", () => {
  const { affordable, blocked } = screenAffordability(
    [correction("2026-01-01", 10)],
    MONTHS,
    readyToAssign(-1)
  );
  assert.equal(affordable.length, 0);
  assert.equal(blocked.length, 1);
});

test("an earlier negative month does not block a later correction", () => {
  const { affordable, blocked } = screenAffordability(
    [correction("2026-02-01", 100_000)],
    MONTHS,
    readyToAssign(-900_000, 500_000, 500_000)
  );
  assert.equal(affordable.length, 1);
  assert.equal(blocked.length, 0);
});
