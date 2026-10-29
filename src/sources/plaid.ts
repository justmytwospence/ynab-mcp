/**
 * Read-only Plaid client for investment balances.
 *
 * Security model (see README, "Tracking balances"):
 * - The server may call exactly the endpoints in READ_PATHS. Every request goes
 *   through plaidCall, which refuses anything else, so neither a bug nor an agent
 *   driving the MCP can reach Auth (account and routing numbers), Identity,
 *   Transfer, or item management.
 * - The linking CLI (src/plaid-link.ts) is the only caller of LINK_PATHS. It is
 *   run by hand in the container and is not reachable through MCP.
 * - Secrets come from the environment and never appear in results or errors:
 *   error messages carry only Plaid's error_code and display text.
 */

export const READ_PATHS = ["/investments/holdings/get", "/accounts/get"] as const;
export const LINK_PATHS = [
  "/link/token/create",
  "/link/token/get",
  "/item/public_token/exchange",
  "/item/get",
  "/item/remove",
  "/institutions/get_by_id",
  "/institutions/search",
  // Called only to prove Auth is refused for the new link.
  "/auth/get",
] as const;

type ReadPath = (typeof READ_PATHS)[number];
type LinkPath = (typeof LINK_PATHS)[number];

const HOSTS: Record<string, string> = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
};

export class PlaidError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function plaidConfigured(env = process.env): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}

async function call(path: string, body: Record<string, unknown>, env = process.env, fetchImpl = fetch): Promise<any> {
  const host = HOSTS[env.PLAID_ENV ?? "production"];
  if (!host) throw new Error(`PLAID_ENV must be production or sandbox`);
  if (!plaidConfigured(env)) throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are not set");
  const res = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data?.error_code ?? `HTTP_${res.status}`);
    const msg = String(data?.display_message ?? data?.error_message ?? res.statusText ?? "request failed");
    throw new PlaidError(code, `Plaid ${path}: ${code}: ${msg}`, res.status);
  }
  return data;
}

/** The server's only way to reach Plaid. */
export async function plaidRead(path: ReadPath, body: Record<string, unknown>, env = process.env, fetchImpl = fetch) {
  if (!(READ_PATHS as readonly string[]).includes(path)) throw new Error(`Plaid endpoint not allowed: ${path}`);
  return call(path, body, env, fetchImpl);
}

/** Linking CLI only. */
export async function plaidLink(path: LinkPath, body: Record<string, unknown>, env = process.env, fetchImpl = fetch) {
  if (!(LINK_PATHS as readonly string[]).includes(path)) throw new Error(`Plaid endpoint not allowed: ${path}`);
  return call(path, body, env, fetchImpl);
}

export interface PlaidAccountBalance {
  accountId: string;
  mask: string | null;
  name: string;
  /** Current value in dollars (holdings plus cash), as Plaid reports it. */
  balance: number;
  currency: string;
  /** Sum of holdings' institution_value, a cross-check on balance; null without holdings. */
  holdingsValue: number | null;
  asOf: string | null;
}

/** Access tokens from PLAID_TOKENS: a JSON object of link name -> access token. */
export function plaidTokens(env = process.env): Record<string, string> {
  if (!env.PLAID_TOKENS) return {};
  const parsed = JSON.parse(env.PLAID_TOKENS);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PLAID_TOKENS must be a JSON object");
  return parsed;
}

/** Balances of every account on one link. One Plaid request. */
export async function investmentBalances(accessToken: string, env = process.env, fetchImpl = fetch): Promise<PlaidAccountBalance[]> {
  const data = await plaidRead("/investments/holdings/get", { access_token: accessToken }, env, fetchImpl);
  const byAccount = new Map<string, { value: number; asOf: string | null }>();
  for (const h of data.holdings ?? []) {
    const cur = byAccount.get(h.account_id) ?? { value: 0, asOf: null };
    cur.value += Number(h.institution_value ?? 0);
    const asOf = h.institution_price_as_of ?? null;
    if (asOf && (!cur.asOf || asOf > cur.asOf)) cur.asOf = asOf;
    byAccount.set(h.account_id, cur);
  }
  return (data.accounts ?? []).map((a: any) => {
    const h = byAccount.get(a.account_id);
    return {
      accountId: a.account_id,
      mask: a.mask ?? null,
      name: a.official_name || a.name,
      balance: Number(a.balances?.current ?? h?.value ?? 0),
      currency: a.balances?.iso_currency_code ?? "USD",
      holdingsValue: h ? Math.round(h.value * 100) / 100 : null,
      asOf: a.balances?.last_updated_datetime ?? h?.asOf ?? null,
    };
  });
}
