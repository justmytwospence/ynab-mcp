import { test } from "node:test";
import assert from "node:assert/strict";
import { plaidRead, plaidLink, investmentBalances, READ_PATHS, PlaidError } from "./plaid.js";
import { walletAmount, walletBalances, walletMovements, unitsToNumber, isExtendedKey } from "./crypto.js";
import { reconcileMap } from "./config.js";
import { trackingBalances } from "../tools/tracking-balances.js";

const env = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec" } as NodeJS.ProcessEnv;

function jsonFetch(handler: (url: string, body: any) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const r = handler(url, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("Plaid: the server can reach only the read allowlist", async () => {
  assert.deepEqual([...READ_PATHS], ["/investments/holdings/get", "/accounts/get"]);
  const { f, calls } = jsonFetch(() => ({ body: {} }));
  for (const p of ["/auth/get", "/identity/get", "/transfer/create", "/item/remove", "/processor/token/create"]) {
    await assert.rejects(() => plaidRead(p as any, {}, env, f), /not allowed/);
  }
  for (const p of ["/transfer/create", "/processor/token/create", "/investments/transactions/get"]) {
    await assert.rejects(() => plaidLink(p as any, {}, env, f), /not allowed/);
  }
  assert.equal(calls.length, 0);
});

test("Plaid: errors carry the code, never the secret", async () => {
  const { f } = jsonFetch(() => ({ status: 400, body: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login needed" } }));
  const err = await plaidRead("/accounts/get", { access_token: "tok" }, env, f).catch((e) => e);
  assert.ok(err instanceof PlaidError);
  assert.equal(err.code, "ITEM_LOGIN_REQUIRED");
  assert.doesNotMatch(err.message, /sec|tok/);
});

test("Plaid: investment balances per account with a holdings cross-check", async () => {
  const { f, calls } = jsonFetch(() => ({
    body: {
      accounts: [
        { account_id: "a1", mask: "1111", name: "Roth IRA", balances: { current: 1000.5, iso_currency_code: "USD" } },
        { account_id: "a2", mask: "2222", name: "Brokerage", balances: { current: null, iso_currency_code: "USD" } },
      ],
      holdings: [
        { account_id: "a1", institution_value: 1000.5, institution_price_as_of: "2026-10-24" },
        { account_id: "a2", institution_value: 40, institution_price_as_of: "2026-10-23" },
        { account_id: "a2", institution_value: 2.25 },
      ],
    },
  }));
  const r = await investmentBalances("tok", { ...env, PLAID_ENV: "sandbox" }, f);
  assert.equal(calls[0]!.url, "https://sandbox.plaid.com/investments/holdings/get");
  assert.equal(calls[0]!.body.access_token, "tok");
  assert.deepEqual(r.map((a) => [a.mask, a.balance, a.holdingsValue, a.asOf]), [
    ["1111", 1000.5, 1000.5, "2026-10-24"],
    ["2222", 42.25, 42.25, "2026-10-23"],
  ]);
});

// BIP84 test vector (mnemonic "abandon ... about"), account 0.
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const firstZ = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

test("crypto: BIP84 derivation matches the test vectors", async () => {
  const { deriveAddress } = await import("./crypto.js");
  assert.equal(deriveAddress(ZPUB, 0, 0), firstZ);
  assert.equal(deriveAddress(ZPUB, 0, 1), "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
  assert.equal(deriveAddress(ZPUB, 1, 0), "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
});

test("crypto: address and xpub lookups, units and prices", async () => {
  assert.equal(unitsToNumber(1234567890000000000n, 18), 1.23456789);
  assert.equal(isExtendedKey("zpub" + "A".repeat(107)), true);
  assert.equal(isExtendedKey("bc1qxyz"), false);
  const { f, calls } = jsonFetch((url, body) => {
    if (url.includes("coingecko")) return { body: { bitcoin: { usd: 100000 }, ethereum: { usd: 4000 }, solana: { usd: 200 }, "usd-coin": { usd: 1 } } };
    if (url.includes("mempool.space") || url.includes("blockstream.info")) {
      // The first receive address of the test zpub holds 0.25 BTC; the plain address 1 BTC.
      if (url.endsWith(`/address/${firstZ}`)) return { body: { chain_stats: { funded_txo_sum: 25_000_000, spent_txo_sum: 0, tx_count: 1 } } };
      if (url.endsWith("/address/bc1qexample")) return { body: { chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 50_000_000, tx_count: 2 } } };
      return { body: { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } } };
    }
    if (url.includes("publicnode")) {
      if (body.method === "eth_getBalance") return { body: { result: "0xde0b6b3a7640000" } }; // 1 ETH
      return { body: { result: "0x" + (2_500_000n).toString(16) } }; // 2.5 USDC
    }
    if (url.includes("solana")) return { body: { result: { value: 3_000_000_000 } } };
    throw new Error(url);
  });
  const addr = "0x" + "ab".repeat(20);
  const r = await walletBalances([
    { chain: "btc", address: "bc1qexample" },
    { chain: "btc", address: ZPUB },
    { chain: "eth", address: addr },
    { chain: "eth", address: addr, token: { contract: "0xA0b8", decimals: 6, coingecko: "usd-coin", symbol: "USDC" } },
    { chain: "sol", address: "So1ana" },
  ], f);
  assert.deepEqual(r.map((w) => [w.symbol, w.amount, w.usd]), [
    ["BTC", 1, 100000], ["BTC", 0.25, 25000], ["ETH", 1, 4000], ["USDC", 2.5, 2.5], ["SOL", 3, 600],
  ]);
  const call = calls.find((c) => c.body?.method === "eth_call")!;
  assert.equal(call.body.params[0].data, "0x70a08231" + "ab".repeat(20).padStart(64, "0"));
  assert.ok(calls.every((c) => c.url.startsWith("https://")));
  await assert.rejects(() => walletAmount({ chain: "eth", address: "nope" }, f), /not an Ethereum address/);
});

test("config: validates RECONCILE_MAP", () => {
  assert.deepEqual(reconcileMap({} as NodeJS.ProcessEnv), []);
  const ok = reconcileMap({ RECONCILE_MAP: JSON.stringify([
    { account: "Roth", plaid: { link: "vanguard", masks: ["1"] } },
    { account: "Crypto", wallets: [{ chain: "btc", address: "bc1" }] },
  ]) } as NodeJS.ProcessEnv);
  assert.equal(ok.length, 2);
  for (const bad of [
    [{ account: "X" }],
    [{ account: "X", plaid: { link: "v", masks: [] } }],
    [{ account: "X", wallets: [{ chain: "doge", address: "D" }] }],
    [{ account: "X", wallets: [{ chain: "btc", address: "b", token: { contract: "c", decimals: 1, coingecko: "x" } }] }],
  ]) assert.throws(() => reconcileMap({ RECONCILE_MAP: JSON.stringify(bad) } as NodeJS.ProcessEnv));
});

test("trackingBalances: sums masks, isolates failures, computes the adjustment", async () => {
  const ynab = [
    { id: "r", name: "Roth", cleared_balance: 1_000_000, uncleared_balance: 0, deleted: false, closed: false },
    { id: "t", name: "Taxable", cleared_balance: 5_000_000, uncleared_balance: 0, deleted: false, closed: false },
    { id: "c", name: "Crypto", cleared_balance: 100_000, uncleared_balance: 0, deleted: false, closed: false },
    { id: "f", name: "Fidelity HSA", cleared_balance: 1, uncleared_balance: 0, deleted: false, closed: false },
  ];
  let plaidCalls = 0;
  const rows = await trackingBalances(
    [
      { account: "Roth", plaid: { link: "vanguard", masks: ["1", "2"] } },
      { account: "t", plaid: { link: "vanguard", masks: ["9"] } },
      { account: "Crypto", wallets: [{ chain: "btc", address: "bc1" }] },
      { account: "Fidelity HSA", plaid: { link: "fidelity", masks: ["3"] } },
      { account: "Gone", plaid: { link: "vanguard", masks: ["1"] } },
    ],
    ynab,
    { vanguard: "tok" },
    {
      fetchPlaid: async () => {
        plaidCalls++;
        return [
          { accountId: "1", mask: "1", name: "A", balance: 600, currency: "USD", holdingsValue: 600, asOf: "2026-10-24" },
          { accountId: "2", mask: "2", name: "B", balance: 500.25, currency: "USD", holdingsValue: 500, asOf: "2026-10-25" },
        ];
      },
      fetchWallets: async () => [{ chain: "btc", address: "bc1", symbol: "BTC", amount: 0.001, price: 100000, usd: 100, via: "test" }],
    }
  );
  assert.equal(plaidCalls, 1);
  const [roth, taxable, crypto, hsa, gone] = rows;
  assert.equal(roth!.sourceBalance, 1_100_250);
  assert.equal(roth!.difference, 100_250);
  assert.equal(roth!.asOf, "2026-10-25");
  assert.match(taxable!.error!, /no account ending 9/);
  assert.equal(crypto!.difference, 0);
  assert.match(hsa!.error!, /no PLAID_TOKENS entry "fidelity"/);
  assert.match(gone!.error!, /no open YNAB account/);
});

test("bitcoind: allowlist, descriptors, ready and syncing paths", async () => {
  const { rpc, descriptors, METHODS } = await import("./bitcoind.js");
  assert.deepEqual([...METHODS], ["getblockchaininfo", "scantxoutset", "getblockheader"]);
  const benv = { BITCOIN_RPC_URL: "http://bitcoind:8332", BITCOIN_RPC_USER: "ynab", BITCOIN_RPC_PASSWORD: "pw" } as NodeJS.ProcessEnv;
  for (const m of ["getbalance", "listwallets", "stop", "sendtoaddress", "dumpprivkey"]) {
    await assert.rejects(() => rpc(m as any, [], benv, (async () => { throw new Error("no call"); }) as any), /not allowed/);
  }
  // The BIP84 account's xpub form, as `bip32 -> xpub` re-encodes it.
  const d = descriptors(ZPUB) as Array<{ desc: string; range: number }>;
  assert.match(d[0]!.desc, /^wpkh\(xpub[1-9A-HJ-NP-Za-km-z]+\/0\/\*\)$/);
  assert.match(d[1]!.desc, /\/1\/\*\)$/);
  assert.equal(d[0]!.range, 999);
  assert.deepEqual(descriptors("bc1qexample"), ["addr(bc1qexample)"]);
  const { HDKey } = await import("@scure/bip32");
  const fromX = HDKey.fromExtendedKey(d[0]!.desc.slice(5, -5));
  const fromZ = HDKey.fromExtendedKey(ZPUB, { public: 0x04b24746, private: 0x04b2430c });
  assert.deepEqual(fromX.publicKey, fromZ.publicKey);

  let ready = false;
  let scans = 0;
  const { f, calls } = jsonFetch((url, body) => {
    if (url.startsWith("http://bitcoind")) {
      if (body.method === "getblockchaininfo") return { body: { result: { initialblockdownload: !ready, verificationprogress: ready ? 0.99999 : 0.4 }, error: null } };
      scans++;
      if (scans === 1) return { status: 500, body: { result: null, error: { code: -8, message: "Scan already in progress, use action \"abort\" or \"status\"" } } };
      return { body: { result: { success: true, total_amount: 0.5 }, error: null } };
    }
    if (url.includes("coingecko")) return { body: { bitcoin: { usd: 100000 } } };
    if (url.includes("mempool.space") || url.includes("blockstream.info")) return { body: { chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 0, tx_count: 1 } } };
    throw new Error(url);
  });
  const { walletBalances: wb } = await import("./crypto.js");
  const syncing = await wb([{ chain: "btc", address: "bc1qexample" }], f, benv);
  assert.equal(syncing[0]!.via, "public explorers (our node is still syncing)");
  const down = await wb([{ chain: "btc", address: "bc1qexample" }], (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("http://bitcoind")) throw new TypeError("fetch failed");
    return f(url, init);
  }) as typeof fetch, benv);
  assert.equal(down[0]!.via, "public explorers (our node is not answering)");
  ready = true;
  const { scanSats } = await import("./bitcoind.js");
  assert.equal(await scanSats("bc1qexample", benv, f, 1), 50_000_000);
  assert.equal(scans, 2);
  const auth = calls.find((c) => c.url.startsWith("http://bitcoind"));
  assert.ok(auth);
});

test("ETH_RPC_URL replaces the public node", async () => {
  const { f, calls } = jsonFetch((url) => {
    if (url.includes("coingecko")) return { body: { ethereum: { usd: 4000 } } };
    return { body: { result: "0xde0b6b3a7640000" } };
  });
  const r = await walletBalances([{ chain: "eth", address: "0x" + "ab".repeat(20) }], f, { ETH_RPC_URL: "http://helios:8545" } as NodeJS.ProcessEnv);
  assert.equal(r[0]!.via, "our Helios light client");
  assert.ok(calls.some((c) => c.url === "http://helios:8545"));
  assert.ok(!calls.some((c) => c.url.includes("publicnode")));
});

const btcpayEnv = {
  BTCPAY_URL: "http://btcpay:23000",
  BTCPAY_API_KEY: "test-read-only-key",
  BITCOIN_RPC_URL: "http://bitcoind:8332",
  BITCOIN_RPC_USER: "ynab",
  BITCOIN_RPC_PASSWORD: "pw",
} as NodeJS.ProcessEnv;
const btcpayWallet = {
  chain: "btc" as const,
  address: ZPUB,
  btcpay: { store_id: "store/with space", history_since: "2026-08-07" },
};
const btcpayWalletPath = `/api/v1/stores/${encodeURIComponent(btcpayWallet.btcpay.store_id)}/payment-methods/BTC-CHAIN/wallet`;
const syncedBTCPay = {
  syncStatus: [{
    paymentMethodId: "BTC-CHAIN", available: true, syncHeight: 900000, chainHeight: 900000,
    nodeInformation: { blocks: 900000, headers: 900000, verificationProgress: 1 },
  }],
};
const btcHistoryCoverageError = "BTC history is only verified from 2026-08-07; review earlier movements before reconciling";
const blockHash = "ab".repeat(32);
const blockTime = Date.parse("2026-09-10T12:00:00Z") / 1000;
function confirmedBTCPayTx(transactionHash = "cd".repeat(32), amount = "-0.30001000") {
  return {
    transactionHash, amount, blockHash, confirmations: 6, status: "Confirmed", blockHeight: 899995,
    // BTCPay first saw this transaction on a different day: only the block header dates it.
    timestamp: "2026-09-09T23:59:00Z",
  };
}

type BTCPayCall = { url: string; method: string; body: any; headers: Headers };
function btcpayFetch(override?: (call: BTCPayCall) => { status?: number; body: unknown } | undefined) {
  const calls: BTCPayCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input), method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    let response = override?.(call);
    if (!response) {
      if (call.url === `${btcpayEnv.BTCPAY_URL}/api/v1/server/info`) response = { body: syncedBTCPay };
      else if (call.url === `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}`) response = { body: { confirmedBalance: "0.25000001" } };
      else if (call.url === `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}/transactions?statusFilter=Confirmed&skip=0&limit=100`) response = { body: [confirmedBTCPayTx()] };
      else if (call.url === btcpayEnv.BITCOIN_RPC_URL && call.body?.method === "getblockheader") {
        response = { body: { result: { hash: blockHash, confirmations: 6, time: blockTime }, error: null } };
      } else if (call.url === "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd") response = { body: { bitcoin: { usd: 100000 } } };
      else if (call.url === "https://api.coingecko.com/api/v3/coins/bitcoin/history?date=10-09-2026&localization=false") response = { body: { market_data: { current_price: { usd: 60000 } } } };
    }
    assert.ok(response, `unexpected request: ${call.method} ${call.url} ${JSON.stringify(call.body)}`);
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

// Check recorded calls even on rejected operations: a caught fetch error must not hide a fallback.
function assertBTCPayReadOnly(calls: BTCPayCall[]) {
  for (const call of calls) {
    if (call.url.startsWith(`${btcpayEnv.BTCPAY_URL}/`)) {
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
      assert.equal(call.headers.get("Authorization"), `token ${btcpayEnv.BTCPAY_API_KEY}`);
      const url = new URL(call.url);
      assert.ok(["/api/v1/server/info", btcpayWalletPath, `${btcpayWalletPath}/transactions`].includes(url.pathname), call.url);
      if (url.pathname.endsWith("/transactions")) {
        assert.match(url.search, /^\?statusFilter=Confirmed&skip=\d+&limit=100$/);
        assert.equal(Number(url.searchParams.get("skip")) % 100, 0);
      } else assert.equal(url.search, "");
    } else if (call.url === btcpayEnv.BITCOIN_RPC_URL) {
      assert.equal(call.method, "POST");
      assert.equal(call.body.method, "getblockheader");
    } else {
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
      const url = new URL(call.url);
      assert.equal(url.origin, "https://api.coingecko.com");
      assert.ok(["/api/v3/simple/price", "/api/v3/coins/bitcoin/history"].includes(url.pathname), call.url);
    }
  }
}

test("config: BTCPay accepts only BTC extended public identities and real coverage dates", async () => {
  const parse = (wallet: unknown, overrides: NodeJS.ProcessEnv = {}) => reconcileMap({
    ...btcpayEnv, ...overrides, RECONCILE_MAP: JSON.stringify([{ account: "BTC", wallets: [wallet] }]),
  });
  const { HDKey } = await import("@scure/bip32");
  const node = HDKey.fromExtendedKey(ZPUB, { public: 0x04b24746, private: 0x04b2430c });
  for (const versions of [
    { public: 0x0488b21e, private: 0x0488ade4 },
    { public: 0x049d7cb2, private: 0x049d7878 },
    { public: 0x04b24746, private: 0x04b2430c },
  ]) {
    const address = new HDKey({ publicKey: node.publicKey!, chainCode: node.chainCode!, versions }).publicExtendedKey;
    const wallet = { ...btcpayWallet, address };
    assert.deepEqual(parse(wallet)[0]!.wallets, [wallet]);
  }
  for (const history_since of ["2024-02-29", "2026-08-07"]) {
    assert.equal(parse({ ...btcpayWallet, btcpay: { ...btcpayWallet.btcpay, history_since } }).length, 1);
  }
  const invalid = [
    { ...btcpayWallet, chain: "eth" },
    { ...btcpayWallet, chain: "sol" },
    { ...btcpayWallet, address: firstZ },
    { ...btcpayWallet, address: "zpub" + "A".repeat(107) },
    { ...btcpayWallet, address: ZPUB.slice(0, -1) + "1" },
    { ...btcpayWallet, btcpay: null },
    { ...btcpayWallet, btcpay: {} },
    ...["", "   ", 42].map((store_id) => ({ ...btcpayWallet, btcpay: { ...btcpayWallet.btcpay, store_id } })),
    ...[undefined, "", "2026-8-07", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-08-00", "2026-08-07T00:00:00Z"].map((history_since) => ({
      ...btcpayWallet, btcpay: { ...btcpayWallet.btcpay, history_since },
    })),
  ];
  for (const wallet of invalid) assert.throws(() => parse(wallet), JSON.stringify(wallet));
  for (const BTCPAY_URL of [undefined, "", "btcpay:23000", "ftp://btcpay", "http://", "https://user:secret@btcpay", "http://user@btcpay"]) {
    assert.throws(() => parse(btcpayWallet, { BTCPAY_URL }), String(BTCPAY_URL));
  }
  for (const BTCPAY_API_KEY of [undefined, "", "   "]) assert.throws(() => parse(btcpayWallet, { BTCPAY_API_KEY }));
  assert.equal(parse(btcpayWallet, { BTCPAY_URL: "https://btcpay.example" }).length, 1);
});

