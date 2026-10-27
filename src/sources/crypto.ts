/**
 * Crypto wallet balances from public data only: addresses (or a BTC extended
 * public key) and public prices. No keys, accounts or API tokens exist here, so
 * nothing in this module can sign or move anything.
 *
 * - BTC address: mempool.space (confirmed balance).
 * - BTC xpub/ypub/zpub: blockchain.info multiaddr (it learns every address in the
 *   wallet, which is a privacy cost, not a security one).
 * - ETH and ERC-20: a public JSON-RPC node (eth_getBalance, balanceOf).
 * - SOL: the public mainnet RPC (getBalance).
 * - Prices: CoinGecko's free simple/price endpoint.
 */

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
}

const NATIVE: Record<Chain, { coingecko: string; symbol: string }> = {
  btc: { coingecko: "bitcoin", symbol: "BTC" },
  eth: { coingecko: "ethereum", symbol: "ETH" },
  sol: { coingecko: "solana", symbol: "SOL" },
};

const ENDPOINTS = {
  mempool: "https://mempool.space/api",
  blockchainInfo: "https://blockchain.info",
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

export function isExtendedKey(address: string): boolean {
  return /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(address);
}

/** Native or token amount held, in whole units. */
export async function walletAmount(w: WalletSpec, fetchImpl: Fetch = fetch): Promise<number> {
  if (w.chain === "btc") {
    if (isExtendedKey(w.address)) {
      const d = await getJson(fetchImpl, `${ENDPOINTS.blockchainInfo}/multiaddr?active=${encodeURIComponent(w.address)}&n=0`);
      return Number(d.wallet?.final_balance ?? 0) / 1e8;
    }
    const d = await getJson(fetchImpl, `${ENDPOINTS.mempool}/address/${encodeURIComponent(w.address)}`);
    return (Number(d.chain_stats.funded_txo_sum) - Number(d.chain_stats.spent_txo_sum)) / 1e8;
  }
  if (w.chain === "eth") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw new Error(`not an Ethereum address: ${w.address}`);
    if (w.token) {
      const data = "0x70a08231" + w.address.slice(2).toLowerCase().padStart(64, "0");
      const hex = await rpc(fetchImpl, ENDPOINTS.eth, "eth_call", [{ to: w.token.contract, data }, "latest"]);
      return unitsToNumber(BigInt(hex === "0x" ? 0 : hex), w.token.decimals);
    }
    const hex = await rpc(fetchImpl, ENDPOINTS.eth, "eth_getBalance", [w.address, "latest"]);
    return unitsToNumber(BigInt(hex), 18);
  }
  if (w.chain === "sol") {
    const r = await rpc(fetchImpl, ENDPOINTS.sol, "getBalance", [w.address, { commitment: "finalized" }]);
    return Number(r.value) / 1e9;
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
export async function walletBalances(wallets: WalletSpec[], fetchImpl: Fetch = fetch): Promise<WalletBalance[]> {
  const [amounts, px] = await Promise.all([
    Promise.all(wallets.map((w) => walletAmount(w, fetchImpl))),
    prices(wallets.map(priceId), fetchImpl),
  ]);
  return wallets.map((w, i) => {
    const price = px[priceId(w)]!;
    const amount = amounts[i]!;
    return {
      chain: w.chain,
      address: w.address,
      symbol: w.token?.symbol ?? (w.token ? w.token.coingecko : NATIVE[w.chain].symbol),
      amount,
      price,
      usd: Math.round(amount * price * 100) / 100,
    };
  });
}
