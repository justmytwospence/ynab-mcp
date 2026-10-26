import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResult, resultSchema, textResult } from "./formatting.js";
import { operationWarning, recordAttempt, runOperation } from "./operation.js";

test("text and JSON envelopes preserve compatibility, actual retry/follow-up cost, and warnings", async () => {
  await runOperation(async () => {
    recordAttempt(); recordAttempt();
    operationWarning("Primary write succeeded; follow-up failed. Inspect flags, do not replay.");
    const text = textResult("API calls used: 1", { count: 1, apiCalls: 1, api_calls: 1 });
    assert.match(text.content[0]!.text, /API calls used: 2/);
    assert.match(text.content[0]!.text, /follow-up failed/);
    assert.equal(text.structuredContent.request_cost.attempts, 2);
    assert.equal((text.structuredContent.data as Record<string, unknown>).apiCalls, 2);
    assert.equal((text.structuredContent.data as Record<string, unknown>).api_calls, 2);
    assert.ok(resultSchema.safeParse(text.structuredContent).success);
    const json = jsonResult({ api_calls: 1, plan: { changes: [] } });
    const body = JSON.parse(json.content[0]!.text);
    assert.equal(body.api_calls, 2);
    assert.equal(body.warnings.length, 1);
    assert.ok(resultSchema.safeParse(json.structuredContent).success);
  });
});

test("large text and domain payloads have explicit bounded partial-result semantics; JSON text stays valid", () => {
  const huge = "é".repeat(300000);
  const text = textResult(huge, { data: huge });
  assert.ok(Buffer.byteLength(text.content[0]!.text) <= 131072);
  assert.equal(text.structuredContent.data, null);
  assert.match(text.content[0]!.text, /TRUNCATED/);
  assert.match(text.structuredContent.request_cost.warnings.join(" "), /omitted.*256 KiB/);
  const json = jsonResult({ findings: huge, api_calls: 0 });
  const body = JSON.parse(json.content[0]!.text);
  assert.equal(body.result_omitted, true);
  assert.ok(body.warnings.length);
  assert.ok(Buffer.byteLength(json.content[0]!.text) <= 131072);
  assert.ok(resultSchema.safeParse(json.structuredContent).success);
});
