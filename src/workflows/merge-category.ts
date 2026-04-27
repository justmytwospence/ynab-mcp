import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, errorResult } from "../utils/formatting.js";
import { performCategoryMerge } from "./lib/category-merge.js";

export function registerWorkflowTools(server: McpServer) {
  server.registerTool("merge_category", {
    title: "Merge Category",
    description:
      "[Variable API calls] [Workflow] Merges a source category into a target category: re-categorizes all transactions and moves all historical budgeted amounts. " +
      "Dry run costs 4 + N calls (N = number of budget months — can be 50+ for older budgets, easily eating most of the 200/hour quota). " +
      "Execution costs additional 1 + 2*M calls (M = months with non-zero budgets). " +
      "Check get_api_usage before invoking on long-lived budgets. Defaults to dry_run=true to preview changes before executing. " +
      "After merging, the source category will have zero transactions and zero budgeted amounts across all months - you can then manually hide/delete it in the YNAB app.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      source_category_id: z.string().describe("Category ID to merge FROM (will be emptied)"),
      target_category_id: z.string().describe("Category ID to merge INTO (will receive transactions and budgeted amounts)"),
      dry_run: z.boolean().default(true).describe("Preview changes without executing (default: true)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, source_category_id, target_category_id, dry_run }) => {
    try {
      const result = await performCategoryMerge(
        budget_id, source_category_id, target_category_id, dry_run
      );

      const trailer = dry_run
        ? `\n\nSet dry_run=false to execute.`
        : `\n\n"${result.sourceName}" now has zero transactions and zero budgeted amounts.\nYou can hide or delete it manually in the YNAB app.`;

      return textResult(result.output + trailer);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
