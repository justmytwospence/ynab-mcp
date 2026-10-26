import { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../utils/register.js";
import { apiUsageTracker } from "../utils/api-usage.js";
import { textResult } from "../utils/formatting.js";
import { z } from "zod";
import { BUDGET_GUIDANCE } from "../utils/guidance.js";

export function registerApiUsageTools(server: McpServer) {
  registerTool(server, "get_api_usage", {
    title: "Get API Usage",
    description:
      "[0 API calls] Cached local rolling-hour estimate against 200 requests/token/hour, not authoritative remaining quota. " +
      "Check nextAvailableSlotAt and cooldown before expensive reads or apply. Counts HTTP retries and flag follow-ups; " +
      "other clients using this access token are invisible, not necessarily YNAB's own web/mobile sessions. No remaining-quota headers are assumed.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const usage = apiUsageTracker.getUsage();
    const lines = [
      `YNAB API Usage:`,
      `  Calls used (last hour): ${usage.used}`,
      `  Estimated remaining: ${usage.remaining} (${usage.available} unreserved)`,
      `  Next available slot (estimate): ${usage.nextAvailableSlotAt ?? "unknown"}`,
      `  Cooldown: ${usage.cooldownUntil ?? "none"} (${usage.cooldownSource ?? "none"})`,
      `  Rate limit: ${usage.limit}/hour`,
    ];
    if (usage.windowResetsAt) {
      lines.push(`  Next call expires at: ${usage.windowResetsAt}`);
    }
    lines.push(
      `  Counts this process only; other clients using the same access token share the allowance. YNAB's own app sessions are not assumed to use this token.`
    );
    if (usage.lastRateLimitAt) {
      lines.push(`  Rate limited (429) at ${usage.lastRateLimitAt} - the real usage is higher than the count above.`);
    }
    if (usage.lastDataLimitAt) {
      lines.push(
        `  Data limit reached (403.4) at ${usage.lastDataLimitAt} - this is an unquantified data limit,`,
        `  not the rate limit. Retrying will not clear it.`
      );
    }
    lines.push("", BUDGET_GUIDANCE, "Read ynab://guide for URI template examples and workflow prompt names/costs.");
    return textResult(lines.join("\n"), usage);
  });
}
