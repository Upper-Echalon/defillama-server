import BigNumber from "bignumber.js";
import { AllProtocols, TokenTvlData } from "./types";
import { canonicalBridgeIds, excludedTvlKeys, geckoSymbols, protocolBridgeIds, zero } from "./constants";
import fetch from "node-fetch";
import { bridgedTvlMixedCaseChains } from "../src/utils/shared/constants";
import sleep from "../src/utils/shared/sleep";
import * as sdk from '@defillama/sdk'
const { multiCall, call } = sdk.api2.abi
type Address = string;
import * as incomingAssets from "./adapters";
import { additional, excluded } from "./adapters/manual";
type Chain = string;
import PromisePool from "@supercharge/promise-pool";
import { Connection, PublicKey } from "@solana/web3.js";
const { getBlock, } = sdk.util.blocks
import fetchThirdPartyTokenList from "./adapters/thirdParty";
import { storeR2JSONString } from "../src/utils/r2";
const BufferLayout = require("buffer-layout");

const uint64 = (property = "uint64") => {
  const layout = BufferLayout.blob(8, property);

  const _decode = layout.decode.bind(layout);
  const _encode = layout.encode.bind(layout);

  layout.decode = (buffer: any, offset: any) => {
    const data = _decode(buffer, offset);
    return new BigNumber(
      [...data]
        .reverse()
        .map((i) => `00${i.toString(16)}`.slice(-2))
        .join(""),
      16
    );
  };

  layout.encode = (num: any, buffer: any, offset: any) => {
    const a = num.toArray().reverse();
    let b = Buffer.from(a);
    if (b.length !== 8) {
      const zeroPad = Buffer.alloc(8);
      b.copy(zeroPad);
      b = zeroPad;
    }
    return _encode(b, buffer, offset);
  };

  return layout;
};

const u64 = uint64

