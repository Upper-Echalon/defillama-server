import { getChainDefaultChartData, processProtocols } from "./storeGetCharts";
import protocols, { Protocol, _InternalProtocolMetadataMap } from "./protocols/data";

describe("getChainDefaultChartData", () => {
  it("does not emit negative chain TVL from rounded excluded sections", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1272372]],
      liquidstaking: [["1778284800", 1027410]],
      doublecounted: [["1778284800", 244963]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 0 }]);
  });

  it("keeps positive chain TVL after exclusions", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1272380]],
      liquidstaking: [["1778284800", 1027410]],
      doublecounted: [["1778284800", 244963]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 7 }]);
  });

  it("adds back overlapping liquid staking and double-counted TVL", () => {
    const chart = getChainDefaultChartData({
      tvl: [["1778284800", 1000000]],
      liquidstaking: [["1778284800", 300000]],
      doublecounted: [["1778284800", 300000]],
      dcAndLsOverlap: [["1778284800", 300000]],
    });

    expect(chart).toEqual([{ date: 1778284800, tvl: 700000 }]);
  });
});

// regression test for https://github.com/DefiLlama/defillama-server/issues/9655
describe("processProtocols day bucketing", () => {
  const dayD = 1780272000; // 2026-06-01T00:00:00Z
  const afternoon = dayD + 18 * 3600; // same day, 18:00 UTC

  // real protocols so they pass the metadata checks inside processProtocols
  const [newListing, established] = protocols.filter((p) => _InternalProtocolMetadataMap[p.id]?.hasTvl);

  // runs the chart pipeline over the given protocols (keyed by id, value = daily records)
  // and returns the latest chart timestamp emitted for each
  async function maxChartTimestamps(dailyRecordsById: { [id: string]: any[] }) {
    const maxTs: { [id: string]: number } = {};
    await processProtocols(
      async (timestamp, _item, protocol) => {
        maxTs[protocol.id] = Math.max(maxTs[protocol.id] ?? 0, timestamp);
      },
      {
        includeBridge: false,
        protocolList: [newListing, established].filter((p) => p.id in dailyRecordsById),
        getLastTvl: () => ({ SK: afternoon, tvl: 100 }),
        getAllTvlData: (p: Protocol) => dailyRecordsById[p.id],
      },
      false // skip category-based exclusions
    );
    return maxTs;
  }

  it("does not emit future-dated points for a protocol with only an hourly record", async () => {
    const maxTs = await maxChartTimestamps({ [newListing.id]: [] });
    expect(maxTs[newListing.id]).toBeLessThanOrEqual(dayD);
  });

  it("does not pad other protocols' charts past the real last day", async () => {
    const maxTs = await maxChartTimestamps({
      [newListing.id]: [],
      [established.id]: [{ SK: dayD, tvl: 490 }],
    });
    expect(maxTs[established.id]).toBeLessThanOrEqual(dayD);
  });
});
