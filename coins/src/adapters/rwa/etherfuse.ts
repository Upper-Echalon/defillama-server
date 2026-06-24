import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import { checkOracleFresh, NAV_ORACLE_MAX_AGE_SECONDS } from "../utils/oracle";
import axios from "axios";

const API_URL = "https://api.etherfuse.com/lookup/bonds/cost";

const bonds: { mint: string; symbol: string; decimals: number }[] = [
  { mint: "USTRYnGgcHAhdWsanv8BG6vHGd4p7UGgoB9NRd8ei7j", symbol: "USTRY", decimals: 6 },
  { mint: "BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p", symbol: "TESOURO", decimals: 6 },
  { mint: "GiLTSeSFnNse7xQVYeKdMyckGw66AoRmyggGg1NNd4yr", symbol: "GILTS", decimals: 6 },
  { mint: "KTBeXe7VMPMLxBsqDQu4KA9PdSajF3Hkw1y9qRsKqfL", symbol: "KTB", decimals: 6 },
  { mint: "CeteszTBgDCiRWyPX6KFMHGVcSBTAg82dbaiFC7xDXSn", symbol: "MEX", decimals: 6 },
  { mint: "CETES7CKqqKQizuSN6iWQwmTeFRjbJR6Vw2XRKfEDR8f", symbol: "CETES", decimals: 6 },
  { mint: "EuroszHk1AL7fHBBsxgeGHsamUqwBpb26oEyt9BcfZ6G", symbol: "EUROB", decimals: 6 },
];

function getNewestSourceTimestamp(sources: Record<string, { updated_at?: number }> | undefined): number | undefined {
  if (!sources || typeof sources !== "object") return undefined;
  let newest = 0;
  for (const s of Object.values(sources)) {
    if (s.updated_at && s.updated_at > newest) newest = s.updated_at;
  }
  return newest || undefined;
}

export async function etherfuse(timestamp: number = 0): Promise<Write[]> {
  const { data } = await axios.get(API_URL);
  const writes: Write[] = [];

  for (const { mint, symbol, decimals } of bonds) {
    const entry = data[mint];
    if (!entry) continue;

    const price = Number(entry.bond_cost_in_usd);
    if (!price || price <= 0) continue;

    const sourceTs = getNewestSourceTimestamp(entry.sources);
    if (sourceTs === undefined) continue;
    if (!checkOracleFresh(sourceTs, { timestamp, label: `etherfuse:${symbol}`, throwIfStale: false, maxAgeSeconds: NAV_ORACLE_MAX_AGE_SECONDS }))
      continue;

    addToDBWritesList(writes, "solana", mint, price, decimals, symbol, timestamp, "etherfuse", 0.9);
  }

  return writes;
}