export async function aggregateChainTokenBalances(usdTokenBalances: AllProtocols): Promise<TokenTvlData> {
  const chainUsdTokenTvls: TokenTvlData = {};
  const dependancies: { [chain: string]: string[] } = {};

  Object.keys(usdTokenBalances).map((id: string) => {
    const bridge = usdTokenBalances[id];
    Object.keys(bridge).map((chain: string) => {
      if (canonicalBridgeIds[id] == chain) return;
      if (excludedTvlKeys.includes(chain)) return;

      const dependancy = canonicalBridgeIds[id] ?? protocolBridgeIds[id];

      if (dependancy) {
        if (!(dependancy in dependancies)) dependancies[dependancy] = [];
        dependancies[dependancy].push(chain);
      }

      if (!(chain in chainUsdTokenTvls)) chainUsdTokenTvls[chain] = {};
      Object.keys(bridge[chain]).map((rawSymbol: string) => {
        const symbol = geckoSymbols[rawSymbol.replace("coingecko:", "")] ?? rawSymbol.toUpperCase();
        if (!(symbol in chainUsdTokenTvls[chain])) chainUsdTokenTvls[chain][symbol] = zero;
        chainUsdTokenTvls[chain][symbol] = BigNumber(bridge[chain][rawSymbol]).plus(chainUsdTokenTvls[chain][symbol]);
      });
    });
  });

  await storeR2JSONString("L2-dependancies", JSON.stringify(dependancies));

  return chainUsdTokenTvls;
}
async function restCallWrapper(request: () => Promise<any>, retries: number = 8, name: string = "-") {
  while (retries > 0) {
    try {
      const res = await request();
      return res;
    } catch {
      await sleep(60000 + 40000 * Math.random());
      restCallWrapper(request, retries--, name);
    }
  }
  throw new Error(`couldnt work ${name} call after retries!`);
}
async function getOsmosisSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with Osmosis adapter!`);
  // Record real values including 0; failed fetches are absent from the map.
  const supplies: { [token: string]: number } = {};

  await PromisePool.withConcurrency(3)
    .for(tokens)
    .process(async (token) => {
      try {
        const res = await fetch(`https://lcd.osmosis.zone/cosmos/bank/v1beta1/supply/by_denom?denom=${token}`).then(
          (r) => r.json()
        );
        const amount = res?.amount?.amount;
        if (amount != null) supplies[`osmosis:${token}`] = Number(amount);
      } catch (e) {
        // silent — token will be absent from the result map
      }
    });

  return supplies;
}
async function getAptosSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with Aptos adapter!`);
  // Record real values including 0; failed/unrecognised tokens are absent.
  const supplies: { [token: string]: number } = {};
  const rpc = process.env.APTOS_RPC;

  await PromisePool.withConcurrency(1)
    .for(tokens)
    .process(async (token) => {
      try {
        const isCoinType = token.includes("::");
        if (isCoinType) {
          // Legacy Coin standard: fetch CoinInfo resource
          const accountAddr = token.substring(0, token.indexOf("::"));
          const res = await fetch(
            `${rpc}/v1/accounts/${accountAddr}/resource/0x1::coin::CoinInfo%3C${token}%3E`
          ).then((r) => r.json());
          const legacyValue = res?.data?.supply?.vec?.[0]?.integer?.vec?.[0]?.value;
          if (legacyValue != null) {
            supplies[`aptos:${token}`] = Number(legacyValue);
            return;
          }
          if (res?.data?.supply?.vec?.[0]?.aggregator?.vec?.[0]?.handle) {
            // Aggregator-based supply (e.g. native APT) — resolve via table item
            const { handle, key } = res.data.supply.vec[0].aggregator.vec[0];
            const aggRes = await fetch(`${rpc}/v1/tables/${handle}/item`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key_type: "address", value_type: "u128", key }),
            }).then((r) => r.json());
            if (typeof aggRes === "string" || typeof aggRes === "number") {
              supplies[`aptos:${token}`] = Number(aggRes);
              return;
            }
          }
        }

        // Fungible Asset standard: token is an object address (no "::")
        const objectAddr = isCoinType ? token.substring(0, token.indexOf("::")) : token;
        // Try ConcurrentSupply first (newer)
        const concurrentRes = await fetch(
          `${rpc}/v1/accounts/${objectAddr}/resource/0x1::fungible_asset::ConcurrentSupply`
        ).then((r) => r.json());
        if (concurrentRes?.data?.current?.value != null) {
          supplies[`aptos:${token}`] = Number(concurrentRes.data.current.value);
          return;
        }
        // Fall back to Supply resource
        const supplyRes = await fetch(
          `${rpc}/v1/accounts/${objectAddr}/resource/0x1::fungible_asset::Supply`
        ).then((r) => r.json());
        if (supplyRes?.data?.current != null) {
          supplies[`aptos:${token}`] = Number(supplyRes.data.current);
        }
      } catch (e) {
        // silent — token will be absent from the result map
      }
    });

  return supplies;
}

let connection: any = {};

const renecEndpoint = () => process.env.RENEC_RPC;
const eclipseEndpoint = () => process.env.ECLIPSE_RPC ?? "https://eclipse.helius-rpc.com";
const solEndpoint = (isClient: boolean) => {
  if (isClient) return process.env.SOLANA_RPC_CLIENT ?? process.env.SOLANA_RPC ?? "https://rpc.ankr.com/solana";
  return process.env.SOLANA_RPC;
};

export const endpointMap: any = {
  solana: solEndpoint,
  renec: renecEndpoint,
  eclipse: eclipseEndpoint,
};

function getConnection(chain = "solana") {
  if (!connection[chain]) connection[chain] = new Connection(endpointMap[chain](true));
  return connection[chain];
}

export async function runInChunks(inputs: any, fn: any, { chunkSize = 99, sleepTime }: any = {}) {
  const chunks = sliceIntoChunks(inputs, chunkSize);
  const results = [];
  for (const chunk of chunks) {
    results.push(...((await fn(chunk)) ?? []));
    if (sleepTime) await sleep(sleepTime);
  }

  return results.flat();

  function sliceIntoChunks(arr: any, chunkSize = 100) {
    const res = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
      const chunk = arr.slice(i, i + chunkSize);
      res.push(chunk);
    }
    return res;
  }
}

async function getSolanaTokenSupply(
  tokens: string[],
  chain: string,
  timestamp?: number
): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with ${chain} adapter!`);

  const solanaMintLayout = BufferLayout.struct([u64("supply")]);

  const sleepTime = tokens.length > 2000 ? 2000 : 200;
  const tokensPK: PublicKey[] = [];
  const filteredTokens: string[] = [];
  tokens.map((i) => {
    try {
      const key = new PublicKey(i);
      tokensPK.push(key);
      filteredTokens.push(i);
    } catch (e) {}
  });
  const connection = getConnection(chain);
  const res = await runInChunks(tokensPK, (chunk: any) => connection.getMultipleAccountsInfo(chunk), { sleepTime });
  // Record real values including 0; failed accounts are absent from the map.
  const supplies: { [token: string]: number } = {};

  res.forEach((data, idx) => {
    const key = `${chain}:` + filteredTokens[idx];
    if (!data) {
      sdk.log(`Invalid account: ${filteredTokens[idx]}`);
      return;
    }
    try {
      const buffer = data.data.slice(36, 44);
      const supply = solanaMintLayout.decode(buffer).supply.toString();
      supplies[key] = Number(supply);
    } catch (e) {
      sdk.log(`Error decoding account: ${filteredTokens[idx]}`);
    }
  });

  return supplies;
}
// Provenance is a Cosmos SDK chain. Its bank module honours the standard
// `x-cosmos-block-height` header, so historical state reads work the same way
// EVM archive reads do — resolve the block for a timestamp, then read at it.
// Override the endpoint with PROVENANCE_LCD (e.g. an archive node) if needed.
export const PROVENANCE_LCD = process.env.PROVENANCE_LCD ?? "https://api.provenance.io";