test("walletAmount: BTCPay wins over configured bitcoind and never scans or registers a wallet", async () => {
  const { f, calls } = btcpayFetch();
  assert.deepEqual(await walletAmount(btcpayWallet, f, btcpayEnv), {
    amount: 0.25000001, via: "our BTCPay/NBXplorer (our bitcoind)",
  });
  assertBTCPayReadOnly(calls);
  assert.deepEqual(calls.map((c) => c.url).sort(), [
    `${btcpayEnv.BTCPAY_URL}/api/v1/server/info`, `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}`,
  ].sort());
});

test("walletAmount: BTCPay errors fail closed without bitcoind scans or public fallback", async (t) => {
  for (const failure of ["offline", "unauthorized", "syncing", "unavailable", "balance error"] as const) {
    await t.test(failure, async () => {
      const { f, calls } = btcpayFetch((call) => {
        if (call.url === `${btcpayEnv.BTCPAY_URL}/api/v1/server/info`) {
          if (failure === "offline") throw new TypeError("BTCPay unavailable");
          if (failure === "unauthorized") return { status: 401, body: {} };
          if (failure === "syncing") return { body: { syncStatus: [{ ...syncedBTCPay.syncStatus[0], syncHeight: 899000 }] } };
          if (failure === "unavailable") return { body: { syncStatus: [{ ...syncedBTCPay.syncStatus[0], available: false }] } };
        }
        if (failure === "balance error" && call.url === `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}`) return { status: 503, body: {} };
      });
      await assert.rejects(() => walletAmount(btcpayWallet, f, btcpayEnv));
      assert.ok(calls.length > 0);
      assertBTCPayReadOnly(calls);
      assert.ok(calls.every((c) => c.url.startsWith(`${btcpayEnv.BTCPAY_URL}/`)));
    });
  }
});

