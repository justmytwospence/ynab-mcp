import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMoneyMovementsClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency } from "../utils/formatting.js";

export function registerMoneyMovementTools(server: McpServer) {
  server.registerTool("list_money_movements", {
    title: "List Money Movements",
    description: "[1 API call] List all money movements for a budget (funds moved between categories)",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      const response = await getMoneyMovementsClient().getMoneyMovements(budget_id);
      const movements = response.data.money_movements;
      if (!movements || movements.length === 0) return textResult("No money movements found.");
      const lines = movements.map((m) => {
        const from = m.from_category_id ?? "Ready to Assign";
        const to = m.to_category_id ?? "Ready to Assign";
        return `- ${formatCurrency(m.amount)}: ${from} -> ${to} [${m.moved_at ?? m.month}] ${m.note ? `(${m.note})` : ""}`;
      });
      return textResult(`Money Movements (${movements.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_month_money_movements", {
    title: "Get Month Money Movements",
    description: "[1 API call] Get money movements for a specific month",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month) or 'current'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, month }) => {
    try {
      const response = await getMoneyMovementsClient().getMoneyMovementsByMonth(budget_id, month);
      const movements = response.data.money_movements;
      if (!movements || movements.length === 0) return textResult(`No money movements found for ${month}.`);
      const lines = movements.map((m) => {
        const from = m.from_category_id ?? "Ready to Assign";
        const to = m.to_category_id ?? "Ready to Assign";
        return `- ${formatCurrency(m.amount)}: ${from} -> ${to} ${m.note ? `(${m.note})` : ""}`;
      });
      return textResult(`Money Movements for ${month} (${movements.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("list_money_movement_groups", {
    title: "List Money Movement Groups",
    description: "[1 API call] List all money movement groups for a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      const response = await getMoneyMovementsClient().getMoneyMovementGroups(budget_id);
      const groups = response.data.money_movement_groups;
      if (!groups || groups.length === 0) return textResult("No money movement groups found.");
      const lines = groups.map((g) =>
        `- ${g.month}: ${g.note ?? "No note"} (Created: ${g.group_created_at}) [ID: ${g.id}]`
      );
      return textResult(`Money Movement Groups (${groups.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_month_money_movement_groups", {
    title: "Get Month Money Movement Groups",
    description: "[1 API call] Get money movement groups for a specific month",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month) or 'current'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, month }) => {
    try {
      const response = await getMoneyMovementsClient().getMoneyMovementGroupsByMonth(budget_id, month);
      const groups = response.data.money_movement_groups;
      if (!groups || groups.length === 0) return textResult(`No money movement groups found for ${month}.`);
      const lines = groups.map((g) =>
        `- ${g.note ?? "No note"} (Created: ${g.group_created_at}) [ID: ${g.id}]`
      );
      return textResult(`Money Movement Groups for ${month} (${groups.length}):\n${lines.join("\n")}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
