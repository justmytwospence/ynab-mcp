import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { textResult, errorResult } from "../utils/formatting.js";
import { performCategoryMerge } from "./lib/category-merge.js";

export function registerWorkflowTools(server: McpServer) {
  server.registerTool("merge_category", {
    title: "Merge Category",
    description:
      "[1 API call to preview] [Workflow] Merges a source category into a target category: re-categorizes all " +
      "transactions and moves all historical budgeted amounts. The preview reads the whole budget in a single " +
      "cached request regardless of how many months it spans. Execution costs 1 call for the bulk transaction " +
      "update plus 2 calls per month with a non-zero source budget. " +
      "Defaults to dry_run=true to preview changes before executing. " +
      "Split transaction legs cannot be re-categorized through the API and are reported instead. " +
      "After merging, the source category will have zero transactions and zero budgeted amounts across all months - " +
      "you can then manually hide/delete it in the YNAB app.",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      source_category_id: z.string().describe("Category ID to merge FROM (will be emptied)"),
      target_category_id: z.string().describe("Category ID to merge INTO (will receive transactions and budgeted amounts)"),
      dry_run: z.boolean().default(true).describe("Preview changes without executing (default: true)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, source_category_id, target_category_id, dry_run }) => {
    try {
      const result = await performCategoryMerge(
        budget_id, source_category_id, target_category_id, dry_run
      );

      let trailer: string;
      if (dry_run) {
        trailer = `\n\nSet dry_run=false to execute.`;
      } else if (result.failures.length > 0 || result.splitLegs > 0 ||
                 result.skippedTransactions > 0 || result.uninspectedOldMonths > 0) {
        // The helper has already spelled out exactly what was left behind;
        // claiming the category is empty here would contradict it.
        trailer = ``;
      } else {
        trailer =
          `\n\n"${result.sourceName}" now has zero transactions and zero budgeted amounts.\n` +
          `You can hide or delete it manually in the YNAB app.`;
      }

      return textResult(result.output + trailer);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
