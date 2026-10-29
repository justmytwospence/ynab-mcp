/**
 * Bitcoin balances from our own node: bitcoind's `scantxoutset` over its UTXO set. Works
 * on a pruned node, needs no wallet, and sends nothing outside.
 *
 * The RPC user is meant to be whitelisted to exactly METHODS in bitcoin.conf
 * (rpcwhitelist); this client refuses anything else on its side too.
 */
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

export const METHODS = ["getblockchaininfo", "scantxoutset"] as const;
type Method = (typeof METHODS)[number];
type Fetch = typeof fetch;

const b58c = createBase58check(sha256);
const XPUB = Uint8Array.from([0x04, 0x88, 0xb2, 0x1e]);

export function nodeConfigured(env = process.env): boolean {
  return Boolean(env.BITCOIN_RPC_URL && env.BITCOIN_RPC_USER && env.BITCOIN_RPC_PASSWORD);
}

export async function rpc(method: Method, params: unknown[], env = process.env, fetchImpl: Fetch = fetch, timeoutMs = 30_000): Promise<any> {
  if (!(METHODS as readonly string[]).includes(method)) throw new Error(`bitcoind method not allowed: ${method}`);
  const auth = Buffer.from(`${env.BITCOIN_RPC_USER}:${env.BITCOIN_RPC_PASSWORD}`).toString("base64");
  const res = await fetchImpl(env.BITCOIN_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: "1.0", id: "ynab", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await res.json().catch(() => null);
  if (data?.error) throw new Error(`bitcoind ${method}: ${data.error.message ?? data.error.code}`);
  if (!res.ok || !data) throw new Error(`bitcoind ${method}: HTTP ${res.status}`);
  return data.result;
}

/** Synced far enough that its UTXO set is today's. */
export async function nodeReady(env = process.env, fetchImpl: Fetch = fetch): Promise<boolean> {
  const info = await rpc("getblockchaininfo", [], env, fetchImpl);
  return info.initialblockdownload === false && Number(info.verificationprogress) > 0.9999;
}

/** Output descriptors covering a BTC address or an x/y/z pub's receive and change chains. */
export function descriptors(address: string): Array<string | { desc: string; range: number }> {
  const kind = address.slice(0, 4);
  if (!["xpub", "ypub", "zpub"].includes(kind)) return [`addr(${address})`];
  // Same key with xpub's version bytes: descriptors take the script type from the wrapper.
  const raw = b58c.decode(address);
  const xpub = b58c.encode(Uint8Array.from([...XPUB, ...raw.slice(4)]));
  const wrap = kind === "zpub" ? (k: string) => `wpkh(${k})` : kind === "ypub" ? (k: string) => `sh(wpkh(${k}))` : (k: string) => `pkh(${k})`;
  return [0, 1].map((chain) => ({ desc: wrap(`${xpub}/${chain}/*`), range: 999 }));
}

/** Confirmed sats at these descriptors. One scan runs at a time per node: waits for another. */
export async function scanSats(address: string, env = process.env, fetchImpl: Fetch = fetch, waitMs = 15_000): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await rpc("scantxoutset", ["start", descriptors(address)], env, fetchImpl, 600_000);
      if (!r?.success) throw new Error("bitcoind scantxoutset: scan did not complete");
      return Math.round(Number(r.total_amount) * 1e8);
    } catch (e: any) {
      if (!/Scan already in progress/i.test(String(e?.message)) || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
