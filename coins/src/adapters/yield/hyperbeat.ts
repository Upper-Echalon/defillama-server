import { getCurrentUnixTimestamp } from "../../utils/date";
import { Write } from "../utils/dbInterfaces";
import getWrites from "../utils/getWrites";
import { getApi } from "../utils/sdk";

const accountants: { [chain: string]: { [address: string]: string } } = {
  hyperliquid: {
    "0x5ed0ec0b0643dab621dc814c8d058e161b9b884b": "lstHYPE",
    "0x3636a26ec1d512c5eCff42F7Adaa5cE7964C6579": "hbUSDT",
    "0xe0995A641d454c149E6C808BAA37Cb2B38763316": "hbUSDC",
    "0xC23cdFe493bB5E69bedfCF6E710f508710ac668B": "nLP",
    "0x5362454e5648C6Ac7F03969E8a62CFc61F99b9D6": "masterUSD",
    "0x5100Aee934F0EE05FA78B03114a068Da18aFEd8D": "dnHYPE",
    "0x58F6138DB540D0f5bfB24Fd9b17db54694a92ea6": "dnPUMP",
    "0x988E3E2C26840F2cAe2c5fB55fAeb5e59CE1A597": "hbXAUt",
  },
};

export async function hyperbeatEarn(timestamp: number) {
  return Promise.all(
    Object.keys(accountants).map((k: string) => getTokenPrices(timestamp, k)),
  );
}

async function getTokenPrices(timestamp: number, chain: string) {
  let t = timestamp == 0 ? getCurrentUnixTimestamp() : timestamp;
  const api = await getApi(chain, t, true);
  const calls = Object.keys(accountants[chain]).map((target: string) => ({
    target,
  }));
  const [underlyings, rates, decimals, vaults] = await Promise.all([
    api.multiCall({
      abi: "address:baseAsset",
      calls,
    }),
    api.multiCall({
      abi: "uint256:getRate",
      calls,
    }),
    api.multiCall({
      abi: "uint8:decimals",
      calls,
    }),
    api.multiCall({
      abi: "address:vaultToken",
      calls,
    }),
  ]);

  const pricesObject: any = {};

  vaults.map((v, i) => {
    pricesObject[v] = {
      underlying: underlyings[i],
      symbol: Object.values(accountants[chain])[i],
      decimals: decimals[i],
      price: rates[i] / 10 ** decimals[i],
    };
  });

  const writes: Write[] = [];
  return await getWrites({
    chain,
    timestamp,
    pricesObject,
    projectName: "hyperbeat-yield",
    writes,
  });
}
