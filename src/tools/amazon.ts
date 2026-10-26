import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../utils/register.js";
import { textResult, errorResult } from "../utils/formatting.js";

/**
 * Amazon order lookups through an amazon-orders service (a separate, self-hosted
 * wrapper around the alexdlaird/amazon-orders scraper; Amazon has no API).
 * Registered only when AMAZON_ORDERS_URL is set. 0 YNAB API calls.
 */
export function registerAmazonTools(server: McpServer) {
  const base = process.env.AMAZON_ORDERS_URL;
  if (!base) return;
  const token = process.env.AMAZON_ORDERS_TOKEN ?? "";

  const get = async (path: string) => {
    const r = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(600_000),
    });
    const body = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(String(body.error ?? `amazon-orders answered ${r.status}`));
    return body;
  };

  registerTool(server, "amazon_order", {
    title: "Amazon Order",
    description:
      "[0 YNAB API calls; scrapes Amazon, slow] One Amazon order: its items with prices and every card charge " +
      "made for it (split shipments are charged separately). Use to explain or split an Amazon transaction.",
    inputSchema: z.object({ order_number: z.string().describe("e.g. 114-6913688-6053844") }),
    annotations: { readOnlyHint: true },
  }, async ({ order_number }) => {
    try {
      const data = await get(`/orders/${encodeURIComponent(order_number)}`);
      return textResult(JSON.stringify(data, null, 1), data);
    } catch (e) {
      return errorResult(e);
    }
  });

  registerTool(server, "amazon_receipts", {
    title: "Amazon Charges",
    description:
      "[0 YNAB API calls; scrapes Amazon, slow] Every Amazon card charge in the last `days` days with the items of " +
      "the order it paid for, in the receipt shape enrich_transactions takes.",
    inputSchema: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    annotations: { readOnlyHint: true },
  }, async ({ days }) => {
    try {
      const data = await get(`/receipts?days=${days}`);
      return textResult(JSON.stringify(data, null, 1), data);
    } catch (e) {
      return errorResult(e);
    }
  });
}
