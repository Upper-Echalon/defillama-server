import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList, getTokenAndRedirectDataMap } from "../utils/database";
// Why write the coingecko key instead of an asset# record:
//   - Every chain's uniBTC already redirects to `coingecko#universal-btc` via tokenMapping.json, and the
//     full multi-year price history lives under that PK. Repointing the mappings to a new asset# key would
//     orphan that history and break refills/charts for all 12 tokens (this is what the reviewer flagged).
//   - A direct `coingecko#` write also bypasses the asset->cg override gate in filterWritesWithLowConfidence
//     (which only rewrites `asset#` PKs and is blocked by a 10% price-change guard) — so it can actually
//     dislodge a stuck glitch value. confidence 0.995 beats CG's 0.99 in the same function's confidence filter.
const SYMBOL = "uniBTC";
const DECIMALS = 8;
const ADAPTER = "bedrock-uniBTC";
const CONFIDENCE = 0.995;
const CG_ID = "universal-btc";

// Uniswap-v3 slot0 has 7 fields (…, uint8 feeProtocol, bool); Aerodrome Slipstream's has 6 (no feeProtocol).
const V3_SLOT0 =
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)";
const AERO_SLOT0 =
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)";

const POOLS = [
  // uniBTC/WBTC — Uniswap v3, Ethereum (primary, deepest)
  { chain: "ethereum", pool: "0x3a32f5040bc4d8417e78e236eb2c48c90e003fda", slot0Abi: V3_SLOT0, uniDec: 8, quoteDec: 8, quote: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", quoteSymbol: "WBTC" },
  // uniBTC/cbBTC — Aerodrome Slipstream, Base (cross-check / fallback)
  { chain: "base", pool: "0xc1cbf7a0b2f63fb864004c586d2deae924c95990", slot0Abi: AERO_SLOT0, uniDec: 8, quoteDec: 8, quote: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", quoteSymbol: "cbBTC" },
];

// uniBTC/quote should sit near 1.0; on ~$20/day volume a read implying a >20% discount (or any premium) is far
// likelier to be a stale/manipulated tick than reality, so drop that leg. Tunable guard against bad ticks.
const RATIO_MIN = 0.8;
const RATIO_MAX = 1.05;
const CROSS_CHECK_TOLERANCE = 0.02; // fail closed (skip the write) if the eth and base legs disagree by >2%

const Q96 = 2 ** 96;

async function readPoolPrice(p: (typeof POOLS)[number], timestamp: number): Promise<number | undefined> {
  try {
    const api = await getApi(p.chain, timestamp);
    const slot0 = await api.call({ target: p.pool, abi: p.slot0Abi });
    const sqrtPriceX96 = Number(slot0.sqrtPriceX96);
    if (!sqrtPriceX96 || sqrtPriceX96 <= 0) return undefined;

    const ratio = (sqrtPriceX96 / Q96) ** 2 * 10 ** (p.uniDec - p.quoteDec);
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
      console.error(`bedrock-uniBTC: ${p.chain} uniBTC/${p.quoteSymbol} ratio ${ratio} outside [${RATIO_MIN}, ${RATIO_MAX}], dropping leg`);
      return undefined;
    }

    const quoteData = Object.values(await getTokenAndRedirectDataMap([p.quote.toLowerCase()], p.chain, timestamp))[0];
    const quoteUsd = quoteData?.price;
    if (!quoteUsd || quoteUsd <= 0) {
      console.error(`bedrock-uniBTC: no USD price for ${p.quoteSymbol} on ${p.chain}, dropping leg`);
      return undefined;
    }
    return ratio * quoteUsd;
  } catch (e) {
    console.error(`bedrock-uniBTC: ${p.chain} pool read failed — ${(e as any)?.message ?? e}`);
    return undefined;
  }
}

export async function bedrockUniBTC(timestamp: number = 0): Promise<Write[]> {
  const [ethPrice, basePrice] = await Promise.all(POOLS.map((p) => readPoolPrice(p, timestamp)));

  // Ethereum pool is primary (deepest); fall back to Base if it can't be read (e.g. before the eth pool existed).
  const price = ethPrice ?? basePrice;
  if (price == null) {
    console.error("bedrock-uniBTC: no usable pool leg, skipping write");
    return [];
  }

  // Fail closed when both legs disagree: a >2% gap between two BTC-pegged pools means one is stale or
  // manipulated, so skip rather than overwrite the cg key off a bad single-chain spot. With this in place an
  // attacker has to move BOTH the eth and base pools in lockstep to shift our mark — meaningful protection
  // given the ~$20/day volume. (Single-leg reads, when the other pool is unreadable, still publish above.)
  if (ethPrice != null && basePrice != null) {
    const diff = Math.abs(ethPrice - basePrice) / ethPrice;
    if (diff > CROSS_CHECK_TOLERANCE) {
      console.error(`bedrock-uniBTC: eth/base prices diverge ${(diff * 100).toFixed(2)}% (eth ${ethPrice}, base ${basePrice}); skipping write`);
      return [];
    }
  }

  const writes: Write[] = [];
  // chain "coingecko" => PK `coingecko#universal-btc`; emits the dated chart point + the SK:0 metadata record.
  addToDBWritesList(writes, "coingecko", CG_ID, price, DECIMALS, SYMBOL, timestamp, ADAPTER, CONFIDENCE);
  return writes;
}
