import { computeFlowSeries, FlowRow } from "./db";

// Locks in the net-flow methodology: flows are $-denominated (supplyΔ × price,
// price = mcap/supply) and UNPRICED chains (no mcap) are excluded entirely, so
// the flow series stays consistent with onChainMcap.
describe("computeFlowSeries", () => {
  it("first row has null flow", () => {
    const rows: FlowRow[] = [{ timestamp: 1, mcap: { ethereum: 100 }, totalsupply: { ethereum: 100 } }];
    expect(computeFlowSeries(rows)[0]).toEqual({ timestamp: 1, netFlowUsd: null, netFlowByChain: {} });
  });

  it("values a priced chain in USD (supplyΔ × price), not tokens", () => {
    // price = mcap/supply = 220/110 = 2; supplyΔ = 10 tokens => $20, not 10
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 200 }, totalsupply: { ethereum: 100 } },
      { timestamp: 2, mcap: { ethereum: 220 }, totalsupply: { ethereum: 110 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(20, 6);
    expect(out[1].netFlowByChain.ethereum).toBeCloseTo(20, 6);
  });

  it("excludes an unpriced chain (supply present, no mcap) from the flow", () => {
    // ethereum priced ($1, +10 => +$10); solana has supply but NO mcap => excluded
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 100 }, totalsupply: { ethereum: 100, solana: 50 } },
      { timestamp: 2, mcap: { ethereum: 110 }, totalsupply: { ethereum: 110, solana: 80 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(10, 6);          // solana's +30 tokens NOT counted
    expect(out[1].netFlowByChain.solana).toBeUndefined();
    expect(out[1].netFlowByChain.ethereum).toBeCloseTo(10, 6);
    // unpriced-but-present chain is not a supply "gap", so not flagged missing
    expect(out[1].missingChains ?? []).not.toContain("solana");
  });

  it("a day with only unpriced chains is a gap (null), not a fake $0", () => {
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: {}, totalsupply: { solana: 50 } },
      { timestamp: 2, mcap: {}, totalsupply: { solana: 80 } },
    ];
    expect(computeFlowSeries(rows)[1].netFlowUsd).toBeNull();
  });

  it("a chain missing supply on either side is flagged missing, not valued", () => {
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 100, base: 5 }, totalsupply: { ethereum: 100 } }, // base supply missing
      { timestamp: 2, mcap: { ethereum: 110, base: 5 }, totalsupply: { ethereum: 110, base: 5 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(10, 6);          // only ethereum valued
    expect(out[1].missingChains).toContain("base");
  });

  // --- bad-supply-read guard (implied price = mcap/supply jumps wildly) ---
  it("skips a supply read that collapses to dust (implied price explodes) — rUSDY/USDY case", () => {
    // supply 1.36B -> 12.77M while mcap holds 1.35B => implied price $1 -> $106.
    // Without the guard this is a ~-142B fake flow; with it, excluded.
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 1.355e9 }, totalsupply: { ethereum: 1.356e9 } },
      { timestamp: 2, mcap: { ethereum: 1.354e9 }, totalsupply: { ethereum: 12.77e6 } },
    ];
    expect(computeFlowSeries(rows)[1].netFlowUsd).toBeNull(); // only chain skipped -> gap, not -142B
  });

  it("skips a supply read that over-reads then corrects (PROSPER case)", () => {
    // supply 47.3M -> 947K, mcap flat ~906K => implied price $0.019 -> $0.957 (50x).
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { bsc: 912_000 }, totalsupply: { bsc: 47.31e6 } },
      { timestamp: 2, mcap: { bsc: 906_300 }, totalsupply: { bsc: 947_200 } },
    ];
    expect(computeFlowSeries(rows)[1].netFlowUsd).toBeNull();
  });

  it("does NOT skip a real redemption (supply AND mcap move together, price stable)", () => {
    // 30% of supply redeemed at ~$1: supply 100M->70M, mcap 100M->70M. price stays $1.
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 100e6 }, totalsupply: { ethereum: 100e6 } },
      { timestamp: 2, mcap: { ethereum: 70e6 }, totalsupply: { ethereum: 70e6 } },
    ];
    expect(computeFlowSeries(rows)[1].netFlowUsd).toBeCloseTo(-30e6, 0); // real $30M outflow preserved
  });
});
