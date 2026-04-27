import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, errorResult } from "../utils/formatting.js";
import { performCategoryMerge } from "./lib/category-merge.js";

export function registerDeleteCategoryTool(server: McpServer) {
  server.registerTool("delete_category", {
    title: "Delete Category (with cleanup)",
    description:
      "[Variable API calls] [Workflow] Prepares a category for deletion by cleaning up its history: " +
      "re-categorizes every historical transaction to a replacement category and zeros out all historical budgeted amounts. " +
      "The YNAB API does not expose category deletion, so the final delete must be performed in the YNAB app " +
      "(Manage Categories -> trash icon). After this workflow runs, the source category is safe to delete with no data loss. " +
      "Dry run costs 4 + N calls (N = number of budget months — can be 50+ for older budgets, easily eating most of the 200/hour quota). " +
      "Execution costs additional 1 + 2*M calls (M = months with non-zero budgets). " +
      "Check get_api_usage before invoking on long-lived budgets. Defaults to dry_run=true.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      category_id: z.string().describe("Category ID to delete"),
      replacement_category_id: z.string().describe(
        "Category ID that will absorb historical transactions and budgeted amounts. " +
        "Required even if the source has no transactions, to keep behavior predictable."
      ),
      dry_run: z.boolean().default(true).describe("Preview changes without executing (default: true)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ budget_id, category_id, replacement_category_id, dry_run }) => {
    try {
      if (category_id === replacement_category_id) {
        return errorResult("category_id and replacement_category_id must be different.");
      }

      const result = await performCategoryMerge(
        budget_id, category_id, replacement_category_id, dry_run
      );

      let trailer: string;
      if (dry_run) {
        trailer =
          `\n\n[DRY RUN] No changes applied. Set dry_run=false to clean up "${result.sourceName}" for deletion.`;
      } else {
        const hasSkipped = result.skippedTransactions > 0 || result.uninspectedOldMonths > 0;
        const lines = [``];

        if (hasSkipped) {
          lines.push(
            `Cleanup partially complete. "${result.sourceName}" still has ${result.skippedTransactions} transaction(s) older than 5 years, and ${result.uninspectedOldMonths} pre-cutoff month(s) were not inspected for stale budget allocations.`,
            `YNAB does not allow API writes to dates that old, so the source category cannot be deleted in the app until those entries age out.`,
          );
        } else {
          lines.push(
            `Cleanup complete. "${result.sourceName}" has zero transactions and zero historical budget.`,
            `The YNAB API does not expose category deletion, so the final delete must be performed in the YNAB app: Manage Categories -> trash icon.`,
          );
        }

        trailer = lines.join("\n");
      }

      return textResult(result.output + trailer);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
