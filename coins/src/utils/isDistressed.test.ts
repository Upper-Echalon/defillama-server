import { isDistressedAssetPK } from "./isDistressed";
import { distressedAssets } from "../adapters/other/distressed";

// Mock the DynamoDB boundary so getBasicCoins runs the REAL sanitisation logic
// against controlled records (no prod table access, no network).
const mockBatchGet = jest.fn();
jest.mock("./shared/dynamodb", () => ({
  __esModule: true,
  default: { get: jest.fn(), query: jest.fn() },
  batchGet: (...args: any[]) => mockBatchGet(...args),
}));

import { getBasicCoins } from "./getCoinsUtils";
import { getRecordClosestToTimestamp } from "./distressedAwareRecord";

const H = "ethereum:0xcf5104d094e3864cfcbda43b82e1cefd26a016eb"; // hacked 2026-06-08
const H_PK = `asset#${H}`;
const LEGIT = "ethereum:0x0000000000000000000000000000000000000001";
const LEGIT_PK = `asset#${LEGIT}`;

describe("isDistressedAssetPK", () => {
  it("matches a distressed asset# PK", () => {
    expect(isDistressedAssetPK(H_PK)).toBe(true);
  });
  it("does NOT match the shared coingecko id (per-address, cg slot untouched)", () => {
    expect(isDistressedAssetPK("coingecko#humanity")).toBe(false);
  });
  it("does NOT match a healthy asset", () => {
    expect(isDistressedAssetPK(LEGIT_PK)).toBe(false);
  });
  it("sanity: H really is in the distressed set", () => {
    expect(distressedAssets[H]).toBe(true);
  });
});

describe("getRecordClosestToTimestamp (distressed-aware wrapper)", () => {
  it("returns $0 for a distressed PK at any timestamp without hitting the DB", async () => {
    const ts = 1_700_000_000;
    const rec: any = await getRecordClosestToTimestamp(H_PK, ts);
    expect(rec.price).toBe(0);
    expect(rec.SK).toBe(ts);
    expect(mockBatchGet).not.toHaveBeenCalled();
  });
});

describe("getBasicCoins zeroes distressed contracts per-address", () => {
  it("zeroes the distressed contract and drops its redirect, but leaves another deployment on the SAME cg id priced", async () => {
    mockBatchGet.mockResolvedValueOnce([
      { PK: H_PK, SK: 0, price: 0.185, redirect: "coingecko#humanity", symbol: "H", decimals: 18, confidence: 0.99, timestamp: 1 },
      { PK: LEGIT_PK, SK: 0, price: 5, redirect: "coingecko#humanity", symbol: "OK", decimals: 18, confidence: 0.99, timestamp: 1 },
    ]);

    const { coins } = await getBasicCoins([H, LEGIT]);
    const h = coins.find((c: any) => c.PK === H_PK);
    const legit = coins.find((c: any) => c.PK === LEGIT_PK);

    // distressed contract: zeroed, redirect dropped (so historical lookups hit
    // the asset# PK, where the wrapper returns $0), metadata preserved
    expect(h.price).toBe(0);
    expect(h.redirect).toBeUndefined();
    expect(h.symbol).toBe("H");
    expect(h.decimals).toBe(18);

    // a different address on the SAME cg id is NOT distressed -> keeps real price + redirect
    expect(legit.price).toBe(5);
    expect(legit.redirect).toBe("coingecko#humanity");
  });
});
