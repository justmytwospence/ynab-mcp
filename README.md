# ynab-mcp

An MCP (Model Context Protocol) server that exposes the full [YNAB](https://www.ynab.com/) API, allowing LLMs to read and manage your budget through natural language. Provides tools for CRUD operations, resources for ambient budget context, and prompts for guided financial workflows.

## Requirements

- Node.js 20+
- A [YNAB Personal Access Token](https://app.ynab.com/settings/developer)

## Run it as a service (Docker)

```sh
cp .env.example .env   # fill in YNAB_API_TOKEN
docker compose up -d
```

The server speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28)
at `http://<host>:8000/mcp` (also at `/`), with a health check at `/health`, and serves both
2026-07-28 and older session-based clients. Point any MCP client at it:

```json
{ "mcpServers": { "ynab": { "type": "http", "url": "http://localhost:8000/mcp" } } }
```

| Variable | Default | Meaning |
|---|---|---|
| `YNAB_API_TOKEN` | (required) | YNAB personal access token |
| `MCP_TRANSPORT` | `stdio` (`http` in the image) | `stdio` or `http` |
| `PORT` | `8000` | HTTP port |
| `AMAZON_ORDERS_URL`, `AMAZON_ORDERS_TOKEN` | (unset) | An amazon-orders service (see the homelab repo); enables `amazon_order` and `amazon_receipts` |
| `RECONCILE_MAP` | (unset) | Where each tracking account's real balance comes from; enables `get_tracking_balances`. See [Tracking balances](#tracking-balances) |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_TOKENS`, `PLAID_ENV` | (unset), `production` | Read-only Plaid access for investment accounts in `RECONCILE_MAP` |
| `YNAB_MCP_AI_FLAG` | (unset: off) | A flag color (`purple`, ...) put on every transaction this server creates or edits; see "AI flag" |
| `YNAB_MCP_STATE_DIR` | `./state` (`/data` in the image) | Where enrich_transactions remembers item categories; mount a volume |
| `MCP_ALLOWED_HOSTS` | (any) | Comma-separated hostnames allowed in the `Host` header (set it behind a reverse proxy) |

Running as a long-lived service also keeps the rate-limit accounting and the `get_budget`
snapshot cache warm across calls. Images: `ghcr.io/justmytwospence/ynab-mcp`, published for
amd64 and arm64 by pushing a `vX.Y.Z` tag.

## Installation (stdio)

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

55 tools, plus 2 optional Amazon tools when configured. Tool amount inputs described in dollars use currency units; raw API/structured financial data uses YNAB milliunits (e.g., `$12.34` = `12340`). Every tool declares all four behavioral hints. Preview/apply workflows remain writes; annotations do not enforce approval or permissions.

Results retain existing text (including `format: "json"` JSON-in-text) and add a validated `structuredContent` envelope: `text`, endpoint/workflow `data`, `api_usage` local estimates, and `request_cost` with actual HTTP attempts and partial-result warnings. Only the stable envelope has an output schema; domain payloads vary by tool. Mutations invalidate cached snapshots even after a lost response. Text is bounded to 128 KiB and domain data to 256 KiB: explicit warnings flag truncation/omission (`data: null`); oversized JSON-in-text remains valid with `result_omitted: true`. Narrow requests rather than applying from partial previews.

### AI flag

Set `YNAB_MCP_AI_FLAG=purple` (any YNAB flag color) and every transaction the server creates
or meaningfully edits gets that flag, so you can see and filter what an AI touched. In YNAB,
name the flag (e.g. "AI") and filter by it; through the server, pass `flag: "ai"` to any
`list_*transactions` tool.

- Marked: creates, and updates to account, date, amount, payee, category, memo or splits,
  from any tool or workflow. Not marked: cleared/approved/reconciled changes, bank imports,
  scheduled transactions.
- A flag you set yourself is never replaced, and a `flag_color` the caller passes wins.
- Marking an update costs one extra API call per write (a follow-up bulk request for the
  transactions that came back unflagged); creates carry the flag in the request.
- A person's choice is not an AI's: pass `human: true` to `create_transaction(s)`,
  `update_transaction(s)` or `enrich_transactions` when the person decided the change
  (named the category, picked one of your options). Nothing is marked, and an AI flag already
  on an edited transaction is cleared (one extra call), since a person has now decided it.
  Their own flag colors are kept.

### Tracking balances

`get_tracking_balances` (read-only) reads the real balance of each tracking account named in
`RECONCILE_MAP` and compares it with YNAB's cleared balance. Book the difference with
`audit_account_reconciliation` (`target_balance`, `apply: true`, `payee_name: "Market return"`),
which reconciles the account the way YNAB's own reconcile does.

```json
[
  {"account": "Roth", "plaid": {"link": "vanguard", "masks": ["1234"]}},
  {"account": "Crypto", "wallets": [
    {"chain": "btc", "address": "zpub..."},
    {"chain": "eth", "address": "0x..."},
    {"chain": "eth", "address": "0x...", "token": {"contract": "0xA0b8...", "decimals": 6, "coingecko": "usd-coin", "symbol": "USDC"}},
    {"chain": "sol", "address": "..."}
  ]}
]
```

**Crypto** uses public data only: BTC addresses, or an xpub/ypub/zpub whose addresses are
derived locally (receive and change, gap limit 20), looked up on mempool.space and
blockstream.info; a public Ethereum RPC; Solana's public RPC; and CoinGecko prices. Nothing here can sign or move funds.

**Investment accounts** use Plaid's free Trial plan, read-only:

- The server can call exactly two Plaid endpoints, `/investments/holdings/get` and
  `/accounts/get` (enforced in `src/sources/plaid.ts` and tested). Plaid has no endpoint that
  trades or withdraws from an investment account.
- Links are made with `node dist/plaid-link.js link` in the container. It asks Plaid for
  `investments` only, then keeps the link only if the institution uses OAuth (Plaid never sees
  your password), the link consents to nothing beyond investments and identity (Fidelity's
  links carry identity; the server never requests it), and `/auth/get` (account and routing
  numbers) is refused. Otherwise it removes the link. `search <name>`
  shows whether an institution links through OAuth before you try.
- `PLAID_TOKENS` is a JSON object of link name to access token. Keep it with the YNAB token;
  errors never include it. Revoke a link at my.plaid.com or at the institution (Fidelity
  Access), or rotate `PLAID_SECRET` in the Plaid dashboard to cut off every link at once.

### Rate limit awareness

The YNAB API allowance is **200 requests/token/rolling hour**. Accounting here is a **local estimate**, not authoritative remaining quota: other clients using the same access token and previous process lifetimes are invisible. YNAB's own web/mobile sessions are not assumed to use this token. Every actual YNAB HTTP attempt counts, including failed transports, retries, and AI/human flag follow-ups.

- `get_api_usage` / `ynab://api-usage`: cached/local status, **zero HTTP**. Includes observation times, reservations, next available slot, last 429/403.4, and cooldown. No remaining/reset headers are invented.
- `windowResetsAt` is the **next observed call expiry**, not an all-at-once reset. `allObservedCallsExpireAt` assumes no further calls; `nextAvailableSlotAt` is only a local estimate.
- Local admission blocks requests at exhaustion, reserves known-cost batch phases, and bounds upstream concurrency to 4, queue to 64, and request timeouts to 45 seconds. Reservations cannot guarantee external quota or atomic writes.
- Safe GET/HEAD reads may retry **once** for 429/500/502, with at most 5 seconds backoff, or after 0.5 seconds when the connection drops (refused, reset, or cut off mid-body; never after a 45-second timeout). A longer `Retry-After` is exposed as cooldown rather than slept through; absent 429 headers use a labeled local 60-second backoff. Writes and timeouts are never automatically replayed. A transport failure (no complete HTTP response: refused, reset, cut off mid-body, timed out) is reported with the method, endpoint, elapsed time, the network cause, and whether it was a read (safe to retry; says so when the automatic retry failed too) or a write (may have applied), instead of the SDK's generic "The request failed and the interceptors did not return an alternative response". Inspect current state before retrying mutations, especially partial transfers/reconciliation adjustments.
- Only error **403.4** records a data-limit event, an unquantified limit distinct from hourly quota. Other 403 permission errors are not called data limits.
- Automatic local-estimate warnings appear at 50 or fewer remaining, critical below 20, and reached at zero. JSON-in-text results keep warnings inside JSON.

Tool descriptions show baseline costs; retries and flag follow-ups can add calls. Prefer bulk transaction tools to loops. Snapshot reads normally cost one request (delta refresh), an unusable delta adds one full read, and a 503 fallback adds **5 + M + Y** requests (budget months and transaction years) after failed attempts. The fallback preflights discovery and history phases, omits schedules/payee locations, and is not guaranteed to fit the current allowance. Check status before costly reads or apply, preview first, and confirm the specific changes before writing.

### User

| Tool | Description |
|------|-------------|
| `get_user` | Get authenticated user info |

### Budgets

| Tool | Description |
|------|-------------|
| `list_budgets` | List all budgets with optional account info |
| `get_budget` | Refresh a cached export and return a summary/counts/provenance, not the full export; workflows and scoped resources reuse the cache |
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
| `update_transaction` | Update an existing transaction, or split a non-split one (`subtransactions`) |
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
| `create_payee` | Create a payee |

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
| `merge_category` | Merge a source category into a target, moving all transactions and budgeted amounts (1 API call to preview) |
| `delete_category` | Clean up a category for deletion: re-categorizes all history to a replacement and zeros budgets, final delete is manual in the YNAB app — API limitation (1 API call to preview) |
| `audit_credit_card_payments` | Audit credit card and line-of-credit funding gaps for unexplained month-over-month drift, with optional auto-fix (1 API call) |
| `audit_account_reconciliation` | Diagnose an account's reconciliation state (cleared vs. bank balance, unreconciled txn list) with optional close-out |
| `audit_budget_integrity` | Find overspent past category-months, negative Ready to Assign months, uncategorized spending and every card month-end where the payment category differs from what the card owes; plan and optionally apply repairs (from Ready to Assign, else bridged from unused money; a past month whose Ready to Assign is already negative is settled history and blocks nothing unless `strict_ready_to_assign`; with `ask_before_bridging`, borrowing is returned as `proposals` to answer with `bridge_sources`, and `only` limits apply to chosen repairs) (1 API call to audit) |
| `plan_month` | Budget a month: Variable Costs get last month's spending, Fixed Costs goals get funded; flags charges without goals, goals without charges and price changes (1 API call to plan) |
| `suggest_categories` | Suggest categories for uncategorized and unapproved transactions from your history (payee + amount, then payee); bulk-apply the obvious ones (1 API call to suggest) |

| `enrich_transactions` | Match Apple/Amazon receipts to transactions, write the product names into the memo, categorize or split by remembered item categories (1 API call to plan) |
| `list_item_categories` | The item -> category mappings learned so far (0 API calls) |

The snapshot workflows normally read one cached export/delta; the costs above are baselines, not fallback caps. `audit_budget_integrity`, `plan_month`, `suggest_categories` and `enrich_transactions` accept `format: "json"` for automation. Other workflows retain text plus structured results; `list_item_categories` reads only local state.

## Resources

Resources provide structured budget data that clients can pull into context without a tool call. Template resources use URI parameters (e.g., `{budget_id}`).

| Resource | URI | Description | API Cost |
|----------|-----|-------------|----------|
| Usage Guide | `ynab://guide` | Discoverable costs/safety guide, all template URIs and prompt names with examples (also usable by clients without templates/list or initialize instructions) | 0 HTTP |
| API Usage | `ynab://api-usage` | Local rolling-hour estimates, next slot/cooldown and cached snapshot metadata; includes budget/preview guidance | 0 HTTP |
| Budget Summary | `ynab://budgets/{budget_id}/summary` | Snapshot overview with provenance; up to 100 accounts/groups | Snapshot |
| Account List | `ynab://budgets/{budget_id}/accounts` | Account balances/status; up to 500 rows | Normally 1 |
| Monthly Categories | `ynab://budgets/{budget_id}/months/{month}/categories` | Category amounts for one month; up to 500 rows | Normally 1 |
| Category Month | `ynab://budgets/{budget_id}/categories/{category_id}/months/{month}` | One category-month with provenance and goal-history caveat | Snapshot |
| Account Transactions | `ynab://budgets/{budget_id}/accounts/{account_id}/transactions/{since_date}/{until_date}/{limit}/{offset}` | At most 366 days and 100 rows/page (byte bounds may return fewer), offset up to 10000; `next_uri`/`truncated` report output coverage, memos clipped to 200 characters with `memo_truncated` | Snapshot |

Snapshot resource reads cost 0 when the cache is younger than 60 seconds; otherwise normal snapshot/delta/fallback costs above apply. Resource text is capped at 64 KiB with an explicit truncation notice. Dates use YYYY-MM-DD, months use the first of the month. Paging/filters bound returned context, not upstream work: YNAB has no export pagination. All resources use the same token/budget scope as tools, never write, and disclose network costs. Listing resources/templates or retrieving prompts performs no HTTP or filesystem writes.

## Prompts

Prompts are guided workflow templates; retrieval makes zero HTTP requests and does not execute the suggested actions. Each includes budget checks, batching, explicit history windows, preview/confirmation and no-blind-replay guidance. `ynab://guide` lists invocation examples and suggested-action costs.

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `monthly-review` | `budget_id`, `month` | Review a budget month: overspent categories, spending variances, underfunded goals, CC mismatches |
| `transaction-audit` | `budget_id`, `account_id`, `since_date` | Audit transactions for uncategorized, unapproved, duplicates, and unusual amounts |
| `budget-setup-guide` | `budget_id` | Guided walkthrough: accounts, categories, targets, scheduled transactions, fund allocation |
| `spending-analysis` | `budget_id`, `month` | Category breakdown, budget vs. actual, top payees, income vs. spending |
| `credit-card-audit` | `budget_id`, `since_month`? | Audit CC payment category balances with dry-run-first, confirm-before-apply flow |
| `reconcile-account` | `budget_id`, `account_id`, `target_balance` | Walk through reconciling an account against a bank balance, with missing-transaction triage |

## Development

```sh
npm run dev    # Watch mode with tsx
npm run build  # Compile TypeScript
npm test       # Offline contract, snapshot, usage and workflow tests (no account calls)
npm start      # Run compiled server
```

## License

MIT, see [LICENSE](LICENSE).