// Cosmos block timestamps carry nanosecond precision ("...868036860Z"); JS Date
// only wants milliseconds. Truncate the fractional part to 3 digits.
function provenanceTimeToSeconds(iso: string): number {
  return Math.floor(Date.parse(iso.replace(/(\.\d{3})\d+/, "$1")) / 1000);
}

const provenanceBlockTimeCache: Map<number, number | null> = new Map();
let provenanceLatestCache: { height: number; ts: number; fetchedAt: number } | undefined;

async function getProvenanceLatest(): Promise<{ height: number; ts: number } | null> {
  if (provenanceLatestCache && Date.now() - provenanceLatestCache.fetchedAt < 300_000) {
    return { height: provenanceLatestCache.height, ts: provenanceLatestCache.ts };
  }
  try {
    const res: any = await fetch(`${PROVENANCE_LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`).then((r) => r.json());
    const h = res?.block?.header;
    const height = Number(h?.height);
    const ts = h?.time ? provenanceTimeToSeconds(h.time) : NaN;
    if (!Number.isFinite(height) || !Number.isFinite(ts)) return null;
    provenanceLatestCache = { height, ts, fetchedAt: Date.now() };
    return { height, ts };
  } catch (e) {
    return null;
  }
}

async function getProvenanceBlockTime(height: number): Promise<number | null> {
  if (provenanceBlockTimeCache.has(height)) return provenanceBlockTimeCache.get(height) ?? null;
  const r = await fetch(`${PROVENANCE_LCD}/cosmos/base/tendermint/v1beta1/blocks/${height}`);
  if (r.status === 404) {
    provenanceBlockTimeCache.set(height, null);
    return null;
  }
  if (!r.ok) throw new Error(`Provenance block ${height} lookup failed: ${r.status}`);
  const res: any = await r.json();
  const t = res?.block?.header?.time;
  const secs = t ? provenanceTimeToSeconds(t) : null;
  provenanceBlockTimeCache.set(height, secs);
  return secs;
}

// Resolve the block height to read state at for a unix timestamp: the largest
// height whose block time <= timestamp (same at-or-before semantics as the EVM
// getBlock path). Returns null only when no block header is available at/before
// the timestamp. Caveat: the public node prunes app STATE more aggressively than
// block headers (~6 months of state), so a pre-retention timestamp can still
// resolve to a non-null height whose `by_denom` read then comes back empty —
// the caller drops that leg, same net result as an EVM archive node that can't
// reach the block. Results are cached so a multi-day refill doesn't re-walk the
// same blocks.
export async function getProvenanceHeightForTimestamp(timestamp: number): Promise<number | null> {
  const latest = await getProvenanceLatest();
  if (!latest) return null;
  if (timestamp >= latest.ts) return latest.height;

  let lo = 1, hi = latest.height, ans: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await getProvenanceBlockTime(mid);
    if (t == null) {
      // Pruned / missing block — older than the retained window. Search higher.
      lo = mid + 1;
      continue;
    }
    if (t <= timestamp) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  // ans == null means every retained block is newer than `timestamp`, i.e. the
  // timestamp is before the node's retention horizon → no readable history.
  return ans;
}

