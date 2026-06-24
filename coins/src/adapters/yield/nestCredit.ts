import { Write } from "../utils/dbInterfaces";
import getWrites from "../utils/getWrites";
import { getApi } from "../utils/sdk";
import { getCurrentUnixTimestamp } from "../../utils/date";
import { getConfig } from "../../utils/cache";
import { checkOracleFresh } from "../utils/oracle";

const VAULTS_API = "https://api.nest.credit/v1/vaults";

const extraVaults: { vault: string; accountant: string }[] = [
  { vault: "0x63810d7F1C7b4DbfB60c173ba120A2be98b59E13", accountant: "0x77Fc9ce9a03a403F77bD3444c99dC603Ea6fDD01" }, // NCLOA
  { vault: "0x6e28FB79Ba12B808c439fddB22C09753A83057Fc", accountant: "0xd7306FEe2583f4FB897Daf83695A83ddC06db527" }, // NFBND
];

export async function nestCredit(timestamp: number) {
  const t = timestamp === 0 ? getCurrentUnixTimestamp() : timestamp;
  const api = await getApi("ethereum", t, true);

  const config = await getConfig("nestcredit-vaults", VAULTS_API);
  const apiVaults = (config?.data ?? [])
    .filter((v: any) => v.slug !== "nest-test-vault" && v.vaultAddress && v.accountantAddress)
    .map((v: any) => ({ vault: v.vaultAddress, accountant: v.accountantAddress }));

  const seen = new Set(apiVaults.map((v: any) => v.vault.toLowerCase()));
  const allVaults = [
    ...apiVaults,
    ...extraVaults.filter((v) => !seen.has(v.vault.toLowerCase())),
  ];

  const [bases, decimals, accountantState] = await Promise.all([
    api.multiCall({ abi: "address:base", calls: allVaults.map((v: any) => ({ target: v.accountant })), permitFailure: true }),
    api.multiCall({ abi: "uint8:decimals", calls: allVaults.map((v: any) => ({ target: v.vault })), permitFailure: true }),
    api.multiCall({
      abi: "function getAccountantState() view returns (address payoutAddress, uint128 feesOwedInBase, uint128 totalSharesLastUpdate, uint96 exchangeRate, uint32 allowedExchangeRateChangeUpper, uint32 allowedExchangeRateChangeLower, uint64 lastUpdateTimestamp, bool isPaused, uint32 minimumUpdateDelayInSeconds)",
      calls: allVaults.map((v: any) => ({ target: v.accountant })), 
      permitFailure: true
    }).catch(() => null),
  ]);

  const pricesObject: any = {};
  for (let i = 0; i < allVaults.length; i++) {
    if (!accountantState?.[i] || !bases[i] || !decimals[i]) continue;
    if (!checkOracleFresh(accountantState[i] ? Number(accountantState[i][6]) : 0, { timestamp, label: "nestCredit", throwIfStale: false }))
      return [];
    const rate = Number(accountantState[i][3]);
    pricesObject[allVaults[i].vault] = {
      underlying: bases[i],
      price: rate / 10 ** decimals[i],
    };
  }

  const writes: Write[] = [];
  return getWrites({
    chain: "ethereum",
    timestamp,
    pricesObject,
    projectName: "nestCredit",
    writes,
  });
}
