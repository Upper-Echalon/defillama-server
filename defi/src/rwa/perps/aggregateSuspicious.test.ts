/**
 * Suspicious-market exclusion for aggregate perps charts.
 *
 * Markets flagged `Suspicious = TRUE` in Airtable (e.g. Parcl's constant-OI
 * synthetic markets, which draw a flat line) must be:
 *   - DROPPED from every cross-venue aggregate chart (overview "all",
 *     assetGroup / assetClass breakdowns, contract-breakdown aggregates,
 *     category charts), and
 *   - KEPT in venue-scoped charts (their own venue, e.g. Parcl) and in the
 *     per-market data that powers the tables.
 *
 * Drives the REAL aggregate builders (no reimplementation) with in-memory rows.
 */

import {
  buildCategoryHistoricalCharts,
  buildContractBreakdownCharts,
  buildOverviewBreakdownCharts,
  buildVenueHistoricalCharts,
} from "./aggregate";

const TS = 1779408000; // arbitrary start-of-day aligned timestamp

// A suspicious Parcl real-estate market with a flat 1,000,000 OI line ...
const PARCL_ID = "parcl:ny-nyc";
// ... and a healthy ApeX equity market that should drive the aggregates.
const APEX_ID = "apex:meta";

const dailyRecords = [
  { id: PARCL_ID, timestamp: TS, open_interest: 1_000_000, volume_24h: 0 },
  { id: PARCL_ID, timestamp: TS + 86400, open_interest: 1_000_000, volume_24h: 0 },
  { id: APEX_ID, timestamp: TS, open_interest: 500_000, volume_24h: 200_000 },
  { id: APEX_ID, timestamp: TS + 86400, open_interest: 600_000, volume_24h: 250_000 },
];

const metadata = [
  {
    id: PARCL_ID,
    data: {
      contract: PARCL_ID,
      venue: "Parcl",
      referenceAsset: "NY-NYC",
      referenceAssetGroup: "Real Estate",
      assetClass: ["Real estate index perp"],
      category: ["Real Estate"],
      suspicious: true,
    },
  },
  {
    id: APEX_ID,
    data: {
      contract: APEX_ID,
      venue: "ApeX Omni",
      referenceAsset: "META",
      referenceAssetGroup: "US Equities",
      assetClass: ["Single stock synthetic perp"],
      category: ["Equities"],
      suspicious: false,
    },
  },
];

describe("aggregate charts exclude suspicious markets", () => {
  it("keeps the suspicious market in its own venue chart", () => {
    const venueCharts = buildVenueHistoricalCharts(dailyRecords, metadata);
    expect(venueCharts["parcl"]).toBeDefined();
    expect(venueCharts["parcl"].every((row) => row.id === PARCL_ID)).toBe(true);
    expect(venueCharts["parcl"][0].openInterest).toBe(1_000_000);
  });

  it("drops the suspicious venue from the overview venue breakdown", () => {
    const charts = buildOverviewBreakdownCharts(dailyRecords, metadata);
    const allByVenue = charts["overview-breakdown/all/openinterest/venue.json"];
    expect(allByVenue).toBeDefined();
    for (const point of allByVenue) {
      expect(point["Parcl"]).toBeUndefined();
      expect(point["ApeX Omni"]).toBeGreaterThan(0);
    }
  });

  it("keeps the suspicious market in its own venue-scoped overview breakdown", () => {
    const charts = buildOverviewBreakdownCharts(dailyRecords, metadata);
    const parclByBaseAsset = charts["overview-breakdown/venue/parcl/openinterest/baseasset.json"];
    expect(parclByBaseAsset).toBeDefined();
    expect(parclByBaseAsset.some((point) => Object.values(point).includes(1_000_000))).toBe(true);
  });

  it("drops the suspicious contract from the aggregate contract breakdown", () => {
    const charts = buildContractBreakdownCharts(dailyRecords, metadata);
    const allOi = charts["contract-breakdown/all/openinterest.json"];
    expect(allOi).toBeDefined();
    for (const point of allOi) {
      expect(point[PARCL_ID]).toBeUndefined();
      expect(point["parcl:NY-NYC"]).toBeUndefined();
    }
    // ... but it is still present under its own venue.
    const parclOi = charts["contract-breakdown/venue/parcl/openinterest.json"];
    expect(parclOi.some((point) => Object.values(point).includes(1_000_000))).toBe(true);
  });

  it("drops the suspicious market's category from category charts", () => {
    const charts = buildCategoryHistoricalCharts(dailyRecords, metadata);
    // The suspicious market's category produces no rows ...
    expect(charts["real-estate"]).toBeUndefined();
    // ... while the healthy market's category is intact.
    expect(charts["equities"]).toBeDefined();
    expect(charts["equities"].every((row) => row.id === APEX_ID)).toBe(true);
  });
});