async function getProvenanceSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  // Record real values including 0; failed fetches are absent.
  const supplies: { [token: string]: number } = {};

  let headers: { [k: string]: string } | undefined;
  if (timestamp) {
    const height = await getProvenanceHeightForTimestamp(timestamp);
    // Before the retained window: drop the leg for this timestamp rather than
    // throwing, so refillParallel just skips Provenance where it can't read
    // history (mirrors the swallowed-catch behaviour of the other adapters).
    if (height == null) return supplies;
    headers = { "x-cosmos-block-height": String(height) };
  }

  await PromisePool.withConcurrency(3)
    .for(tokens)
    .process(async (token) => {
      try {
        const res = await fetch(
          `${PROVENANCE_LCD}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(token)}`,
          headers ? { headers } : undefined
        ).then((r) => r.json());
        const amount = res?.amount?.amount;
        if (amount != null) supplies[`provenance:${token}`] = Number(amount);
      } catch (e) {}
    });

  return supplies;
}

// Soroban SAC contract ID -> classic "code-issuer" mapping
const stellarSacToClassic: { [contractId: string]: string } = {
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75": "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV": "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
  "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK": "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
  "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY": "BLND-GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA": "XLM",
};

// Fetch total_supply() from a native Soroban token contract via rpc-proxy
async function getSorobanTokenSupply(contractId: string): Promise<number | null> {
  const res = await fetch(`${process.env.RPC_PROXY_URL}/stellar/total-supply/${contractId}`).then((r) => r.json());
  if (typeof res === "string" || typeof res === "number") return Number(res);
  if (res?.error) return null;
  return null;
}

function isSorobanContractId(token: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(token) && !(token in stellarSacToClassic);
}

async function getStellarSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with Stellar adapter!`);
  // Record real values including 0; failed fetches are absent.
  const supplies: { [token: string]: number } = {};

  await PromisePool.withConcurrency(3)
    .for(tokens)
    .process(async (token) => {
      try {
        // Native Soroban contracts: call total_supply() via RPC
        if (isSorobanContractId(token)) {
          const supply = await getSorobanTokenSupply(token);
          if (supply != null) supplies[`stellar:${token}`] = Number(supply);
          return;
        }

        // Resolve Soroban SAC contract IDs to classic "code-issuer" format
        const classicKey = stellarSacToClassic[token] ?? token;
        if (classicKey === "XLM") return; // native asset handled by ownTokens

        // Token format: "{asset_code}-{asset_issuer}" (dash-separated)
        const dashIdx = classicKey.lastIndexOf("-");
        if (dashIdx === -1) return;
        const asset_code = classicKey.substring(0, dashIdx);
        const asset_issuer = classicKey.substring(dashIdx + 1);
        const res = await fetch(
          `https://horizon.stellar.org/assets?asset_code=${asset_code}&asset_issuer=${asset_issuer}&limit=1`
        ).then((r) => r.json());
        const record = res?._embedded?.records?.[0];
        if (record?.balances?.authorized != null) {
          supplies[`stellar:${token}`] = Math.round(parseFloat(record.balances.authorized) * 1e7);
        }
      } catch (e) {}
    });

  return supplies;
}

