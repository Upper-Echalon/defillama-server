import { getTokensInProtocolsInternal } from "./getTokenInProtocols";

describe("getTokensInProtocolsInternal", () => {
  it("returns base-chain token usage without changing token-level totals", async () => {
    const protocol = { name: "Test Protocol", category: "Lending" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        PK: "hourlyUsdTokensTvl#123",
        SK: 1777766400,
        tvl: {
          USDC: 150,
          WETH: 50,
          "bad-USDC": "100",
          "nan-USDC": Number.NaN,
        },
        ethereum: {
          USDC: 100,
          WETH: 50,
          "bad-USDC": "100",
        },
        arbitrum: {
          USDC: 50,
          "nan-USDC": Number.NaN,
        },
        borrowed: {
          USDC: -25,
        },
        ownTokens: {
          USDC: 999,
        },
        "ethereum-borrowed": {
          USDC: -25,
        },
      }),
      protocolHasMisrepresentedTokens: () => false,
    });
    expect(result).toEqual([
      {
        name: "Test Protocol",
        category: "Lending",
        amountUsd: {
          USDC: 150,
        },
        amountUsdByChain: {
          ethereum: {
            USDC: 100,
          },
          arbitrum: {
            USDC: 50,
          },
        },
        misrepresentedTokens: false,
      },
    ]);
  });

  it("breaks down multiple matching token keys inside each chain bucket", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USD", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        PK: "hourlyUsdTokensTvl#456",
        SK: 1777766400,
        tvl: {
          USDC: 100,
          USDT: 25,
        },
        ethereum: {
          USDC: 70,
          USDT: 5,
        },
        base: {
          USDC: 30,
          USDT: 20,
          WETH: 20,
        },
        borrowed: {
          USDT: 999,
        },
        "ethereum-borrowed": {
          USDT: 20,
        },
      }),
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result[0].amountUsd).toEqual({
      USDC: 100,
      USDT: 25,
    });
    expect(result[0].amountUsdByChain).toEqual({
      ethereum: {
        USDC: 70,
        USDT: 5,
      },
      base: {
        USDC: 30,
        USDT: 20,
      },
    });
  });

  it("skips protocols without a token amount map", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        tvl: null,
      }),
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result).toEqual([]);
  });

  it("skips protocols with no stored record", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => undefined,
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result).toEqual([]);
  });

  it("skips protocols whose only matching amounts are not finite numbers", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        tvl: {
          USDC: "100",
          "nan-USDC": Number.NaN,
          WETH: 50,
        },
      }),
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result).toEqual([]);
  });

  it("returns an empty chain breakdown when the record only has an aggregate tvl section", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        tvl: {
          USDC: 100,
        },
      }),
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result[0].amountUsd).toEqual({ USDC: 100 });
    expect(result[0].amountUsdByChain).toEqual({});
  });

  it("ignores malformed chain buckets and unregistered chain keys", async () => {
    const protocol = { name: "Test Protocol", category: "DEX" } as any;

    const result = await getTokensInProtocolsInternal("USDC", {
      protocolList: [protocol],
      getLastHourlyTokensUsd: async () => ({
        tvl: {
          USDC: 100,
        },
        ethereum: 12345,
        arbitrum: null,
        "not-a-real-chain": {
          USDC: 100,
        },
        base: {
          USDC: 100,
        },
      }),
      protocolHasMisrepresentedTokens: () => false,
    });

    expect(result[0].amountUsdByChain).toEqual({
      base: {
        USDC: 100,
      },
    });
  });
});
