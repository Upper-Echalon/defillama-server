jest.mock("../cache/file-cache", () => ({
  readRouteData: jest.fn(),
  storeRouteData: jest.fn(),
}));

import { AdapterType, AdaptorRecordType, ADAPTER_TYPES } from "../../adaptors/data/types";
import { storeRouteData } from "../cache/file-cache";
import { buildProtocolRouteIndex, generateDimensionsResponseFiles } from "./dimensions";

const mockedStoreRouteData = storeRouteData as jest.MockedFunction<typeof storeRouteData>;

function emptyAdapterCache() {
  return {
    protocolSummaries: {},
    parentProtocolSummaries: {},
    summaries: {},
    allChains: [],
  } as any;
}

function summary(overrides: any = {}) {
  return {
    chart: {},
    chartBreakdown: {},
    chainSummary: {},
    categorySummary: {},
    recordCount: 1,
    ...overrides,
  };
}

function buildDimensionsCache() {
  const recordType = AdaptorRecordType.dailyVolume;
  const cache: any = Object.fromEntries(ADAPTER_TYPES.map((adapterType) => [adapterType, emptyAdapterCache()]));

  cache[AdapterType.DEXS] = {
    ...emptyAdapterCache(),
    allChains: ["Ethereum", "Arbitrum"],
    protocolSummaries: {
      "1": {
        info: {
          defillamaId: "1",
          name: "Eth Dex",
          category: "Dexs",
          chains: ["Ethereum"],
        },
        summaries: {
          [recordType]: summary({
            total24h: 10,
            totalAllTime: 100,
            chainSummary: {
              ethereum: summary({ total24h: 10, totalAllTime: 100 }),
            },
          }),
        },
      },
      "2": {
        info: {
          defillamaId: "2",
          name: "Arb Lend",
          category: "Lending",
          chains: ["Arbitrum"],
        },
        summaries: {
          [recordType]: summary({
            total24h: 20,
            totalAllTime: 200,
            chainSummary: {
              arbitrum: summary({ total24h: 20, totalAllTime: 200 }),
            },
          }),
        },
      },
      "3": {
        info: {
          defillamaId: "3",
          name: "Multi Dex",
          category: "Dexs",
          tags: ["Dexs", "Trading"],
          chains: ["Ethereum", "Arbitrum"],
        },
        summaries: {
          [recordType]: summary({
            total24h: 30,
            totalAllTime: 300,
            chainSummary: {
              ethereum: summary({ total24h: 11, totalAllTime: 110 }),
              arbitrum: summary({ total24h: 19, totalAllTime: 190 }),
            },
          }),
        },
      },
      "4": {
        info: {
          defillamaId: "4",
          name: "Empty Dex",
          category: "Dexs",
          chains: ["Ethereum"],
        },
        summaries: {
          [recordType]: summary({
            recordCount: 0,
            chainSummary: {
              ethereum: summary({ recordCount: 0 }),
            },
          }),
        },
      },
    },
    summaries: {
      [recordType]: summary({
        total24h: 60,
        totalAllTime: 600,
        chainSummary: {
          ethereum: summary({ total24h: 21, totalAllTime: 210 }),
          arbitrum: summary({ total24h: 39, totalAllTime: 390 }),
        },
        categorySummary: {
          Dexs: summary({
            total24h: 40,
            totalAllTime: 400,
            chainSummary: {
              ethereum: summary({ total24h: 21, totalAllTime: 210 }),
              arbitrum: summary({ total24h: 19, totalAllTime: 190 }),
            },
          }),
          Lending: summary({
            total24h: 20,
            totalAllTime: 200,
            chainSummary: {
              arbitrum: summary({ total24h: 20, totalAllTime: 200 }),
            },
          }),
        },
      }),
    },
  };

  return cache;
}

function storedData(route: string) {
  const call = mockedStoreRouteData.mock.calls.find(([storedRoute]) => storedRoute === route);
  return call?.[1] as any;
}

describe("dimensions route generation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("indexes protocol rows by chain, category, and category-chain", () => {
    const cache = buildDimensionsCache()[AdapterType.DEXS];
    const routeIndex = buildProtocolRouteIndex(cache.protocolSummaries, AdaptorRecordType.dailyVolume);

    expect(routeIndex.all.map((row) => row.info.name)).toEqual(["Eth Dex", "Arb Lend", "Multi Dex"]);
    expect(routeIndex.byChain.get("ethereum")?.map((row) => row.info.name)).toEqual(["Eth Dex", "Multi Dex"]);
    expect(routeIndex.byCategory.get("Dexs")?.map((row) => row.info.name)).toEqual(["Eth Dex", "Multi Dex"]);
    expect(routeIndex.byCategory.get("Trading")?.map((row) => row.info.name)).toEqual(["Multi Dex"]);
    expect(routeIndex.byCategoryChain.get("Dexs")?.get("arbitrum")?.map((row) => row.info.name)).toEqual(["Multi Dex"]);
  });

  test("uses indexed rows when generating overview and category files", async () => {
    await generateDimensionsResponseFiles(buildDimensionsCache());

    expect(storedData("dimensions/dexs/dv-all").protocols.map((protocol: any) => protocol.name)).toEqual([
      "Eth Dex",
      "Arb Lend",
      "Multi Dex",
    ]);
    expect(storedData("dimensions/dexs/dv-chain/ethereum-all").protocols.map((protocol: any) => protocol.name)).toEqual([
      "Eth Dex",
      "Multi Dex",
    ]);
    expect(storedData("dimensions/dexs/dv-category/dexs").protocols.map((protocol: any) => protocol.name)).toEqual([
      "Eth Dex",
      "Multi Dex",
    ]);
    expect(storedData("dimensions/dexs/dv-category/dexs-chain/arbitrum").protocols.map((protocol: any) => protocol.name)).toEqual([
      "Multi Dex",
    ]);
  });
});