async function getStarknetSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with Starknet adapter!`);
  // Record real values including 0; failed fetches are absent.
  const supplies: { [token: string]: number } = {};
  const STARKNET_RPC = process.env.STARKNET_RPC ?? "https://starknet-mainnet.public.blastapi.io";
  const TOTAL_SUPPLY_SELECTOR = "0x1557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836";

  await PromisePool.withConcurrency(5)
    .for(tokens)
    .process(async (token) => {
      try {
        const res = await fetch(STARKNET_RPC, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "starknet_call",
            params: [
              {
                contract_address: token,
                entry_point_selector: TOTAL_SUPPLY_SELECTOR,
                calldata: [],
              },
              "latest",
            ],
          }),
          headers: { "Content-Type": "application/json" },
        }).then((r) => r.json());
        if (res?.result && res.result.length >= 2) {
          const low = new BigNumber(res.result[0]);
          const high = new BigNumber(res.result[1]);
          const supply = low.plus(high.times(new BigNumber(2).pow(128)));
          supplies[`starknet:${token}`] = supply.toNumber();
        }
      } catch (e) {}
    });

  return supplies;
}

async function getSuiSupplies(tokens: Address[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with Sui adapter!`);
  // Record real values including 0; failed fetches are absent.
  const supplies: { [token: string]: number } = {};

  await PromisePool.withConcurrency(5)
    .for(tokens)
    .process(async (token) => {
      try {
        const res = await fetch("https://fullnode.mainnet.sui.io/", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "suix_getTotalSupply",
            params: [token],
          }),
          headers: { "Content-Type": "application/json" },
        }).then((r) => r.json());
        const value = res?.result?.value;
        if (value != null) supplies[`sui:${token}`] = Number(value);
      } catch (e) {}
    });

  return supplies;
}
// XRPL issued-token supply via the `gateway_balances` JSON-RPC method. The
// public XRPL cluster has no by-timestamp archive query, so this is
// current-only (matches the other non-EVM adapters that throw on historical).
//
// Token key formats (the `ripple:` chain prefix is already stripped by
// getTotalSupplies before this is called):
//   "<CURRENCY>.<rISSUER>"  e.g. "DIA-SD-COL1.rDgoZHy4SLPs4jhJZqkyaXX4iEsEUkCAVp"
//   "<rISSUER>"             issuer-only → sum ALL of that issuer's obligations
//                           (e.g. GDCP's dated GDCPyyyymmdd currency series)
//
// `obligations` = tokens the issuer owes to non-hot-wallet holders = circulating
// supply. Keys are a 3-char ASCII currency code, or a 40-char hex blob for
// non-standard (>3 char) codes; we decode the hex back to ASCII to match the
// human-readable currency embedded in the token key.
//
// ⚠️ The returned value is the raw issued amount. XRPL IOUs are arbitrary-
// precision decimals with no on-chain `decimals` field, so the coins price entry
// for `ripple:<token>` MUST be created with decimals=0 — then atvlRefill's
// `supply / 10**decimals` recovers the token count. Without a coins price entry
// the supply is inert (atvlRefill only iterates priced tokens).
// ⚠️ "ripple" is in bridgedTvlMixedCaseChains — XRPL addresses/currency codes
// are case-sensitive and would otherwise be lowercased before reaching here.
const XRPL_RPC = process.env.XRPL_RPC ?? "https://xrplcluster.com/";

function decodeXrplCurrency(code: string): string {
  if (code.length === 3) return code; // standard ASCII currency code
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    const buf = Buffer.from(code, "hex");
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--; // strip trailing null padding
    return buf.slice(0, end).toString("ascii");
  }
  return code;
}

async function fetchXrplObligations(issuer: string): Promise<{ [currency: string]: string } | null> {
  const res: any = await fetch(XRPL_RPC, {
    method: "POST",
    body: JSON.stringify({
      method: "gateway_balances",
      params: [{ account: issuer, ledger_index: "validated", strict: true }],
    }),
    headers: { "Content-Type": "application/json" },
  }).then((r) => r.json());
  const result = res?.result;
  if (!result || result.status === "error") return null;
  return result.obligations ?? {};
}

async function getXrplSupplies(tokens: string[], timestamp?: number): Promise<{ [token: string]: number }> {
  if (timestamp) throw new Error(`timestamp incompatible with XRPL adapter!`);
  // Record real values including 0; failed fetches are absent.
  const supplies: { [token: string]: number } = {};

  // Group by issuer so we hit gateway_balances once per issuer (the 4 Ctrl Alt
  // diamond currencies share one issuer; GDCP is a lone issuer-only token).
  const byIssuer: { [issuer: string]: string[] } = {};
  for (const token of tokens) {
    const dotIdx = token.indexOf(".");
    const issuer = dotIdx === -1 ? token : token.substring(dotIdx + 1);
    (byIssuer[issuer] ??= []).push(token);
  }

  await PromisePool.withConcurrency(3)
    .for(Object.keys(byIssuer))
    .process(async (issuer) => {
      try {
        const obligations = await fetchXrplObligations(issuer);
        if (!obligations) return;

        // Decode each obligation currency once; total across all for issuer-only tokens.
        const byCurrency: { [human: string]: number } = {};
        let total = 0;
        for (const [code, amount] of Object.entries(obligations)) {
          const v = Number(amount);
          if (!Number.isFinite(v)) continue;
          byCurrency[decodeXrplCurrency(code)] = (byCurrency[decodeXrplCurrency(code)] ?? 0) + v;
          total += v;
        }

        for (const token of byIssuer[issuer]) {
          const dotIdx = token.indexOf(".");
          if (dotIdx === -1) {
            supplies[`ripple:${token}`] = Math.round(total);
          } else {
            const currency = token.substring(0, dotIdx);
            const v = byCurrency[currency];
            if (v != null) supplies[`ripple:${token}`] = Math.round(v);
          }
        }
      } catch (e) {}
    });

  return supplies;
}

