import type { WalletSpec } from "./crypto.js";

/**
 * RECONCILE_MAP: a JSON array saying where each YNAB tracking account's real
 * balance comes from. An account is named by YNAB account id or exact name.
 *
 *   [
 *     {"account": "Roth", "plaid": {"link": "vanguard", "masks": ["1234"]}},
 *     {"account": "Crypto", "wallets": [{"chain": "btc", "address": "zpub..."},
 *                                       {"chain": "eth", "address": "0x..."}]}
 *   ]
 *
 * "link" names an entry in PLAID_TOKENS; "masks" are the last digits Plaid shows
 * for the accounts whose balances add up to this YNAB account.
 */
export interface SourceSpec {
  account: string;
  plaid?: { link: string; masks: string[] };
  wallets?: WalletSpec[];
}

export function reconcileMap(env = process.env): SourceSpec[] {
  if (!env.RECONCILE_MAP) return [];
  const parsed = JSON.parse(env.RECONCILE_MAP);
  if (!Array.isArray(parsed)) throw new Error("RECONCILE_MAP must be a JSON array");
  return parsed.map((s: any, i: number) => {
    if (typeof s?.account !== "string") throw new Error(`RECONCILE_MAP[${i}]: "account" is required`);
    const hasPlaid = s.plaid !== undefined;
    const hasWallets = s.wallets !== undefined;
    if (hasPlaid === hasWallets) throw new Error(`RECONCILE_MAP[${i}] (${s.account}): give exactly one of "plaid" or "wallets"`);
    if (hasPlaid && (typeof s.plaid.link !== "string" || !Array.isArray(s.plaid.masks) || !s.plaid.masks.length)) {
      throw new Error(`RECONCILE_MAP[${i}] (${s.account}): plaid needs "link" and a non-empty "masks"`);
    }
    if (hasWallets) {
      if (!Array.isArray(s.wallets) || !s.wallets.length) throw new Error(`RECONCILE_MAP[${i}] (${s.account}): "wallets" must be a non-empty array`);
      for (const w of s.wallets) {
        if (!["btc", "eth", "sol"].includes(w?.chain) || typeof w.address !== "string") {
          throw new Error(`RECONCILE_MAP[${i}] (${s.account}): each wallet needs chain btc|eth|sol and an address`);
        }
        if (w.token && (w.chain !== "eth" || typeof w.token.contract !== "string" || typeof w.token.decimals !== "number" || typeof w.token.coingecko !== "string")) {
          throw new Error(`RECONCILE_MAP[${i}] (${s.account}): a token needs chain eth, contract, decimals and coingecko`);
        }
      }
    }
    return { account: s.account, plaid: s.plaid, wallets: s.wallets };
  });
}
