import fetch from "node-fetch";
import protocols from "../protocols/data";
import { CategoryTagMap } from "../protocols/tags";
import { faultyIds, metadata } from "./protocols";

type Stats = {
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
  tvlUsd: number | null;
};

type CexVolume = { volume_24h: number; volume_7d: number };
type CexVolumeCache = { symbols: Record<string, CexVolume>; last_updated: string };

const MARKETS_API_BASE = process.env.MARKETS_API_BASE ?? "https://markets-data.llama.fi";

function fetchSymbols() {
  const rwaProtocols = protocols
    .filter((p) => p.tags?.some((t) => CategoryTagMap.RWA.includes(t)))
    .filter((p) => Object.keys(metadata).includes(p.id) && !Object.keys(faultyIds).includes(p.id)); // ! FOR TESTING ONLY
  const res: { [id: string]: string[] } = {};
  const a = Object.keys(metadata).length;
  rwaProtocols.map((p) => (res[p.id] = metadata[p.id].symbols));

  return res;
}

async function fetchCexVolume(): Promise<Record<string, CexVolume>> {
  try {
    const data: CexVolumeCache = await fetch(`${MARKETS_API_BASE}/markets/rwa/volume.json`).then((r) => r.json());
    return data?.symbols ?? {};
  } catch (e) {
    console.error("[rwa/stats] failed to fetch CEX volume, continuing with DEX only:", (e as Error).message);
    return {};
  }
}

function matchCexVolume(
  protocolSymbols: string[],
  cexSymbols: Record<string, CexVolume>,
): { vol1d: number; vol7d: number } {
  let vol1d = 0;
  let vol7d = 0;

  for (const sym of protocolSymbols) {
    const entry = cexSymbols[sym.toLowerCase()];
    if (entry) {
      vol1d += entry.volume_24h;
      vol7d += entry.volume_7d;
    }
  }

  return { vol1d, vol7d };
}

export async function fetchRWAStats() {
  const symbols = fetchSymbols();
  if (!process.env.INTERNAL_API_KEY) throw new Error("INTERNAL_API_KEY is not set");

  const [data, cexSymbols] = await Promise.all([
    fetch(`https://pro-api.llama.fi/${process.env.INTERNAL_API_KEY}/yields/pools`).then((r) => r.json()),
    fetchCexVolume(),
  ]);

  if (!data.data) throw new Error(`No data: ${JSON.stringify(data)}`);
  const lps = data.data.filter((item: any) => item.exposure == "multi");

  const res: { [id: string]: Stats } = {};
  Object.keys(symbols).map((id: string) => {
    let sum: Stats = {
      volumeUsd1d: 0,
      volumeUsd7d: 0,
      tvlUsd: 0,
      ...metadata[id],
    };

    symbols[id].map((symbol: string) => {
      const rwa = lps.filter((item: any) =>
        item.matchExact
          ? item.symbol.toLowerCase().startsWith(`${symbol.toLowerCase()}-`) ||
            item.symbol.toLowerCase().endsWith(`-${symbol.toLowerCase()}`)
          : item.symbol.toLowerCase().includes(symbol.toLowerCase())
      );

      sum = rwa.reduce((acc: any, { volumeUsd1d, volumeUsd7d, tvlUsd }: any) => {
        acc.volumeUsd1d += volumeUsd1d;
        acc.volumeUsd7d += volumeUsd7d;
        acc.tvlUsd += tvlUsd;
        return acc;
      }, sum);
    });

    const cex = matchCexVolume(symbols[id], cexSymbols);
    sum.volumeUsd1d = (sum.volumeUsd1d ?? 0) + cex.vol1d;
    sum.volumeUsd7d = (sum.volumeUsd7d ?? 0) + cex.vol7d;

    ["volumeUsd1d", "volumeUsd7d", "tvlUsd"].map((key) => {
      sum[key as keyof Stats] = sum[key as keyof Stats] ?? 0 > 0 ? sum[key as keyof Stats] : null;
    });

    res[id] = sum;
  });

  return res;
}
