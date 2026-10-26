import { McpServer, type CallToolResult, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, resultSchema } from "./formatting.js";
import { mutationAttempted, runOperation } from "./operation.js";
import { invalidateBudgetSnapshot } from "../budget-snapshot.js";
import { apiUsageTracker } from "./api-usage.js";

const LOCAL_READS = new Set(["get_api_usage", "list_item_categories"]);
const OVERWRITES = new Set([
  "update_category", "update_month_category", "update_category_group", "update_payee",
  "update_transaction", "update_transactions", "update_scheduled_transaction",
  "delete_transaction", "delete_scheduled_transaction", "merge_category", "delete_category",
  "audit_credit_card_payments", "audit_account_reconciliation", "audit_budget_integrity",
  "plan_month", "suggest_categories", "enrich_transactions",
]);
// Conservative for workflows and transactions: split conversion and alias/import-id
// matching can change the target on a later invocation. Never inferred from a verb.
const SNAPSHOT_WORKFLOWS = new Set(["merge_category", "delete_category", "audit_credit_card_payments", "audit_budget_integrity", "plan_month", "suggest_categories", "enrich_transactions"]);
const IDEMPOTENT_WRITES = new Set([
  "update_category", "update_month_category", "update_category_group", "update_payee",
  "update_scheduled_transaction", "delete_transaction", "delete_scheduled_transaction",
]);

export function toolAnnotations(name: string, readOnly: boolean): Required<Pick<ToolAnnotations,
  "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">> {
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && OVERWRITES.has(name),
    idempotentHint: readOnly || IDEMPOTENT_WRITES.has(name),
    openWorldHint: !LOCAL_READS.has(name),
  };
}

/** SDK validation plus shared result schema and explicit audited hints for every tool. */
export function registerTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema?: S; annotations: ToolAnnotations },
  handler: (args: z.infer<S>) => Promise<CallToolResult>,
) {
  const readOnly = config.annotations.readOnlyHint === true;
  return server.registerTool(name, {
    ...config,
    inputSchema: config.inputSchema ?? z.object({}),
    outputSchema: resultSchema,
    annotations: toolAnnotations(name, readOnly),
    description: config.description + (LOCAL_READS.has(name) ? " Local-only read: zero HTTP requests." : "") + (SNAPSHOT_WORKFLOWS.has(name)
      ? " Snapshot costs are normally 1 delta/full read, +1 for an unusable delta, or 5 + M month + Y yearly transaction calls after a 503 (plus failed attempts/retries). Fallback omits schedules and payee locations and preflights each phase."
      : "") + (readOnly
      ? (LOCAL_READS.has(name) || name.startsWith("amazon_") ? "" : " Costs are baseline HTTP attempts; bounded read retries may add calls. Check get_api_usage before expensive reads.")
      : " Check get_api_usage and preview workflows before apply; do not apply from truncated/partial previews. Writes are never automatically replayed; after an ambiguous failure, inspect current state before retrying. Transaction flag follow-ups may add one call per update."),
  }, async (args) => runOperation(async () => {
    try {
      // Explicitly parse here too: direct registration harnesses must not bypass validation.
      const parsed = config.inputSchema?.parse(args) ?? {};
      validateInput(parsed);
      if ((parsed as Record<string, unknown>).month === "next" && name !== "plan_month") throw new Error("'next' is only supported by plan_month");
      const invoke = () => handler(parsed as z.infer<S>);
      if (name === "get_account" && (parsed as Record<string, unknown>).include_reconciliation) {
        return await apiUsageTracker.withBudget(2, invoke);
      }
      return await invoke();
    } catch (e) {
      return errorResult(e);
    } finally {
      // A write can have succeeded even when its response was lost.
      if (!readOnly && mutationAttempted()) invalidateBudgetSnapshot();
    }
  }));
}

/** Additional semantic checks shared by tools and prompt/resource arguments. */
export function validateInput(value: unknown, key = ""): void {
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error(`${key}: at most 1000 items per invocation`);
    for (const item of value) validateInput(item, key);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.since_date && record.until_date && String(record.since_date) > String(record.until_date)) {
      throw new Error("since_date must not be after until_date");
    }
    if (Array.isArray(record.subtransactions) && typeof record.amount === "number") {
      const sum = record.subtransactions.reduce((total, leg) => total + Math.round(Number(leg.amount) * 1000), 0);
      if (sum !== Math.round(record.amount * 1000)) throw new Error("Split amounts must sum to the transaction amount");
    }
    for (const [k, v] of Object.entries(record)) validateInput(v, k);
  } else if (typeof value === "string") {
    if (value.length > 10000) throw new Error(`${key}: string too long`);
    if (key.endsWith("_id") && key !== "import_id") {
      if (!/^[\w-]{1,128}$/.test(value)) throw new Error(`${key}: invalid identifier`);
    }
    if (["date", "since_date", "until_date", "goal_target_date", "today", "since_month", "month"].includes(key)) {
      if (key === "month" && ["current", "next"].includes(value)) return;
      dateSchema.parse(value);
      if (key.includes("month") && !value.endsWith("-01")) throw new Error(`${key}: use the first of the month`);
    }
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${key}: must be finite`);
    if (["limit", "days", "max_writes", "history_months", "min_count", "date_slack_days", "last_knowledge_of_server"].includes(key)) {
      if (!Number.isInteger(value) || value < 0 || value > 1000000000) throw new Error(`${key}: invalid nonnegative integer`);
    }
    if (key === "min_share" && (value < 0 || value > 1)) throw new Error("min_share must be between 0 and 1");
  }
}

export const idSchema = z.string().regex(/^[\w-]{1,128}$/, "Invalid identifier");
export const dateSchema = z.iso.date();
export const monthSchema = dateSchema.refine((date) => date.endsWith("-01"), "Use the first of the month");
