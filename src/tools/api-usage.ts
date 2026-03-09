import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiUsageTracker } from "../utils/api-usage.js";
import { textResult } from "../utils/formatting.js";

export function registerApiUsageTools(server: McpServer) {
  server.registerTool("get_api_usage", {
    title: "Get API Usage",
    description:
      "[0 API calls] Check current YNAB API usage against the 200 calls/hour rate limit. " +
      "Use this before batch operations to ensure you have enough budget.",
    inputSchema: {},
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
    return textResult(lines.join("\n"));
  });
}
