#!/usr/bin/env node
/**
 * One-off Plaid linking CLI, run by hand in the container (never reachable through MCP):
 *
 *   docker exec -it ynab-mcp node dist/plaid-link.js search vanguard
 *   docker exec -it ynab-mcp node dist/plaid-link.js link
 *
 * `link` prints a Plaid Hosted Link URL. Open it, sign in at your institution, and
 * pick the accounts to share. The CLI then vets the new link and keeps it only if:
 *   1. the institution uses OAuth (Plaid never saw your password),
 *   2. the link consents to investments only (no auth, identity, transfer, ...),
 *   3. Auth (account and routing numbers) and Identity are refused for it.
 * Otherwise it removes the link at Plaid and exits non-zero. On success it prints the
 * access token once, for PLAID_TOKENS in the stack's .env, and the account masks for
 * RECONCILE_MAP.
 */
import { plaidLink, investmentBalances, PlaidError } from "./sources/plaid.js";

const ALLOWED_CONSENT = new Set(["investments", "balance"]);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function search(query: string) {
  const r = await plaidLink("/institutions/search", {
    query,
    products: ["investments"],
    country_codes: ["US"],
  });
  for (const i of r.institutions ?? []) console.log(`${i.institution_id}  oauth=${i.oauth}  ${i.name}`);
}

async function refused(path: "/auth/get" | "/identity/get", accessToken: string): Promise<string | null> {
  try {
    await plaidLink(path, { access_token: accessToken });
    return null;
  } catch (e) {
    if (e instanceof PlaidError) return e.code;
    throw e;
  }
}

async function link() {
  const created = await plaidLink("/link/token/create", {
    user: { client_user_id: "ynab-mcp-owner" },
    client_name: "Homelab YNAB",
    products: ["investments"],
    country_codes: ["US"],
    language: "en",
    hosted_link: {},
  });
  console.log(`Open this link and connect ONE institution (expires in 30 minutes):\n\n  ${created.hosted_link_url}\n`);
  console.log("Waiting for you to finish...");

  let publicToken: string | undefined;
  const deadline = Date.now() + 30 * 60_000;
  while (!publicToken && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const got = await plaidLink("/link/token/get", { link_token: created.link_token });
    for (const s of got.link_sessions ?? []) {
      publicToken ??= s.results?.item_add_results?.[0]?.public_token ?? s.on_success?.public_token;
    }
  }
  if (!publicToken) die("Timed out without a completed link.");

  const { access_token: accessToken } = await plaidLink("/item/public_token/exchange", { public_token: publicToken });
  const remove = async (why: string): Promise<never> => {
    await plaidLink("/item/remove", { access_token: accessToken }).catch(() => undefined);
    die(`Refused and removed the link: ${why}`);
  };

  const { item } = await plaidLink("/item/get", { access_token: accessToken });
  const { institution } = await plaidLink("/institutions/get_by_id", {
    institution_id: item.institution_id,
    country_codes: ["US"],
  });
  console.log(`Institution: ${institution.name} (oauth=${institution.oauth})`);
  if (!institution.oauth) await remove(`${institution.name} does not link through OAuth, so Plaid would hold your password.`);

  const consented: string[] = item.consented_products ?? item.products ?? [];
  const extra = consented.filter((p) => !ALLOWED_CONSENT.has(p));
  if (extra.length) await remove(`the link consents to more than investments: ${extra.join(", ")}`);

  for (const path of ["/auth/get", "/identity/get"] as const) {
    const code = await refused(path, accessToken);
    if (!code) await remove(`${path} succeeded; the link can read more than investments.`);
    console.log(`${path} refused (${code}), as required.`);
  }

  const accounts = await investmentBalances(accessToken);
  console.log("\nAccounts on this link (use the masks in RECONCILE_MAP):");
  for (const a of accounts) console.log(`  …${a.mask}  ${a.name}  $${a.balance.toFixed(2)}`);
  console.log(
    `\nAdd to PLAID_TOKENS in ~/homelab/ynab-mcp/.env (keep it secret; it reads these holdings):\n\n  "${institution.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}": "${accessToken}"\n`
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "search" && rest.length) await search(rest.join(" "));
  else if (cmd === "link") await link();
  else die("usage: plaid-link.js search <institution name> | link");
} catch (e: any) {
  die(e?.message ?? String(e));
}
