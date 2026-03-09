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

const server = new McpServer({
  name: "ynab-mcp",
  version: "1.0.0",
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YNAB MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