test("walletMovements: BTCPay uses block-header dates and keeps historical USD Movement values", async () => {
  const incoming = confirmedBTCPayTx("ef".repeat(32), "0.50000000");
  const { f, calls } = btcpayFetch((call) => call.url.endsWith("/transactions?statusFilter=Confirmed&skip=0&limit=100")
    ? { body: [incoming, confirmedBTCPayTx()] } : undefined);
  const result = await walletMovements([btcpayWallet], "2026-09-10", f, btcpayEnv);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(result.movements.slice().sort((a, b) => a.txid.localeCompare(b.txid)), [
    { date: "2026-09-10", txid: "cd".repeat(32), chain: "btc", symbol: "BTC", amount: -0.30001, price: 60000, usd: -18000.6 },
    { date: "2026-09-10", txid: "ef".repeat(32), chain: "btc", symbol: "BTC", amount: 0.5, price: 60000, usd: 30000 },
  ]);
  assertBTCPayReadOnly(calls);
  assert.ok(calls.some((c) => c.url.endsWith("/api/v1/server/info")));
  assert.ok(calls.some((c) => c.url.endsWith("/transactions?statusFilter=Confirmed&skip=0&limit=100")));
  const headers = calls.filter((c) => c.body?.method === "getblockheader");
  assert.ok(headers.length > 0);
  assert.ok(headers.every((c) => c.body.params[0] === blockHash));
  assert.ok(calls.some((c) => c.url.endsWith("/coins/bitcoin/history?date=10-09-2026&localization=false")));
});