// Cache eth_getCode per (chain, address, block) so the RWA `dropNonContracts` filter below
// costs at most one lookup per address per block, even when many assets re-read the same
// chain/day. On RPC error we return "ERR" (≠ "0x") and DON'T cache it, so a transient failure
// never causes a real token to be dropped and can be retried later.
const _evmCodeCache: { [key: string]: string } = {};
async function getCodeCached(chain: Chain, address: Address, block: number | undefined): Promise<string> {
  const key = `${chain}:${address.toLowerCase()}:${block ?? "latest"}`;
  if (_evmCodeCache[key] !== undefined) return _evmCodeCache[key];
  try {
    const provider: any = (sdk as any).getProvider(chain);
    const code: string = await provider.getCode(address, block);
    _evmCodeCache[key] = code;
    return code;
  } catch (e) {
    return "ERR";
  }
}

async function getEVMSupplies(
  chain: Chain,
  contracts: Address[],
  timestamp?: number,
  dropNonContracts = false
): Promise<{ [token: string]: number }> {
  const step: number = 200;
  // Record every value the multicall returned, including a real `0`. Failed
  // calls are absent from the result; consumers should treat missing keys as
  // "no data" (e.g. `supply == null` covers both undefined and null).
  const supplies: { [token: string]: number } = {};
  const block: any = timestamp ? await getBlock(chain, timestamp) : undefined;

  // A non-contract address returns a *successful* empty `0x` for `totalSupply()`, which
  // `permitFailure` (reverts only) does not drop. In a batched aggregate3 read that empty
  // return misaligns the decode and scrambles the OTHER tokens in the same chunk (Ink xStock
  // batch, 2026-06-11: a non-contract USDC address garbled 160+ legs to junk — RIOTx 646,412
  // -> 39, KRAQx -> 0, Brera -> empty). Opt-in (RWA only) so the shared L2/bridge-TVL callers,
  // which don't hit this, don't pay the extra getCode round-trip.
  if (dropNonContracts && contracts.length) {
    try {
      // Rate-limit the getCode probes (matches the other adapters in this file) so a large token
      // list can't fire 100+ concurrent eth_getCode RPCs at once. Caching makes repeats free.
      const codes: string[] = new Array(contracts.length);
      await PromisePool.withConcurrency(3)
        .for(contracts.map((c: Address, i: number) => ({ c, i })))
        .process(async ({ c, i }: { c: Address; i: number }) => {
          codes[i] = await getCodeCached(chain, c, block?.block);
        });
      // Drop ONLY addresses confirmed to have no code ("0x"); keep real contracts (a reverting
      // totalSupply is already handled by permitFailure) and any address whose getCode errored.
      const kept = contracts.filter((_: Address, i: number) => codes[i] !== "0x");
      if (kept.length < contracts.length)
        console.log(
          `[getEVMSupplies] ${chain}: dropped ${contracts.length - kept.length}/${contracts.length} non-contract address(es) before supply read`
        );
      contracts = kept;
    } catch (e) {
      if (process.env.DEBUG_ENABLED) console.error(`[getEVMSupplies] getCode filter failed for ${chain}: ${e}`);
    }
  }

  for (let i = 0; i < contracts.length; i += step) {
    try {
      const res = await multiCall({
        chain,
        calls: contracts.slice(i, i + step).map((target: string) => ({
          target,
        })),
        abi: "erc20:totalSupply",
        permitFailure: true,
        block: block?.block,
      });
      contracts.slice(i, i + step).map((c: Address, i: number) => {
        const key = `${chain}:${bridgedTvlMixedCaseChains.includes(chain) ? c : c.toLowerCase()}`;
        if (res[i] != null) supplies[key] = res[i];
      });
    } catch (e) {
      try {
        process.env.TRON_RPC = process.env.TRON_RPC?.substring(process.env.TRON_RPC.indexOf(",") + 1);
        await PromisePool.withConcurrency(5)
          .for(contracts.slice(i, i + step))
          .process(async (target) => {
            const res = await call({
              chain,
              target,
              abi: "erc20:totalSupply",
              block,
            }).catch(async (e) => {
              await sleep(1000);
              if (chain == "tron") console.log(`${target}:: \t ${e.message}`);
            });
            if (res != null)
              supplies[`${chain}:${bridgedTvlMixedCaseChains.includes(chain) ? target : target.toLowerCase()}`] = res;
          });
      } catch (e) {
        if (chain == "tron") console.log(`tron supply call failed`);
      }
    }
  }

  return supplies;
}

