import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
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
import { registerDeleteCategoryTool } from "./workflows/delete-category.js";
import { registerCreditCardAuditTools } from "./workflows/audit-credit-card-payments.js";
import { registerAccountReconciliationAuditTool } from "./workflows/audit-account-reconciliation.js";
import { registerApiUsageTools } from "./tools/api-usage.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "ynab-mcp";
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/**
 * Builds a fully registered server. The HTTP transport calls this once per request,
 * stdio once per process, so keep it free of side effects and I/O. Shared state (the
 * API client, rate-limit accounting, the budget snapshot cache) lives at module scope.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions:
        "YNAB API rate limit: 200 requests/hour (sliding window) shared across all tools. " +
        "Each tool description shows its API call cost in brackets (e.g., [1 API call]). " +
        "Use get_api_usage to check remaining quota before batch operations. " +
        "Prefer bulk tools (create_transactions, update_transactions) over repeated single-call tools. " +
        "The transaction list endpoints return only the last twelve months when since_date is omitted, with no " +
        "indication that history was truncated. For any analysis spanning more than a year, use get_budget: its " +
        "full export has no date window and is cached.",
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
  registerDeleteCategoryTool(server);
  registerCreditCardAuditTools(server);
  registerAccountReconciliationAuditTool(server);
  registerApiUsageTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
