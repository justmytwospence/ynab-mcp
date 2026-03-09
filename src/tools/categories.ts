import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";

export function registerCategoryTools(server: McpServer) {
  server.registerTool("list_categories", {
    title: "List Categories",
    description: "List all categories grouped by category group for a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      last_knowledge_of_server: z.number().optional().describe("Delta request token"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, last_knowledge_of_server }) => {
    try {
      const response = await getClient().categories.getCategories(budget_id, last_knowledge_of_server);
      const groups = response.data.category_groups;
      const lines: string[] = [];
      for (const group of groups) {
        lines.push(`\n## ${group.name} (ID: ${group.id})`);
        if (group.categories) {
          for (const cat of group.categories) {
            if (cat.hidden) continue;
            const budgeted = formatCurrency(cat.budgeted);
            const activity = formatCurrency(cat.activity);
            const balance = formatCurrency(cat.balance);
            lines.push(`  - ${cat.name}: Budgeted ${budgeted} | Activity ${activity} | Balance ${balance} [ID: ${cat.id}]`);
          }
        }
      }
      return textResult(`Categories:${lines.join("\n")}\n\nServer Knowledge: ${response.data.server_knowledge}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_category", {
    title: "Get Category",
    description: "Get details for a single category",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      category_id: z.string().describe("The category ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, category_id }) => {
    try {
      const response = await getClient().categories.getCategoryById(budget_id, category_id);
      const c = response.data.category;
      const lines = [
        `Name: ${c.name}`,
        `Category Group: ${c.category_group_name}`,
        `Budgeted: ${formatCurrency(c.budgeted)}`,
        `Activity: ${formatCurrency(c.activity)}`,
        `Balance: ${formatCurrency(c.balance)}`,
        `Goal Type: ${c.goal_type ?? "None"}`,
        `Goal Target: ${c.goal_target != null ? formatCurrency(c.goal_target) : "None"}`,
        `Goal Target Month: ${c.goal_target_month ?? "None"}`,
        `Note: ${c.note ?? "None"}`,
        `Hidden: ${c.hidden}`,
        `ID: ${c.id}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("create_category", {
    title: "Create Category",
    description: "Create a new category in a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      name: z.string().describe("Category name"),
      category_group_id: z.string().describe("ID of the category group to add this category to"),
      note: z.string().optional().describe("Category note"),
      goal_target: z.number().optional().describe("Goal target amount in dollars"),
      goal_target_date: z.string().optional().describe("Goal target date (YYYY-MM-DD)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, name, category_group_id, note, goal_target, goal_target_date }) => {
    try {
      const response = await getClient().categories.createCategory(budget_id, {
        category: {
          name,
          category_group_id,
          note,
          goal_target: goal_target != null ? dollarsToMilliunits(goal_target) : undefined,
          goal_target_date,
        },
      });
      const c = response.data.category;
      return textResult(`Created category "${c.name}"\nID: ${c.id}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_category", {
    title: "Update Category",
    description: "Update an existing category's name, note, or goal",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      category_id: z.string().describe("The category ID to update"),
      name: z.string().optional().describe("New category name"),
      note: z.string().optional().describe("New category note"),
      goal_target: z.number().optional().describe("New goal target in dollars"),
      goal_target_date: z.string().optional().describe("New goal target date (YYYY-MM-DD)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, category_id, name, note, goal_target, goal_target_date }) => {
    try {
      const response = await getClient().categories.updateCategory(budget_id, category_id, {
        category: {
          name,
          note,
          goal_target: goal_target != null ? dollarsToMilliunits(goal_target) : undefined,
          goal_target_date,
        },
      });
      const c = response.data.category;
      return textResult(`Updated category "${c.name}"\nID: ${c.id}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("get_month_category", {
    title: "Get Month Category",
    description: "Get a category's budget details for a specific month",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month) or 'current'"),
      category_id: z.string().describe("The category ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ budget_id, month, category_id }) => {
    try {
      const response = await getClient().categories.getMonthCategoryById(budget_id, month, category_id);
      const c = response.data.category;
      const lines = [
        `Category: ${c.name} (${month})`,
        `Budgeted: ${formatCurrency(c.budgeted)}`,
        `Activity: ${formatCurrency(c.activity)}`,
        `Balance: ${formatCurrency(c.balance)}`,
        `Goal Type: ${c.goal_type ?? "None"}`,
        `Goal Target: ${c.goal_target != null ? formatCurrency(c.goal_target) : "None"}`,
      ];
      return textResult(lines.join("\n"));
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_month_category", {
    title: "Update Month Category Budget",
    description: "Update the budgeted/assigned amount for a category in a specific month. This is how you allocate money to categories.",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      month: z.string().describe("Month in YYYY-MM-DD format (first of month) or 'current'"),
      category_id: z.string().describe("The category ID"),
      budgeted: z.number().describe("Amount to budget/assign in dollars (e.g., 500.00)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, month, category_id, budgeted }) => {
    try {
      const response = await getClient().categories.updateMonthCategory(budget_id, month, category_id, {
        category: { budgeted: dollarsToMilliunits(budgeted) },
      });
      const c = response.data.category;
      return textResult(`Updated "${c.name}" for ${month}: Budgeted ${formatCurrency(c.budgeted)}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("create_category_group", {
    title: "Create Category Group",
    description: "Create a new category group in a budget",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      name: z.string().max(50).describe("Category group name (max 50 characters)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, name }) => {
    try {
      const response = await getClient().categories.createCategoryGroup(budget_id, {
        category_group: { name },
      });
      const g = response.data.category_group;
      return textResult(`Created category group "${g.name}"\nID: ${g.id}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });

  server.registerTool("update_category_group", {
    title: "Update Category Group",
    description: "Update a category group's name",
    inputSchema: {
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
      category_group_id: z.string().describe("The category group ID"),
      name: z.string().max(50).describe("New name (max 50 characters)"),
    },
    annotations: { readOnlyHint: false },
  }, async ({ budget_id, category_group_id, name }) => {
    try {
      const response = await getClient().categories.updateCategoryGroup(budget_id, category_group_id, {
        category_group: { name },
      });
      const g = response.data.category_group;
      return textResult(`Updated category group "${g.name}"\nID: ${g.id}`);
    } catch (e: any) {
      return errorResult(e.message);
    }
  });
}
