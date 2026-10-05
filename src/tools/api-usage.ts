import { McpServer } from "@modelcontextprotocol/server";
import { apiUsageTracker } from "../utils/api-usage.js";
import { textResult } from "../utils/formatting.js";
import { z } from "zod";

export function registerApiUsageTools(server: McpServer) {
  server.registerTool("get_api_usage", {
    title: "Get API Usage",
    description:
      "[0 API calls] Check current YNAB API usage against the 200 calls/hour rate limit. " +
      "Use this before batch operations to ensure you have enough budget. " +
      "This counts only requests made by this process: the limit is per access token, so the user's own YNAB " +
      "web and mobile sessions consume the same quota invisibly. Treat the count as a lower bound.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const usage = apiUsageTracker.getUsage();
    const lines = [
      `YNAB API Usage:`,
      `  Calls used (last hour): ${usage.used}`,
      `  Calls remaining: ${usage.remaining}`,
      `  Rate limit: ${usage.limit}/hour`,
    ];
    if (usage.windowResetsAt) {
      lines.push(`  Next call expires at: ${usage.windowResetsAt}`);
    }
    lines.push(
      `  Counts this process only; the limit is per access token and is shared with the YNAB app.`
    );
    if (usage.lastRateLimitAt) {
      lines.push(`  Rate limited (429) at ${usage.lastRateLimitAt} - the real usage is higher than the count above.`);
    }
    if (usage.lastDataLimitAt) {
      lines.push(
        `  Data limit reached (403) at ${usage.lastDataLimitAt} - this is an abuse-prevention data limit,`,
        `  not the rate limit. Retrying will not clear it.`
      );
    }
    return textResult(lines.join("\n"));
  });
}
