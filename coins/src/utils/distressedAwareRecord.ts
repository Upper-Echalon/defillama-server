import { getRecordClosestToTimestamp as getSharedRecordClosestToTimestamp } from "./shared/getRecordClosestToTimestamp";
import { isDistressedAssetPK } from "./isDistressed";

// Coins-only wrapper around the shared timestamp resolver. A distressed contract
// reads $0 at every timestamp — the specific contract address only, never its
// shared coingecko id, so other deployments mapped to that id keep their price.
//
// This lives outside utils/shared/getRecordClosestToTimestamp.ts on purpose:
// that file is symlinked into the defi package and powers the TVL pipeline,
// which must not inherit coins-only distressed-asset zeroing.
export async function getRecordClosestToTimestamp(
  PK: any,
  timestamp: number,
  searchWidth: number | undefined = undefined,
) {
  if (isDistressedAssetPK(PK))
    return { SK: timestamp, price: 0, confidence: 1.01, mcap: 0, volume: 0 };
  return getSharedRecordClosestToTimestamp(PK, timestamp, searchWidth);
}
