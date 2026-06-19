import { mergeRows } from "./migrateStarknetKeys";

// mergeRows collapses the DDB rows of several address variants into one
// canonical set: a single SK=0 metadata row + a deduped price history.
const price = (sk: number, p: number, confidence = 1, adapter = "a") => ({
  PK: "asset#starknet:0xvariant",
  SK: sk,
  price: p,
  confidence,
  adapter,
});
const meta = (ts: number, extra: any = {}) => ({ PK: "asset#starknet:0xx", SK: 0, symbol: "TKN", decimals: 18, timestamp: ts, ...extra });

describe("mergeRows", () => {
  it("unions price history across target and variants", () => {
    const target = [price(100, 1), price(200, 1)];
    const variants = [[price(300, 1)], [price(400, 1)]];
    const { prices } = mergeRows(target, variants);
    expect(prices.map((r) => r.SK).sort((a, b) => a - b)).toEqual([100, 200, 300, 400]);
  });

  it("on a colliding SK, keeps the higher-confidence row", () => {
    const target = [price(100, 1.0, 0.5)];
    const variants = [[price(100, 2.0, 0.99)]];
    const { prices } = mergeRows(target, variants);
    expect(prices).toHaveLength(1);
    expect(prices[0].price).toBe(2.0);
    expect(prices[0].confidence).toBe(0.99);
  });

  it("prefers the target's own metadata row over any variant", () => {
    const target = [meta(500, { PK: "asset#starknet:0xtarget", symbol: "CANON" })];
    const variants = [[meta(900, { symbol: "OLD" })]]; // newer ts, but a variant
    const { meta: m } = mergeRows(target, variants);
    expect(m.symbol).toBe("CANON");
  });

  it("falls back to the freshest variant metadata when target has none", () => {
    const target: any[] = [price(100, 1)]; // no SK=0
    const variants = [[meta(200, { symbol: "OLDER" })], [meta(800, { symbol: "NEWER" })]];
    const { meta: m } = mergeRows(target, variants);
    expect(m.symbol).toBe("NEWER");
  });

  it("returns null metadata when no SK=0 row exists anywhere", () => {
    const { meta: m } = mergeRows([price(100, 1)], [[price(200, 1)]]);
    expect(m).toBeNull();
  });

  it("does not treat SK=0 as a price row", () => {
    const { prices } = mergeRows([meta(1), price(100, 1)], []);
    expect(prices.map((r) => r.SK)).toEqual([100]);
  });
});
