import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult } from "../utils/formatting.js";

export function registerPayeeTools(server: McpServer) {
  server.registerTool("list_payees", {
    title: "List Payees",
    description:
      "[1 API call] List payees for a budget. Budgets often have 1000+ payees; " +
      "use `name_filter` (case-insensitive substring) to avoid loading the full list. " +
      "Use `limit` to cap result size when listing without a filter.",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      name_filter: z.string().optional().describe(
        "Case-insensitive substring filter on payee name. Highly recommended when looking up a known payee."
      ),
      limit: z.number().int().positive().optional().describe(
        "Maximum number of payees to return (after filtering). Useful when you just want the top matches."
      ),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, name_filter, limit, last_knowledge_of_server }) => {
    try {
      const response = await getClient().payees.getPayees(budget_id, last_knowledge_of_server);
      const all = response.data.payees;
      let filtered = all;
      if (name_filter) {
        const needle = name_filter.toLowerCase();
        filtered = all.filter((p) => p.name.toLowerCase().includes(needle));
      }
      const totalMatched = filtered.length;
      const truncated = limit !== undefined && filtered.length > limit;
      if (truncated) filtered = filtered.slice(0, limit);

      const lines = filtered.map((p) => {
        const transfer = p.transfer_account_id ? ` (Transfer: ${p.transfer_account_id})` : "";
        return `- ${p.name}${transfer} [ID: ${p.id}]`;
      });

      const header = name_filter
        ? `Payees matching "${name_filter}" (${totalMatched} of ${all.length} total)`
        : `Payees (${all.length})`;
      const truncNote = truncated ? `\n(showing first ${limit}; pass a more specific name_filter or higher limit to see more)` : "";

      return textResult(
        `${header}:${truncNote}\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("get_payee", {
    title: "Get Payee",
    description: "[1 API call] Get details for a single payee",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, payee_id }) => {
    try {
      const response = await getClient().payees.getPayeeById(budget_id, payee_id);
      const p = response.data.payee;
      const lines = [
        `Name: ${p.name}`,
        `Transfer Account: ${p.transfer_account_id ?? "None"}`,
        `ID: ${p.id}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("update_payee", {
    title: "Update Payee",
    description: "[1 API call] Update a payee's name",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
      name: z.string().max(500).describe("New payee name (max 500 characters)"),
    }),
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, payee_id, name }) => {
    try {
      const response = await getClient().payees.updatePayee(budget_id, payee_id, {
        payee: { name },
      });
      const p = response.data.payee;
      return textResult(`Updated payee "${p.name}"\nID: ${p.id}`);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
