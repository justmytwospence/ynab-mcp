/** Read-only adapter to an already indexed BTCPay/NBXplorer wallet. No wallet setup or scanning. */
import { nodeConfigured, rpc } from "./bitcoind.js";

type Fetch = typeof fetch;
type BtcMovement = { date: string; txid: string; sats: number };
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const HASH = /^[0-9a-fA-F]{64}$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Validate without ever including a configured URL or key in an error. */
export function btcpayConfig(env = process.env): { origin: string; key: string } {
  let url: URL;
  try {
    url = new URL(env.BTCPAY_URL ?? "");
  } catch {
    throw new Error("BTCPAY_URL must be an HTTP(S) URL without embedded credentials");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("BTCPAY_URL must be an HTTP(S) URL without embedded credentials");
  }
  if (!env.BTCPAY_API_KEY?.trim()) throw new Error("BTCPAY_API_KEY is required for BTCPay wallets");
  return { origin: url.origin, key: env.BTCPAY_API_KEY };
}

function walletPath(storeId: string): string {
  if (typeof storeId !== "string" || !storeId.trim() || storeId === "." || storeId === "..") {
    throw new Error("BTCPay store_id must be non-empty and identify a store");
  }
  return `/api/v1/stores/${encodeURIComponent(storeId)}/payment-methods/BTC-CHAIN/wallet`;
}

async function getJson(path: string, fetchImpl: Fetch, env: NodeJS.ProcessEnv): Promise<any> {
  const { origin, key } = btcpayConfig(env);
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method: "GET",
      headers: { Authorization: `token ${key}` },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    // Fetch errors can contain URLs, request headers, or credentials supplied by a mock/proxy.
    throw new Error("BTCPay request failed or timed out");
  }
  if (!res.ok) throw new Error(`BTCPay: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("BTCPay returned malformed JSON");
  }
}

function height(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function requireSynced(fetchImpl: Fetch, env: NodeJS.ProcessEnv): Promise<void> {
  const info = await getJson("/api/v1/server/info", fetchImpl, env);
  const rows = Array.isArray(info?.syncStatus) ? info.syncStatus.filter((s: any) => s?.paymentMethodId === "BTC-CHAIN") : [];
  const s = rows.length === 1 ? rows[0] : undefined;
  const n = s?.nodeInformation;
  // Global fullySynched includes other payment rails; only BTC-CHAIN is relevant here.
  if (s?.available !== true || !height(s.syncHeight) || !height(s.chainHeight) || s.syncHeight < s.chainHeight ||
      !height(n?.blocks) || !height(n?.headers) || n.blocks < n.headers ||
      typeof n?.verificationProgress !== "number" || !Number.isFinite(n.verificationProgress) || n.verificationProgress <= 0.9999) {
    throw new Error("BTCPay BTC-CHAIN is unavailable, behind, or has malformed sync status");
  }
}

/** Decimal BTC strings only: never round through floating point on the way to satoshis. */
function decimalSats(value: unknown, signed: boolean): number {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value) || (!signed && value.startsWith("-"))) {
    throw new Error("BTCPay returned an invalid BTC decimal amount");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const sats = (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"))) * (negative ? -1n : 1n);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER) || sats < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("BTCPay BTC amount exceeds safe integer satoshis");
  }
  return Number(sats);
}

export async function btcpaySats(storeId: string, fetchImpl: Fetch = fetch, env = process.env): Promise<number> {
  const path = walletPath(storeId);
  await requireSynced(fetchImpl, env);
  const wallet = await getJson(path, fetchImpl, env);
  return decimalSats(wallet?.confirmedBalance, false);
}

export async function btcpayMovements(
  storeId: string,
  since: string,
  historySince: string,
  fetchImpl: Fetch = fetch,
  env = process.env,
): Promise<BtcMovement[]> {
  if (!isCalendarDate(since) || !isCalendarDate(historySince)) throw new Error("BTC history dates must be real YYYY-MM-DD dates");
  if (since < historySince) {
    throw new Error(`BTC history is only verified from ${historySince}; review earlier movements before reconciling`);
  }
  const path = walletPath(storeId);
  btcpayConfig(env);
  if (!nodeConfigured(env)) throw new Error("bitcoind RPC configuration is required for BTC history block dates");
  await requireSynced(fetchImpl, env);
  const txs = new Map<string, { sats: number; blockHash: string }>();
  for (let page = 0; page < MAX_PAGES; page++) {
    // BTCPay 2.4.6 double-applies skip without statusFilter. Never use labelFilter.
    const list = await getJson(`${path}/transactions?statusFilter=Confirmed&skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`, fetchImpl, env);
    if (!Array.isArray(list) || list.length > PAGE_SIZE) throw new Error("BTCPay returned malformed BTC transactions");
    for (const t of list) {
      if (typeof t?.transactionHash !== "string" || !HASH.test(t.transactionHash) ||
          typeof t.blockHash !== "string" || !HASH.test(t.blockHash) ||
          t.status !== "Confirmed" || !height(t.confirmations) || t.confirmations === 0 || !height(t.blockHeight)) {
        throw new Error("BTCPay returned a malformed or unconfirmed BTC transaction");
      }
      const txid = t.transactionHash.toLowerCase();
      const entry = { sats: decimalSats(t.amount, true), blockHash: t.blockHash.toLowerCase() };
      const previous = txs.get(txid);
      if (previous && (previous.sats !== entry.sats || previous.blockHash !== entry.blockHash)) {
        throw new Error("BTCPay returned conflicting duplicate BTC transactions");
      }
      txs.set(txid, entry);
    }
    if (list.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) throw new Error("BTCPay BTC history exceeded 100 full pages; refusing partial history");
  }
  // Per-call deduplication only; accounting dates always come from our node's block headers.
  const dates = new Map<string, string>();
  const out: BtcMovement[] = [];
  for (const [txid, t] of txs) {
    let date = dates.get(t.blockHash);
    if (!date) {
      let header: any;
      try {
        header = await rpc("getblockheader", [t.blockHash, true], env, fetchImpl, 20_000);
      } catch {
        throw new Error("BTCPay BTC history: block header lookup failed or timed out");
      }
      if (typeof header?.hash !== "string" || header.hash.toLowerCase() !== t.blockHash ||
          !height(header.confirmations) || header.confirmations === 0 || !height(header.time) ||
          !Number.isFinite(new Date(header.time * 1000).getTime())) {
        throw new Error("BTCPay BTC history: malformed or orphaned block header");
      }
      date = new Date(header.time * 1000).toISOString().slice(0, 10);
      dates.set(t.blockHash, date);
    }
    if (date >= since && t.sats !== 0) out.push({ date, txid, sats: t.sats });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.txid.localeCompare(b.txid));
}
