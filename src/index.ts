#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerUserTools } from "./tools/user.js";
import { registerBudgetTools } from "./tools/budgets.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerPayeeTools } from "./tools/payees.js";
import { registerPayeeLocationTools } from "./tools/payee-locations.js";
import { registerMonthTools } from "./tools/months.js";
import { registerMoneyMovementTools } from "./tools/money-movements.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerScheduledTransactionTools } from "./tools/scheduled-transactions.js";
import { registerWorkflowTools } from "./workflows/merge-category.js";
import { registerCreditCardAuditTools } from "./workflows/audit-credit-card-payments.js";
import { registerApiUsageTools } from "./tools/api-usage.js";

const server = new McpServer(
  { name: "ynab-mcp", version: "1.0.0" },
  {
    instructions:
      "YNAB API rate limit: 200 requests/hour (sliding window) shared across all tools. " +
      "Each tool description shows its API call cost in brackets (e.g., [1 API call]). " +
      "Use get_api_usage to check remaining quota before batch operations. " +
      "Prefer bulk tools (create_transactions, update_transactions) over repeated single-call tools.",
  }
);

registerUserTools(server);
registerBudgetTools(server);
registerAccountTools(server);
registerCategoryTools(server);
registerPayeeTools(server);
registerPayeeLocationTools(server);
registerMonthTools(server);
registerMoneyMovementTools(server);
registerTransactionTools(server);
registerScheduledTransactionTools(server);
registerWorkflowTools(server);
registerCreditCardAuditTools(server);
registerApiUsageTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YNAB MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
