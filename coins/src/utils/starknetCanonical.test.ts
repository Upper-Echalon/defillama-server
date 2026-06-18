import { canonicalizeStarknetAddress, padAddress } from "./coingeckoPlatforms";
import { lowercaseAddress, coinToPK } from "./processCoin";

// The two request forms from the original bug report (padded vs unpadded USDC).
const UNPADDED =
  "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const PADDED =
  "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";

describe("canonicalizeStarknetAddress", () => {
  it("strips the leading zero from a padded 66-char address", () => {
    expect(canonicalizeStarknetAddress(PADDED)).toBe(UNPADDED);
  });

  it("normalizes a fully zero-padded 66-char felt to 0x0, not empty", () => {
    expect(canonicalizeStarknetAddress("0x" + "0".repeat(64))).toBe("0x0");
  });

  it("leaves an already-canonical (unpadded) address unchanged", () => {
    expect(canonicalizeStarknetAddress(UNPADDED)).toBe(UNPADDED);
  });

  it("collapses padded and unpadded forms to the same key (the bug)", () => {
    expect(canonicalizeStarknetAddress(PADDED)).toBe(
      canonicalizeStarknetAddress(UNPADDED),
    );
  });

  it("strips multiple leading zeros on a full 66-char address", () => {
    const core = "abcd"; // small value, zero-padded to a full 66-char felt
    const manyZeros = "0x" + "0".repeat(64 - core.length) + core;
    expect(manyZeros.length).toBe(66);
    expect(canonicalizeStarknetAddress(manyZeros)).toBe("0x" + core);
  });

  it("does not touch a 66-char address with no leading zero", () => {
    const sixtySixNoZero = "0x3" + "f".repeat(63);
    expect(sixtySixNoZero.length).toBe(66);
    expect(canonicalizeStarknetAddress(sixtySixNoZero)).toBe(sixtySixNoZero);
  });

  it("leaves a shorter (non-66) address untouched, matching normalizedPKFor", () => {
    const short = "0x033068";
    expect(canonicalizeStarknetAddress(short)).toBe(short);
  });

  it("round-trips: padAddress then canonicalize returns the canonical form", () => {
    // padAddress is the write-time padder; canonicalize must undo it back to
    // the stored (stripped) key for both request forms.
    expect(canonicalizeStarknetAddress(padAddress(UNPADDED))).toBe(UNPADDED);
    expect(canonicalizeStarknetAddress(padAddress(PADDED))).toBe(UNPADDED);
  });
});

describe("lowercaseAddress / coinToPK (DDB-lambda read path)", () => {
  const PADDED_COIN = `starknet:${PADDED}`;
  const UNPADDED_COIN = `starknet:${UNPADDED}`;

  it("no longer produces the double-prefixed garbage key", () => {
    // Previously padAddress received the chain-prefixed string and emitted
    // `starknet:0xstarknet:0x...`; assert that is gone.
    expect(lowercaseAddress(PADDED_COIN)).not.toContain("0xstarknet");
  });

  it("normalizes padded and unpadded starknet coins to the same value", () => {
    expect(lowercaseAddress(PADDED_COIN)).toBe(`starknet:${UNPADDED}`);
    expect(lowercaseAddress(UNPADDED_COIN)).toBe(`starknet:${UNPADDED}`);
    expect(lowercaseAddress(PADDED_COIN)).toBe(lowercaseAddress(UNPADDED_COIN));
  });

  it("lowercases mixed-case hex before canonicalizing", () => {
    const mixedHex = `starknet:0x033068F6539F8E6E6B131E6B2B814E6C34A5224BC66947C47DAB9DFEE93B35FB`;
    expect(lowercaseAddress(mixedHex)).toBe(`starknet:${UNPADDED}`);
  });

  it("coinToPK builds one canonical asset# PK for both forms", () => {
    const expected = `asset#starknet:${UNPADDED}`;
    expect(coinToPK(PADDED_COIN)).toBe(expected);
    expect(coinToPK(UNPADDED_COIN)).toBe(expected);
  });
});
