import axios from "axios";
import { addToDBWritesList, getTokenAndRedirectDataMap } from "../utils/database";
import { Write } from "../utils/dbInterfaces";

const RPC = "https://entrypoint-finney.opentensor.ai";
const RPC_TIMEOUT_MS = 30_000;
const PAGE = 500;
const TAO_DECIMALS = 9;
const MIN_TAO_RESERVE = BigInt(5e10);

// twox128("SubtensorModule") ++ twox128(item)
const SUBNET_TAO = "0x658faa385070e074c85bf6b568cf05557a57dce016211512d1700561066b85a3";
const SUBNET_ALPHA_IN = "0x658faa385070e074c85bf6b568cf05552ce12f7007574647d692ac7edf8b7a53";

const u16le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]).toString("hex");
const netuidFromKey = (key: string) => Buffer.from(key.slice(-4), "hex").readUInt16LE();
const readU64Rao = (hex: string) => Buffer.from(hex.slice(2), "hex").readBigUInt64LE();

async function rpc(method: string, params: any[]): Promise<any> {
  const { data } = await axios.post(
    RPC,
    { jsonrpc: "2.0", id: 1, method, params },
    { timeout: RPC_TIMEOUT_MS },
  );
  if (data.error) throw new Error(`${method} RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getAllKeys(prefix: string, at: string): Promise<string[]> {
  const keys: string[] = [];
  let startKey: string | null = null;
  while (true) {
    const page: string[] = await rpc("state_getKeysPaged", [prefix, PAGE, startKey, at]);
    keys.push(...page);
    if (page.length < PAGE) return keys;
    startKey = page[page.length - 1];
  }
}

export default async function bittensorSubnets(timestamp: number = 0): Promise<Write[]> {
  if (timestamp !== 0)
    throw new Error("bittensorSubnets adapter only supports current prices (timestamp 0)");

  const at = await rpc("chain_getFinalizedHead", []);

  // Enumerate all subnets to read alpha and tao balances for each pool
  const taoKeys = await getAllKeys(SUBNET_TAO, at);
  const netuids = [...new Set(taoKeys.map(netuidFromKey))];
  const alphaKeys = netuids.map((n) => SUBNET_ALPHA_IN + u16le(n));

  const result = await rpc("state_queryStorageAt", [[...taoKeys, ...alphaKeys], at]);
  const changes: [string, string | null][] = result?.[0]?.changes ?? [];
  if (!changes.length) throw new Error("no subnet pool storage returned from bittensor RPC");

  const tao: { [netuid: number]: bigint } = {};
  const alphaIn: { [netuid: number]: bigint } = {};
  for (const [key, value] of changes) {
    if (!value) continue;
    const netuid = netuidFromKey(key);
    if (key.startsWith(SUBNET_TAO)) tao[netuid] = readU64Rao(value);
    else if (key.startsWith(SUBNET_ALPHA_IN)) alphaIn[netuid] = readU64Rao(value);
  }

  const taoData = await getTokenAndRedirectDataMap(["bittensor"], "coingecko", timestamp);
  const taoPrice = taoData["coingecko#bittensor"]?.price;
  if (!taoPrice) throw new Error("no TAO (coingecko#bittensor) price available");

  const writes: Write[] = [];
  for (const netuid of netuids) {
    let price: number;
    if (netuid === 0) {
      price = taoPrice;
    } else {
      const t = tao[netuid];
      const a = alphaIn[netuid];
      if (!t || !a || t < MIN_TAO_RESERVE) continue;
      price = Number((t * 1_000_000_000_000n) / a) / 1_000_000_000_000 * taoPrice;
    }
    if (!isFinite(price) || price <= 0) continue;

    addToDBWritesList(writes, "bittensor", `${netuid}`, price, TAO_DECIMALS, `SN${netuid}`, timestamp, "bittensor-subnets", 0.9);
  }

  return writes;
}
