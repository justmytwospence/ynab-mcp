import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../utils/register.js";
import { apiUsageTracker } from "../utils/api-usage.js";
import { getClient } from "../ynab-client.js";
import { textResult, errorResult, formatCurrency, dollarsToMilliunits } from "../utils/formatting.js";
import { reconcileMap, type SourceSpec } from "../sources/config.js";
import { investmentBalances, plaidTokens, type PlaidAccountBalance } from "../sources/plaid.js";
import { walletBalances, type WalletBalance } from "../sources/crypto.js";

export interface TrackingBalance {
  account: string;
  accountId: string | null;
  source: "plaid" | "wallets";
  /** Real balance in milliunits, or null when the source failed. */
  sourceBalance: number | null;
  clearedBalance: number | null;
  unclearedBalance: number | null;
  /** sourceBalance - clearedBalance: the adjustment a reconciliation would book. */
  difference: number | null;
  asOf: string | null;
  detail: string[];
  error: string | null;
}

type Deps = {
  fetchPlaid?: (token: string) => Promise<PlaidAccountBalance[]>;
  fetchWallets?: typeof walletBalances;
};

/**
 * Read every mapped source and compare with YNAB. One YNAB request, one Plaid
 * request per link, and the public crypto lookups. A failing source fails only
 * its own accounts.
 */
export async function trackingBalances(
  specs: SourceSpec[],
  ynabAccounts: Array<{ id: string; name: string; cleared_balance: number; uncleared_balance: number; deleted: boolean; closed: boolean }>,
  tokens: Record<string, string>,
  deps: Deps = {}
): Promise<TrackingBalance[]> {
  const fetchPlaid = deps.fetchPlaid ?? ((t: string) => investmentBalances(t));
  const fetchWallets = deps.fetchWallets ?? walletBalances;

  const links = new Map<string, Promise<PlaidAccountBalance[]>>();
  for (const s of specs) {
    if (!s.plaid || links.has(s.plaid.link)) continue;
    const token = tokens[s.plaid.link];
    links.set(s.plaid.link, token ? fetchPlaid(token) : Promise.reject(new Error(`no PLAID_TOKENS entry "${s.plaid.link}"`)));
  }
  for (const p of links.values()) p.catch(() => undefined);

  return Promise.all(
    specs.map(async (s): Promise<TrackingBalance> => {
      const live = ynabAccounts.filter((a) => !a.deleted && !a.closed);
      const acct = live.find((a) => a.id === s.account) ?? live.find((a) => a.name === s.account);
      const out: TrackingBalance = {
        account: acct?.name ?? s.account,
        accountId: acct?.id ?? null,
        source: s.plaid ? "plaid" : "wallets",
        sourceBalance: null,
        clearedBalance: acct?.cleared_balance ?? null,
        unclearedBalance: acct?.uncleared_balance ?? null,
        difference: null,
        asOf: null,
        detail: [],
        error: null,
      };
      try {
        if (!acct) throw new Error(`no open YNAB account "${s.account}"`);
        let dollars = 0;
        if (s.plaid) {
          const accounts = await links.get(s.plaid.link)!;
          for (const mask of s.plaid.masks) {
            const a = accounts.find((x) => x.mask === mask);
            if (!a) throw new Error(`Plaid link "${s.plaid.link}" has no account ending ${mask}`);
            if (a.currency !== "USD") throw new Error(`account ending ${mask} is in ${a.currency}`);
            dollars += a.balance;
            if (a.asOf && (!out.asOf || a.asOf > out.asOf)) out.asOf = a.asOf;
            out.detail.push(`${a.name} (…${mask}): $${a.balance.toFixed(2)}`);
          }
        } else {
          const wallets: WalletBalance[] = await fetchWallets(s.wallets!);
          for (const w of wallets) {
            dollars += w.usd;
            out.detail.push(`${w.amount} ${w.symbol} @ $${w.price} = $${w.usd.toFixed(2)} (${w.chain} ${w.address.slice(0, 6)}…${w.address.slice(-4)}, via ${w.via})`);
          }
          out.asOf = new Date().toISOString();
        }
        out.sourceBalance = dollarsToMilliunits(Math.round(dollars * 100) / 100);
        out.difference = out.sourceBalance - acct.cleared_balance;
      } catch (e: any) {
        out.error = e?.message ?? String(e);
      }
      return out;
    })
  );
}

export function registerTrackingBalanceTools(server: McpServer) {
  if (!process.env.RECONCILE_MAP) return;
  registerTool(server, "get_tracking_balances", {
    title: "Get Tracking Account Balances",
    description:
      "[1 API call] Read-only. For each tracking account configured in RECONCILE_MAP, reads its real balance " +
      "(investment accounts through read-only Plaid; crypto from public wallet addresses and public prices) and " +
      "compares it with YNAB's cleared balance. Returns the difference a reconciliation would book; to book it, " +
      "call audit_account_reconciliation with target_balance. Changes nothing.",
    inputSchema: z.object({
      budget_id: z.string().default("last-used").describe("Budget ID or 'last-used'"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ budget_id }) => {
    try {
      apiUsageTracker.assertAvailable(1);
      const res = await getClient().accounts.getAccounts(budget_id);
      const rows = await trackingBalances(reconcileMap(), res.data.accounts, plaidTokens());
      const lines = ["Tracking account balances:"];
      for (const r of rows) {
        if (r.error) { lines.push(`  ${r.account}: ERROR ${r.error}`); continue; }
        lines.push(
          `  ${r.account}: source ${formatCurrency(r.sourceBalance!)}, YNAB cleared ${formatCurrency(r.clearedBalance!)}, ` +
          `difference ${formatCurrency(r.difference!)}${r.asOf ? ` (as of ${r.asOf})` : ""}`
        );
        for (const d of r.detail) lines.push(`    ${d}`);
      }
      return textResult(lines.join("\n"), { accounts: rows });
    } catch (e) {
      return errorResult(e);
    }
  });
}
