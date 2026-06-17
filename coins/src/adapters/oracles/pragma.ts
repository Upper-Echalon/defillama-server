import { getCurrentUnixTimestamp } from "../../utils/date";
import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { multiCall } from "../utils/starknet";

type Feed = { id: string; symbol: string; address: string; decimals: number };

// Pragma oracle: get_data_median(data_type, pair_id) -> (price, offset,
// last_updated_timestamp, num_sources_aggregated). data_type 0x0 == SpotEntry.
const PRAGMA_ORACLE =
  "0x2a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b";
const SPOT_ENTRY = "0x0";
const getDataMedianAbi = {
  name: "get_data_median",
  type: "function",
  inputs: [
    { name: "data_type", type: "core::felt252" },
    { name: "pair_id", type: "core::felt252" },
  ],
  outputs: [
    { name: "price", type: "core::felt252" },
    { name: "offset", type: "core::felt252" },
    { name: "publishTime", type: "core::felt252" },
    { name: "sources", type: "core::felt252" },
  ],
  state_mutability: "view",
  customInput: "address",
};

const feeds: Feed[] = [
  {
    id: "0x585354524b2f555344",
    symbol: "xSTRK",
    address:
      "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a",
    decimals: 18,
  },
  {
    id: "0x535354524b2f555344",
    symbol: "sSTRK",
    address:
      "0x0356f304b154d29d2a8fe22f1cb9107a9b564a733cf6b4cc47fd121ac1af90c9",
    decimals: 18,
  },
]; // hex strings of ref from https://docs.pragma.build/v1/Resources/data-feeds/supported-assets

export async function pragma(timestamp: number = 0) {
  const THREE_DAYS = 3 * 24 * 60 * 60;
  const now = getCurrentUnixTimestamp();
  const threeDaysAgo = (timestamp ? timestamp : now) - THREE_DAYS;

  // One on-chain aggregated call covers every feed in a single RPC execution.
  const results = await multiCall({
    target: PRAGMA_ORACLE,
    abi: getDataMedianAbi,
    calls: feeds.map(({ id }) => ({ params: [SPOT_ENTRY, id] })),
  });

  const writes: Write[] = [];
  feeds.forEach(({ symbol, address, decimals }: Feed, i: number) => {
    const price = Number(results[i].price);
    const offset = Number(results[i].offset);
    const publishTime = Number(results[i].publishTime);
    const sources = Number(results[i].sources);

    if (publishTime < threeDaysAgo || sources == 1) return;

    addToDBWritesList(
      writes,
      "starknet",
      address,
      price / 10 ** offset,
      decimals,
      symbol,
      timestamp,
      "pragma",
      0.9,
    );
  });

  return writes;
}
