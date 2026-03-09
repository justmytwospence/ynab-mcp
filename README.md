# ynab-mcp

An MCP (Model Context Protocol) server that exposes the full [YNAB](https://www.ynab.com/) API, allowing LLMs to read and manage your budget through natural language.

## Requirements

- Node.js 20+
- A [YNAB Personal Access Token](https://app.ynab.com/settings/developer)

## Installation

```sh
npm install -g ynab-mcp
```

Or install from source:

```sh
git clone https://github.com/justmytwospence/ynab-mcp.git
cd ynab-mcp
npm install
npm run build
npm install -g .
```

## Configuration

Set your YNAB API token as an environment variable:

```sh
export YNAB_API_TOKEN="your-token-here"
```

Generate a token at **YNAB > Account Settings > Developer Settings**.

### Claude Code

```sh
claude mcp add ynab-mcp ynab-mcp -e YNAB_API_TOKEN=your-token-here
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ynab-mcp": {
      "command": "ynab-mcp",
      "env": {
        "YNAB_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Tools

49 tools covering the full YNAB API. All monetary amounts use YNAB's milliunits format (e.g., `$12.34` = `12340`).

### User

| Tool | Description |
|------|-------------|
| `get_user` | Get authenticated user info |

### Budgets

| Tool | Description |
|------|-------------|
| `list_budgets` | List all budgets with optional account info |
| `get_budget` | Get a budget's full detail including all entities |
| `get_budget_settings` | Get date and currency format settings |

### Accounts

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with balances and types |
| `get_account` | Get details for a single account |
| `create_account` | Create a new account |

### Categories

| Tool | Description |
|------|-------------|
| `list_categories` | List all categories grouped by category group |
| `get_category` | Get details for a single category |
| `create_category` | Create a new category |
| `update_category` | Update a category's name, note, or goal |
| `get_month_category` | Get a category's budget for a specific month |
| `update_month_category` | Update budgeted amount for a category in a month |
| `create_category_group` | Create a new category group |
| `update_category_group` | Update a category group's name |

### Transactions

| Tool | Description |
|------|-------------|
| `list_transactions` | List transactions with optional filters |
| `get_transaction` | Get details for a single transaction |
| `create_transaction` | Create a new transaction |
| `create_transactions` | Batch create multiple transactions |
| `update_transaction` | Update an existing transaction |
| `update_transactions` | Bulk update multiple transactions |
| `delete_transaction` | Delete a transaction |
| `import_transactions` | Import from linked financial institutions |
| `list_account_transactions` | List transactions for a specific account |
| `list_category_transactions` | List transactions for a specific category |
| `list_payee_transactions` | List transactions for a specific payee |
| `list_month_transactions` | List transactions for a specific month |

### Scheduled Transactions

| Tool | Description |
|------|-------------|
| `list_scheduled_transactions` | List all scheduled/recurring transactions |
| `get_scheduled_transaction` | Get details for a scheduled transaction |
| `create_scheduled_transaction` | Create a new scheduled transaction |
| `update_scheduled_transaction` | Update a scheduled transaction |
| `delete_scheduled_transaction` | Delete a scheduled transaction |

### Payees

| Tool | Description |
|------|-------------|
| `list_payees` | List all payees |
| `get_payee` | Get details for a single payee |
| `update_payee` | Update a payee's name |

### Payee Locations

| Tool | Description |
|------|-------------|
| `list_payee_locations` | List all payee GPS locations |
| `get_payee_location` | Get a single payee location |
| `get_payee_locations_for_payee` | Get all locations for a specific payee |

### Months

| Tool | Description |
|------|-------------|
| `list_months` | List all budget months with summaries |
| `get_month` | Get detailed month info with category balances |

### Money Movements

| Tool | Description |
|------|-------------|
| `list_money_movements` | List all money movements |
| `get_month_money_movements` | Get money movements for a specific month |
| `list_money_movement_groups` | List all money movement groups |
| `get_month_money_movement_groups` | Get money movement groups for a specific month |

### Workflows

| Tool | Description |
|------|-------------|
| `merge_category` | Merge a source category into a target, moving all transactions and budgeted amounts |

## Development

```sh
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

## License

MIT
