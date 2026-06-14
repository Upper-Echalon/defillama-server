import { successResponse, wrap, IResponse } from "./utils/shared";
import { getR2 } from "./utils/r2";
import parseRequestBody from "./utils/shared/parseRequestBody";
import { getBasicCoins } from "./utils/getCoinsUtils";

type FdvEntry = { fdv: number; timestamp: number };
type FdvsResponse = { [coin: string]: FdvEntry };

const SORTED_TOKENLIST_KEY = "tokenlist/sorted.json";
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { map: Map<string, FdvEntry>; fetchedAt: number } | undefined;
let inflight: Promise<Map<string, FdvEntry>> | undefined;

async function loadFdvMap(): Promise<Map<string, FdvEntry>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.map;
  if (!inflight) {
    inflight = (async () => {
      const res = await getR2(SORTED_TOKENLIST_KEY);
      const list = res.body ? JSON.parse(res.body) : [];
      const map = new Map<string, FdvEntry>();
      if (Array.isArray(list)) {
        for (const e of list) {
          if (typeof e?.id !== "string") continue;
          if (typeof e.fully_diluted_valuation !== "number" || e.fully_diluted_valuation <= 0) continue;
          map.set(e.id, {
            fdv: e.fully_diluted_valuation,
            timestamp: e.last_updated ? Math.floor(Date.parse(e.last_updated) / 1000) : 0,
          });
        }
      }
      cache = { map, fetchedAt: Date.now() };
      return map;
    })().finally(() => {
      inflight = undefined;
    });
  }
  return inflight;
}

function geckoIdFromCoin(coin: { PK?: string; redirect?: string }): string | null {
  for (const key of [coin.redirect, coin.PK]) {
    if (typeof key === "string" && key.startsWith("coingecko#")) {
      return key.slice("coingecko#".length);
    }
  }
  return null;
}

const handler = async (
  event: AWSLambda.APIGatewayEvent,
): Promise<IResponse> => {
  const body = parseRequestBody(event.body);
  const requestedCoins = body.coins;
  const [{ PKTransforms, coins }, fdvMap] = await Promise.all([
    getBasicCoins(requestedCoins),
    loadFdvMap(),
  ]);
  const response = {} as FdvsResponse;
  coins.forEach((coin: { PK: string; redirect?: string }) => {
    const geckoId = geckoIdFromCoin(coin);
    const entry = geckoId ? fdvMap.get(geckoId) : undefined;
    if (!entry) return;
    PKTransforms[coin.PK].forEach((coinName) => {
      response[coinName] = entry;
    });
  });
  return successResponse(response);
};

export default wrap(handler);