test("walletMovements: BTCPay paginates confirmed history with fixed read-only query parameters", async () => {
  const page = Array.from({ length: 100 }, (_, i) => confirmedBTCPayTx((i + 1).toString(16).padStart(64, "0"), "0.00000001"));
  const { f, calls } = btcpayFetch((call) => {
    if (call.url.endsWith("/transactions?statusFilter=Confirmed&skip=0&limit=100")) return { body: page };
    if (call.url.endsWith("/transactions?statusFilter=Confirmed&skip=100&limit=100")) return { body: [] };
  });
  const result = await walletMovements([btcpayWallet], "2026-08-07", f, btcpayEnv);
  assert.equal(result.movements.length, 100);
  assert.equal(new Set(result.movements.map((m) => m.txid)).size, 100);
  assert.ok(result.movements.every((m) => m.amount === 0.00000001 && m.date === "2026-09-10"));
  assertBTCPayReadOnly(calls);
  assert.deepEqual(calls.filter((c) => c.url.includes("/transactions?")).map((c) => c.url), [
    `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}/transactions?statusFilter=Confirmed&skip=0&limit=100`,
    `${btcpayEnv.BTCPAY_URL}${btcpayWalletPath}/transactions?statusFilter=Confirmed&skip=100&limit=100`,
  ]);
});

