import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";

// Metronome *Synth* tokens — synthetic debt assets valued by Metronome's
// MasterOracle in USD. price = oracle.getPriceInUsd(synth) / 1e18 (the value
// Metronome's own fee/revenue/interest accounting uses).
//
// SCOPE: only the synths NOT already on CoinGecko. msUSD + msETH are listed on
// CG (metronome-synth-usd / -eth, conf 0.99) and intentionally left to it — do
// NOT add them here unless you also bump confidence >=0.99 and clear the CG
// redirect, or this adapter is silently shadowed. msBTC / msOP / msDOGE have no
// CG listing, so this adapter is their sole price source.
//
// NOTE: distinct from the `metronome` adapter, which prices Metronome
// deposit/vault tokens via pricePerShare/quoteWithdrawIn.
//
// Oracle is resolved per-timestamp via the (stable) PoolRegistry so historical
// oracle upgrades are captured: synth -> registry.masterOracle() -> getPriceInUsd.
export const synthConfig: { [chain: string]: { registry: string; synths: string[] } } = {
  ethereum: {
    registry: "0x11eaD85C679eAF528c9C1FE094bF538Db880048A",
    synths: [
      "0x8b4F8aD3801B4015Dea6DA1D36f063Cbf4e231c7", // msBTC  (active 2023-02 -> now)
      "0x7cebe35b46b8078e7ffbf754eec4a48653c47524", // msDOGE (active 2023-02 -> 2024-03; oracle reverts after, permitFailure skips)
    ],
  },
  optimism: {
    registry: "0xe7C65eAEb1Ca920f0DB73cDFb4915Dd31472a6a1",
    synths: [
      "0x33bCa143d9b41322479E8d26072a00a352404721", // msOP (active 2023-06 -> now)
    ],
  },
};

async function getChainPrices(chain: string, timestamp: number) {
  const { registry, synths } = synthConfig[chain];
  const api = await getApi(chain, timestamp);

  const oracle = await api.call({
    target: registry,
    abi: "address:masterOracle",
    permitFailure: true,
  });
  if (!oracle) return [];

  const prices = await api.multiCall({
    target: oracle,
    abi: "function getPriceInUsd(address) view returns (uint256)",
    calls: synths.map((synth) => ({ params: synth })),
    permitFailure: true, // deprecated / not-yet-listed synths revert — skip them
  });

  const pricesObject: any = {};
  synths.forEach((synth, i) => {
    const raw = prices[i];
    if (raw == null) return;
    const price = Number(raw) / 1e18;
    if (!price || !isFinite(price)) return;
    pricesObject[synth] = { price };
  });

  return getWrites({
    chain,
    timestamp,
    pricesObject,
    projectName: "metronome-synth",
  });
}

export function metronomeSynth(timestamp: number = 0) {
  return Promise.all(
    Object.keys(synthConfig).map((chain) =>
      // Isolate per-chain failures: at early-history timestamps a chain may not
      // exist yet (e.g. Base pre-launch), and getApi throws on block resolution.
      // Don't let that drop the other chains' prices for the same timestamp.
      getChainPrices(chain, timestamp).catch((e) => {
        console.error(
          `metronome-synth ${chain} failed @ ${timestamp}: ${e?.message ?? e}`,
        );
        return [];
      }),
    ),
  );
}
