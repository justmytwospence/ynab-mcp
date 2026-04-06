import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult } from "../utils/formatting.js";

export function registerUserTools(server: McpServer) {
  server.registerTool("get_user", {
    title: "Get User",
    description: "[1 API call] Get the authenticated user's information including user ID",
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const response = await getClient().user.getUser();
      const user = response.data.user;
      return textResult(`User ID: ${user.id}`);
    } catch (e: any) {
      return errorResult(e);
    }
  });
}