export async function fetchSupplies(
  chain: Chain,
  tokens: Address[],
  timestamp: number | undefined,
  dropNonContracts = false
): Promise<{ [token: string]: number }> {
  try {
    if (chain == "osmosis") return await getOsmosisSupplies(tokens, timestamp);
    if (chain == "aptos") return await getAptosSupplies(tokens, timestamp);
    if (Object.keys(endpointMap).includes(chain)) return await getSolanaTokenSupply(tokens, chain, timestamp);
    if (chain == "sui") return await getSuiSupplies(tokens, timestamp);
    if (chain == "provenance") return await getProvenanceSupplies(tokens, timestamp);
    if (chain == "stellar") return await getStellarSupplies(tokens, timestamp);
    if (chain == "starknet") return await getStarknetSupplies(tokens, timestamp);
    if (chain == "ripple") return await getXrplSupplies(tokens, timestamp);
    return await getEVMSupplies(chain, tokens, timestamp, dropNonContracts);
  } catch (e) {
    throw new Error(`multicalling token supplies failed for chain ${chain} with ${e}`);
  }
}
export async function fetchBridgeTokenList(chain: Chain): Promise<Address[]> {
  try {
    const tokens: Address[] = incomingAssets[chain as keyof typeof incomingAssets] ? await incomingAssets[chain as keyof typeof incomingAssets]() : []
    tokens.push(...((await fetchThirdPartyTokenList())[chain] ?? []));
    let filteredTokens: Address[] =
      chain in excluded ? tokens.filter((t: string) => !excluded[chain].includes(t)) : tokens;
    if (!bridgedTvlMixedCaseChains.includes(chain)) filteredTokens = filteredTokens.map((t: string) => t.toLowerCase());

    if (!(chain in additional)) return dropInvalidAddresses(filteredTokens);

    const additionalTokens = bridgedTvlMixedCaseChains.includes(chain)
      ? additional[chain]
      : additional[chain].map((t: string) => t.toLowerCase());

    return dropInvalidAddresses([...new Set([...filteredTokens, ...additionalTokens])]);
  } catch (e) {
    throw new Error(`${chain} bridge adapter failed with ${e}`);
  }
}

function dropInvalidAddresses(tokens: Address[]): Address[] {
  return tokens.filter(
    (t: unknown): t is string => typeof t === "string" && t.length > 0 && t !== "null" && t !== "undefined"
  );
}

const letterToSeconds: { [symbol: string]: number } = {
  w: 604800,
  d: 86400,
  h: 3600,
  m: 60,
};
export function quantisePeriod(period: string): number {
  let normalizedPeriod: number;
  const normalized = Object.keys(letterToSeconds)
    .map((s: string) => {
      if (!period.includes(s)) return;
      const numberPeriod = period.replace(new RegExp(`[${s}]`, "i"), "");
      normalizedPeriod = Number(numberPeriod == "" ? 1 : numberPeriod);
      return normalizedPeriod * letterToSeconds[s];
    })
    .find((t: any) => t != null);
  if (normalized == null) return Number(period);
  return normalized;
}
export function sortBySize() {
  const coins: { [value: string]: string } = {};

  const res = Object.entries(coins).sort(([_A, valueA], [_B, valueB]) => {
    [_A, _B];
    return Number(valueB) - Number(valueA);
  });
  console.log(res.slice(0, 10));
}
// sortBySize(); // ts-node defi/l2/utils.ts
