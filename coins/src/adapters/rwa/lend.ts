import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import { getApi } from "../utils/sdk";
import { checkOracleFresh } from "../utils/oracle";

/*
 * lend.xyz tokenized real-estate operations ("opLEND-*").
 *
 * Each operation is EUR-denominated (French regulatory framework): a token is a par
 * principal claim worth 1 EUR (the oracle reports priceEur = 1.000000 for every op),
 * and the 9-12.5% APR yield is distributed separately as USDC, so the token does not
 * accrete. Lend runs an on-chain PriceOracle (Ethereum) that stores each op's EUR NAV
 * (publishNewRound, every few weeks) and exposes priceUsd = priceEur * Chainlink EUR/USD
 * recomputed live on read. We read priceUsd directly — it is the canonical, issuer-owned
 * price (6 decimals).
 *
 * opLEND tokens are LayerZero OFTs registered on several chains; the oracle prices each
 * op per (chainId, address) and every chain shares the same USD price, so we read the
 * price once on the Ethereum canonical token and redirect the other chains to it (same
 * shape as safo.ts). Addresses recovered from the oracle's registerOpLendAddresses calls.
 */
const ORACLE = "0xf67800302318D0B4f34dCAE98F3aAb129D76856C"; // Lend PriceOracle (Ethereum)
const ETH_CHAIN_ID = 1;
const ORACLE_PRICE_DECIMALS = 6; // priceUsd/priceEur are 6-decimal

// The Chainlink EUR/USD feed (Ethereum, 8 decimals) the oracle derives priceUsd from.
const EUR_USD_FEED = "0xb49f677943BC038e9857d61E7d053CaA2C1734C1";

const getLastRoundAbi =
  "function getLastRound(uint256 chainId, address opLend) view returns (uint256 lastRound, uint256 opId, uint256 priceEur, uint256 priceUsd)";
const latestRoundDataAbi =
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)";

// EUR/USD idles outside forex market hours (weekends + holidays). 96h tolerates a normal
// weekend and a holiday-extended one; 72h would trip on Good Friday/Easter/Christmas. We
// guard on the FEED's updatedAt, NOT the oracle's lastRound — lastRound is the NAV publish
// time (refreshed only every few weeks), while priceUsd tracks EUR/USD live. Soft-skip so a
// closed market keeps the last good price rather than dropping it. See oracle.ts / safo.ts.
const FX_MAX_AGE_SECONDS = 4 * 24 * 60 * 60;

type Op = {
  opId: number;
  fallbackSymbol: string;
  ethereum: string;
  others: { chain: string; address: string }[];
};

// chainIds in the registration -> DefiLlama chain names:
// 42161 arbitrum, 8453 base, 56 bsc, 137 polygon, 146 sonic, 59144 linea, 98866 plume_mainnet.
const ops: Op[] = [
  {
    opId: 1,
    fallbackSymbol: "opLEND-1", // Datacenter Facility (Saint-Herblain)
    ethereum: "0x8733D688eDc07A036C1457fDe2d1C7f8351AAF91",
    others: [
      { chain: "arbitrum", address: "0x678B42A61223bAe39b531B3f61d54b7Ecbd4Ab45" },
      { chain: "base", address: "0xffE1278BA1a6770c8513f296FfD0541EdC5f38C2" },
      { chain: "bsc", address: "0x3A83b051EB73651ad2D91F311262e22347D3fB26" },
      { chain: "polygon", address: "0xAC3FC66A4BfA086B9f888cDb6e5f46bA7459E517" },
      { chain: "sonic", address: "0xa0Dc88318eCa43cc2a0c3c2f46a8FF7860fC8D4c" },
      { chain: "plume_mainnet", address: "0xAC3FC66A4BfA086B9f888cDb6e5f46bA7459E517" },
      { chain: "linea", address: "0x3A83b051EB73651ad2D91F311262e22347D3fB26" },
    ],
  },
  {
    opId: 2,
    fallbackSymbol: "opLEND-2",
    ethereum: "0x35Aa0e6b72a57965EEF2Dde4025f2bC73FD3d6bE",
    others: [
      { chain: "arbitrum", address: "0xAc57590a40995E1A19C20a43D15C9E4dEe026C88" },
      { chain: "base", address: "0x8d06D78bd5eC97104cE3c7F10A73516fE1Ab4525" },
      { chain: "bsc", address: "0x8D8C97db218999Abb4404633b3ef571C8AB6FBAE" },
      { chain: "linea", address: "0xa0E66c1E35208F3ae8E761ED6664f4C946464Ffa" },
      { chain: "polygon", address: "0x1D46f61a04eB3fEc5A9B9A8afaB01fF52e6dDbB6" },
      { chain: "sonic", address: "0xf7Ba2d7a911300Bcc1057aB22A44ca2237fF34ad" },
    ],
  },
  {
    opId: 3,
    fallbackSymbol: "opLEND-3",
    ethereum: "0x030d3b11D0264cA487587A6f798057eE0832b420",
    others: [], // only Ethereum registered so far
  },
];

export async function lend(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const api = await getApi("ethereum", timestamp);

  // Freshness guard on the live FX component (see FX_MAX_AGE_SECONDS).
  const fx = await api.call({ abi: latestRoundDataAbi, target: EUR_USD_FEED });
  if (
    !checkOracleFresh(fx.updatedAt, {
      timestamp,
      label: "EUR/USD",
      maxAgeSeconds: FX_MAX_AGE_SECONDS,
      throwIfStale: false,
    })
  ) {
    console.error("lend: EUR/USD feed stale (>96h), skipping opLEND writes this tick");
    return writes; // keep the last good price rather than store a stale one
  }

  const ethAddrs = ops.map((o) => o.ethereum);
  const [rounds, decimalsArr, symbols] = await Promise.all([
    Promise.all(
      ops.map((o) =>
        api
          .call({ abi: getLastRoundAbi, target: ORACLE, params: [ETH_CHAIN_ID, o.ethereum] })
          .catch(() => null),
      ),
    ),
    api.multiCall({ abi: "uint8:decimals", calls: ethAddrs, permitFailure: true }),
    api.multiCall({ abi: "string:symbol", calls: ethAddrs, permitFailure: true }),
  ]);

  ops.forEach((op, i) => {
    const round = rounds[i];
    if (!round) return;
    const priceUsd = Number(round.priceUsd);
    if (!(priceUsd > 0)) return; // op not registered / never published

    const price = priceUsd / 10 ** ORACLE_PRICE_DECIMALS;
    // decimals() read permits failure; don't guess a default — a wrong decimals
    // value persists as SK=0 metadata and mis-scales amounts downstream. Skip
    // this op (and its redirects) for the tick rather than write bad metadata.
    if (decimalsArr[i] == null) return;
    const decimals = Number(decimalsArr[i]);
    if (!Number.isFinite(decimals)) return;
    const symbol = symbols[i] ?? op.fallbackSymbol;
    const canonical = `asset#ethereum:${op.ethereum.toLowerCase()}`;

    addToDBWritesList(writes, "ethereum", op.ethereum, price, decimals, symbol, timestamp, "lend-rwa", 0.9);
    for (const d of op.others) {
      // Same op, same USD price on every chain -> redirect to the Ethereum canonical.
      addToDBWritesList(writes, d.chain, d.address, undefined, decimals, symbol, timestamp, "lend-rwa", 0.9, canonical);
    }
  });

  return writes;
}
