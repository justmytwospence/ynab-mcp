import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetryOn500 } from "./budget-snapshot.js";

const err = (id: string) => ({ error: { id, name: "x", detail: "x" } });

test("a 500 is retried and the later success returned", async () => {
  let calls = 0;
  let failed = 0;
  const result = await withRetryOn500(
    async () => {
      calls += 1;
      if (calls < 3) throw err("500");
      return "ok";
    },
    () => (failed += 1),
    3,
    0
  );
  assert.equal(result, "ok");
  assert.equal(failed, 2);
});

test("other errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetryOn500(async () => {
      calls += 1;
      throw err("503");
    }, () => {}, 3, 0)
  );
  assert.equal(calls, 1);
});

test("a persistent 500 gives up after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    withRetryOn500(async () => {
      calls += 1;
      throw err("500");
    }, () => {}, 3, 0)
  );
  assert.equal(calls, 3);
});
