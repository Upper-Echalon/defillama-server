import { distressedAssets } from "../adapters/other/distressed";

// A distressed asset must read $0 regardless of any coingecko redirect stored on
// its own PK. We zero the specific contract address only — never the shared
// coingecko id — so other deployments that redirect to the same cg id keep their
// real price. `distressedAssets` is keyed by "<chain>:<loweraddr>", which is
// exactly an `asset#` PK with the prefix stripped.
const ASSET_PREFIX = "asset#";

export function isDistressedAssetPK(pk: unknown): boolean {
  return (
    typeof pk === "string" &&
    pk.startsWith(ASSET_PREFIX) &&
    distressedAssets[pk.slice(ASSET_PREFIX.length)] === true
  );
}
