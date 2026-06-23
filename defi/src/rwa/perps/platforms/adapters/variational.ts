import type { FundingEntry, ParsedPerpsMarket, PlatformAdapter } from "../types";
import { safeFetch, safeFloat } from "../types";
import { getContractMetadataCount, hasContractMetadata } from "../../constants";

// Variational Omni - Arbitrum
// Docs: https://docs.variational.io/for-developers/api
// API: https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats
// The stats endpoint lists everything Variational trades — crypto, equities,
// ETFs, indices and commodities — without exposing asset classes. The RWA
// Airtable sheet is the single source of truth for which markets are RWA, so we
// filter on `hasContractMetadata('variational:<ticker>')` rather than a
// hardcoded allowlist (which silently drops whole categories as Variational
// lists new equities/ETFs/commodities).

export const VARIATIONAL_MAKER_FEE = 0;
export const VARIATIONAL_TAKER_FEE = 0;
export const VARIATIONAL_MAX_LEVERAGE = 50;

const VARIATIONAL_STATS_API = "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats";
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

// Canonical contract id for a Variational ticker — the key the Airtable sheet
// uses. `hasContractMetadata` lowercases internally; we normalize here too so
// the id is unambiguous at the call site.
export const variationalContractId = (ticker: string): string => `variational:${ticker.toLowerCase()}`;

// Keep only listings that have an Airtable metadata row, matching the downstream
// gate in perps.ts and avoiding ingestion of the ~440 crypto perps we'd discard.
// Fallback: when no metadata is loaded — i.e. the preview CLI, whose job is to
// surface new/untagged markets — emit every listing instead.
export function filterVariationalRwaListings(listings: VariationalListing[]): VariationalListing[] {
  if (getContractMetadataCount() === 0) return listings;
  return listings.filter((l) => hasContractMetadata(variationalContractId(String(l.ticker ?? "").trim())));
}

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface VariationalListing {
  ticker: string;
  name?: string;
  mark_price?: string | number;
  volume_24h?: string | number;
  open_interest?: {
    long_open_interest?: string | number;
    short_open_interest?: string | number;
  };
  funding_rate?: string | number;
  funding_interval_s?: number;
  base_spread_bps?: string | number;
  quotes?: {
    updated_at?: string;
    base?: VariationalQuote;
    size_1k?: VariationalQuote;
    size_100k?: VariationalQuote;
    size_1m?: VariationalQuote;
  };
}

interface VariationalQuote {
  bid?: string | number;
  ask?: string | number;
}

interface VariationalStatsResponse {
  listings?: VariationalListing[];
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchVariationalStats(): Promise<VariationalListing[]> {
  const data = await safeFetch<VariationalStatsResponse>(VARIATIONAL_STATS_API, "Variational stats");
  return data?.listings ?? [];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function midFromQuote(quote: VariationalQuote | undefined, fallback: number): number {
  const bid = safeFloat(quote?.bid);
  const ask = safeFloat(quote?.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return fallback;
}

function annualizedFundingToPeriod(fundingRate: string | number | undefined, intervalSeconds: number | undefined): number {
  const annualized = safeFloat(fundingRate);
  if (!annualized || !intervalSeconds || intervalSeconds <= 0) return 0;
  return annualized / (SECONDS_PER_YEAR / intervalSeconds);
}

export function parseVariationalMarkets(listings: VariationalListing[]): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];

  for (const listing of listings) {
    const ticker = String(listing.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!ticker) continue;

    const markPx = safeFloat(listing.mark_price);
    const midPx = midFromQuote(listing.quotes?.base ?? listing.quotes?.size_1k, markPx);
    // `long_open_interest` / `short_open_interest` are the trader legs in USD
    // notional; the OLP pool takes the opposite side, so summing them gives the
    // one-sided open interest across all participants. We deliberately do NOT
    // double this: Variational's own `open_interest` total (and its UI) reports
    // 2x(long+short) — a two-sided gross figure — but every other perps adapter
    // here reports one-sided OI (e.g. Hyperliquid base-units x markPx), so we
    // match that cross-venue convention instead of Variational's headline.
    const openInterest =
      safeFloat(listing.open_interest?.long_open_interest) +
      safeFloat(listing.open_interest?.short_open_interest);

    markets.push({
      contract: `variational:${ticker}`,
      venue: "variational",
      platform: "variational",
      openInterest,
      volume24h: safeFloat(listing.volume_24h),
      markPx,
      // The public stats endpoint exposes mark price but not Omni's index price.
      oraclePx: 0,
      midPx,
      prevDayPx: 0,
      priceChange24h: 0,
      fundingRate: annualizedFundingToPeriod(listing.funding_rate, listing.funding_interval_s),
      // funding_rate above is the per-interval rate; expose the interval (hours)
      // so the pipeline can normalize it to per-1h. null when absent (rate is 0).
      fundingIntervalHours: listing.funding_interval_s ? listing.funding_interval_s / 3600 : null,
      premium: 0,
      maxLeverage: VARIATIONAL_MAX_LEVERAGE,
      szDecimals: 0,
      makerFeeRate: VARIATIONAL_MAKER_FEE,
      takerFeeRate: VARIATIONAL_TAKER_FEE,
      // Variational is RFQ/OLP-priced with no explicit maker/taker fee — the
      // cost is the spread. `base_spread_bps` is the full bid/ask spread in bps.
      spreadBps: safeFloat(listing.base_spread_bps) || null,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const variationalAdapter: PlatformAdapter = {
  name: "variational",
  oiIsNotional: true,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const listings = await fetchVariationalStats();
    if (listings.length === 0) return [];
    return parseVariationalMarkets(filterVariationalRwaListings(listings));
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    return [];
  },
};