test("walletMovements: uncovered BTCPay history refuses before any HTTP", async () => {
  const { f, calls } = btcpayFetch();
  await assert.rejects(() => walletMovements([btcpayWallet], "2026-08-06", f, btcpayEnv), { message: btcHistoryCoverageError });
  assert.deepEqual(calls, []);
});

test("walletMovements: BTCPay history failure never falls back to Esplora or returns empty history", async () => {
  const { f, calls } = btcpayFetch((call) => call.url.includes("/transactions?") ? { status: 503, body: {} } : undefined);
  await assert.rejects(() => walletMovements([btcpayWallet], "2026-08-07", f, btcpayEnv));
  assertBTCPayReadOnly(calls);
  assert.ok(calls.some((c) => c.url.includes("/transactions?")));
  assert.ok(calls.every((c) => c.url.startsWith(`${btcpayEnv.BTCPAY_URL}/`)));
});

test("trackingBalances: BTCPay coverage refusal is an account error, not a balance or empty movements", async () => {
  const { f, calls } = btcpayFetch();
  let historyCalls = 0;
  const rows = await trackingBalances(
    [{ account: "BTC", wallets: [btcpayWallet] }],
    [{ id: "btc-account", name: "BTC", cleared_balance: 10_000, uncleared_balance: 0, deleted: false, closed: false }],
    {},
    {
      fetchWallets: (wallets) => walletBalances(wallets, f, btcpayEnv),
      fetchMovements: (wallets, since) => {
        historyCalls++;
        assert.equal(since, "2026-08-06");
        return walletMovements(wallets, since, f, btcpayEnv);
      },
    },
    { "btc-account": "2026-08-06" },
  );
  assert.equal(historyCalls, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.error, btcHistoryCoverageError);
  assert.equal(rows[0]!.sourceBalance, null);
  assert.equal(rows[0]!.difference, null);
  assert.equal(rows[0]!.movements, undefined);
  assert.equal(rows[0]!.wallets![0]!.via, "our BTCPay/NBXplorer (our bitcoind)");
  assertBTCPayReadOnly(calls);
  assert.ok(calls.some((c) => c.url.includes("/simple/price?")));
  assert.ok(!calls.some((c) => c.url.includes("/transactions?") || c.url === btcpayEnv.BITCOIN_RPC_URL));
});

