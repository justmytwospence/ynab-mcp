/**
 * Crypto wallet balances from public data only: addresses (or a BTC extended
 * public key) and public prices. No keys, accounts or API tokens exist here, so
 * nothing in this module can sign or move anything.
 *
 * - BTC address: mempool.space (confirmed balance).
 * - BTC xpub/ypub/zpub: addresses derived here (BIP32 public derivation, receive and
 *   change chains, gap limit 20), each looked up on mempool.space. An extended public
 *   key can only derive addresses, never spend.
 * - ETH and ERC-20: a public JSON-RPC node (eth_getBalance, balanceOf).
 * - SOL: the public mainnet RPC (getBalance).
 * - Prices: CoinGecko's free simple/price endpoint.
 */

import { HDKey } from "@scure/bip32";
import { bech32, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { nodeConfigured, nodeReady, scanSats } from "./bitcoind.js";

export type Chain = "btc" | "eth" | "sol";

export interface WalletSpec {
  chain: Chain;
  address: string;
  /** ERC-20 on eth: contract address, decimals, and its CoinGecko id for pricing. */
  token?: { contract: string; decimals: number; coingecko: string; symbol?: string };
}

export interface WalletBalance {
  chain: Chain;
  address: string;
  symbol: string;
  amount: number;
  price: number;
  usd: number;
  /** Where the amount was read. */
  via: string;
}

const NATIVE: Record<Chain, { coingecko: string; symbol: string }> = {
  btc: { coingecko: "bitcoin", symbol: "BTC" },
  eth: { coingecko: "ethereum", symbol: "ETH" },
  sol: { coingecko: "solana", symbol: "SOL" },
};

const ENDPOINTS = {
  mempool: "https://mempool.space/api",
  eth: "https://ethereum-rpc.publicnode.com",
  sol: "https://api.mainnet-beta.solana.com",
  coingecko: "https://api.coingecko.com/api/v3",
};

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<any> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function rpc(fetchImpl: Fetch, url: string, method: string, params: unknown[]): Promise<any> {
  const data = await getJson(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data.error) throw new Error(`${new URL(url).host} ${method}: ${data.error.message ?? "error"}`);
  return data.result;
}

const b58c = createBase58check(sha256);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
// SLIP-132 version bytes: x = P2PKH (legacy), y = P2SH-P2WPKH, z = P2WPKH (native segwit).
const VERSIONS = {
  x: { public: 0x0488b21e, private: 0x0488ade4 },
  y: { public: 0x049d7cb2, private: 0x049d7878 },
  z: { public: 0x04b24746, private: 0x04b2430c },
} as const;
const GAP = 20;

/** The address at chain/index of an extended public key, in the key's script type. */
export function deriveAddress(key: string, chain: 0 | 1, index: number): string {
  const kind = key[0] as "x" | "y" | "z";
  const node = HDKey.fromExtendedKey(key, VERSIONS[kind]).deriveChild(chain).deriveChild(index);
  const h = hash160(node.publicKey!);
  if (kind === "z") return bech32.encode("bc", [0, ...bech32.toWords(h)]);
  if (kind === "y") return b58c.encode(Uint8Array.from([0x05, ...hash160(Uint8Array.from([0x00, 0x14, ...h]))]));
  return b58c.encode(Uint8Array.from([0x00, ...h]));
}

// Two public Esplora servers with the same API; a wallet scan is tens of lookups, so they are
// made one at a time, alternating, and a 429 waits and tries the other.
const ESPLORA = [ENDPOINTS.mempool, "https://blockstream.info/api"];
let esploraTurn = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esplora(path: string, fetchImpl: Fetch): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const base = ESPLORA[esploraTurn++ % ESPLORA.length]!;
    try {
      return await getJson(fetchImpl, `${base}${path}`);
    } catch (e: any) {
      const retryable = /HTTP 429|HTTP 5\d\d/.test(String(e?.message)) || e?.name === "TimeoutError" || e?.name === "TypeError";
      if (!retryable || attempt >= 5) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function addressStats(address: string, fetchImpl: Fetch): Promise<{ sats: number; used: boolean }> {
  const d = await esplora(`/address/${encodeURIComponent(address)}`, fetchImpl);
  const c = d.chain_stats;
  return { sats: Number(c.funded_txo_sum) - Number(c.spent_txo_sum), used: Number(c.tx_count) + Number(d.mempool_stats?.tx_count ?? 0) > 0 };
}

/** Confirmed balance of a whole HD wallet: both chains, until GAP unused addresses in a row. */
async function extendedKeySats(key: string, fetchImpl: Fetch): Promise<number> {
  let total = 0;
  for (const chain of [0, 1] as const) {
    let unused = 0;
    for (let index = 0; unused < GAP; index++) {
      const s = await addressStats(deriveAddress(key, chain, index), fetchImpl);
      total += s.sats;
      unused = s.used ? 0 : unused + 1;
      if (index > 10_000) throw new Error("extended key scan did not end");
    }
  }
  return total;
}

export function isExtendedKey(address: string): boolean {
  return /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(address);
}

/**
 * Native or token amount held, in whole units, and where it was read.
 * BTC: our own bitcoind when BITCOIN_RPC_* is set and the node is synced, else the public
 * explorers. ETH: ETH_RPC_URL (our Helios light client) when set, else a public node.
 */
export async function walletAmount(w: WalletSpec, fetchImpl: Fetch = fetch, env = process.env): Promise<{ amount: number; via: string }> {
  if (w.chain === "btc") {
    if (nodeConfigured(env)) {
      if (await nodeReady(env, fetchImpl)) return { amount: (await scanSats(w.address, env, fetchImpl)) / 1e8, via: "our bitcoind" };
      const amount = isExtendedKey(w.address) ? (await extendedKeySats(w.address, fetchImpl)) / 1e8 : (await addressStats(w.address, fetchImpl)).sats / 1e8;
      return { amount, via: "public explorers (our node is still syncing)" };
    }
    const amount = isExtendedKey(w.address) ? (await extendedKeySats(w.address, fetchImpl)) / 1e8 : (await addressStats(w.address, fetchImpl)).sats / 1e8;
    return { amount, via: "public explorers" };
  }
  if (w.chain === "eth") {
    const url = env.ETH_RPC_URL || ENDPOINTS.eth;
    const via = env.ETH_RPC_URL ? "our Helios light client" : "a public Ethereum node";
    if (!/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw new Error(`not an Ethereum address: ${w.address}`);
    if (w.token) {
      const data = "0x70a08231" + w.address.slice(2).toLowerCase().padStart(64, "0");
      const hex = await rpc(fetchImpl, url, "eth_call", [{ to: w.token.contract, data }, "latest"]);
      return { amount: unitsToNumber(BigInt(hex === "0x" ? 0 : hex), w.token.decimals), via };
    }
    const hex = await rpc(fetchImpl, url, "eth_getBalance", [w.address, "latest"]);
    return { amount: unitsToNumber(BigInt(hex), 18), via };
  }
  if (w.chain === "sol") {
    const r = await rpc(fetchImpl, ENDPOINTS.sol, "getBalance", [w.address, { commitment: "finalized" }]);
    return { amount: Number(r.value) / 1e9, via: "Solana's public RPC" };
  }
  throw new Error(`unsupported chain: ${(w as WalletSpec).chain}`);
}

export function unitsToNumber(units: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  return Number(`${sign}${abs / base}.${(abs % base).toString().padStart(decimals, "0")}`);
}

export async function prices(ids: string[], fetchImpl: Fetch = fetch): Promise<Record<string, number>> {
  const unique = Array.from(new Set(ids));
  if (!unique.length) return {};
  const d = await getJson(fetchImpl, `${ENDPOINTS.coingecko}/simple/price?ids=${unique.map(encodeURIComponent).join(",")}&vs_currencies=usd`);
  const out: Record<string, number> = {};
  for (const id of unique) {
    const p = d[id]?.usd;
    if (typeof p !== "number") throw new Error(`no CoinGecko price for ${id}`);
    out[id] = p;
  }
  return out;
}

export function priceId(w: WalletSpec): string {
  return w.token?.coingecko ?? NATIVE[w.chain].coingecko;
}

/** Every wallet's amount and dollar value. Throws if any one fails: a partial sum is a wrong balance. */
export async function walletBalances(wallets: WalletSpec[], fetchImpl: Fetch = fetch, env = process.env): Promise<WalletBalance[]> {
  const [amounts, px] = await Promise.all([
    Promise.all(wallets.map((w) => walletAmount(w, fetchImpl, env))),
    prices(wallets.map(priceId), fetchImpl),
  ]);
  return wallets.map((w, i) => {
    const price = px[priceId(w)]!;
    const { amount, via } = amounts[i]!;
    return {
      chain: w.chain,
      address: w.address,
      symbol: w.token?.symbol ?? (w.token ? w.token.coingecko : NATIVE[w.chain].symbol),
      amount,
      price,
      usd: Math.round(amount * price * 100) / 100,
      via,
    };
  });
}
