import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult } from "../utils/formatting.js";

export function registerPayeeTools(server: McpServer) {
  server.registerTool("list_payees", {
    title: "List Payees",
    description: "[1 API call] List all payees for a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().payees.getPayees(budget_id, last_knowledge_of_server);
      const payees = response.data.payees;
      const lines = payees.map((p) => {
        const transfer = p.transfer_account_id ? ` (Transfer: ${p.transfer_account_id})` : "";
        return `- ${p.name}${transfer} [ID: ${p.id}]`;
      });
      return textResult(
        `Payees (${payees.length}):\n${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`
      );
    } catch (e: any) {
      return errorResult(e);
    }
  });

  server.registerTool("get_payee", {
    title: "Get Payee",
    description: "[1 API call] Get details for a single payee",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
    },
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
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      payee_id: z.string().describe("The payee ID"),
      name: z.string().max(500).describe("New payee name (max 500 characters)"),
    },
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