test("btcMovements: nets a transaction across the wallet's addresses, since a date", async () => {
  const { btcMovements } = await import("./crypto.js");
  const day = (d: string) => Date.parse(d + "T12:00:00Z") / 1000;
  const a = "bc1qmine", other = "bc1qother";
  const { f } = jsonFetch((url) => {
    if (url.includes("/txs")) return { body: [
      // Sent 0.3 to someone, 0.19999 back as change, 1000 sats fee: net -0.30001
      { txid: "t3", status: { confirmed: true, block_time: day("2026-09-10") }, vin: [{ prevout: { scriptpubkey_address: a, value: 50_000_000 } }], vout: [{ scriptpubkey_address: other, value: 30_000_000 }, { scriptpubkey_address: a, value: 19_999_000 }] },
      { txid: "t2", status: { confirmed: true, block_time: day("2026-08-01") }, vin: [], vout: [{ scriptpubkey_address: a, value: 50_000_000 }] },
      { txid: "t1", status: { confirmed: false }, vin: [], vout: [{ scriptpubkey_address: a, value: 1 }] },
    ] };
    throw new Error(url);
  });
  assert.deepEqual(await btcMovements(a, "2026-08-07", f), [{ date: "2026-09-10", txid: "t3", sats: -30_001_000 }]);
});
