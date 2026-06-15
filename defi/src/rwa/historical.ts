import { getChainIdFromDisplayName } from "../utils/normalizeChain";
import { initPG, storeHistoricalPG, storeMetadataPG, fetchLatestRwaRowsForIds, fetchLastPositiveDailyRowsForIds, fetchRecentMaxDailyRowCount } from "./db";
import { protocolIdMap } from "./constants";
import { RWA_KEY_MAP } from "./metadataConstants";
import { sendRwaAlert, sendThrottledRwaAlert } from "./alerting";
import {
  filterRwaAssetMoveGuardInserts,
  getRwaAssetMoveGuardOptionsFromEnv,
} from "./assetMoveGuard";

import * as sdk from '@defillama/sdk'
const { runInPromisePool } = sdk.util;

const inverseProtocolIdMap: { [name: string]: string } = Object.entries(protocolIdMap).reduce(
  (acc: { [name: string]: string }, [id, name]: [string, string]) => {
    acc[name] = id;
    return acc;
  },
  {}
);
export interface AtvlInsert {
  timestamp: number;
  id: string;
  defiactivetvl: string;
  mcap: string;
  activemcap: string;
  totalsupply: string;
  aggregatedefiactivetvl: number;
  aggregatemcap: number;
  aggregatedactivemcap: number;
}

export interface AtvlPerIdData {
  defiActiveTvl: { [chain: string]: { [name: string]: string } };
  onChainMcap: { [chain: string]: string };
  activeMcap: { [chain: string]: string };
  totalSupply?: { [chain: string]: number | string };
}

// Pure transform: atvl per-id output → DB insert row.
export function buildAtvlInsert(id: string, perId: AtvlPerIdData, timestamp: number): AtvlInsert {
  const { defiActiveTvl, onChainMcap, activeMcap, totalSupply } = perId;

  const defiactivetvl: { [chain: string]: { [id: string]: string } } = {};
  let aggregatedefiactivetvl = 0;
  Object.keys(defiActiveTvl ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    defiactivetvl[chainSlug] = {};
    Object.keys(defiActiveTvl[chain]).forEach((name) => {
      const protocolId = inverseProtocolIdMap[name];
      aggregatedefiactivetvl += Number(defiActiveTvl[chain][name]);
      defiactivetvl[chainSlug][protocolId] = defiActiveTvl[chain][name];
    });
  });

  const mcap: { [chain: string]: string } = {};
  let aggregatemcap = 0;
  Object.keys(onChainMcap ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    mcap[chainSlug] = onChainMcap[chain];
    aggregatemcap += Number(onChainMcap[chain]);
  });

  const activemcap: { [chain: string]: string } = {};
  let aggregatedactivemcap = 0;
  Object.keys(activeMcap ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    activemcap[chainSlug] = activeMcap[chain];
    aggregatedactivemcap += Number(activeMcap[chain]);
  });

  const totalsupply: { [chain: string]: string } = {};
  Object.keys(totalSupply ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    totalsupply[chainSlug] = String(totalSupply![chain]);
  });

  return {
    timestamp,
    id,
    defiactivetvl: JSON.stringify(defiactivetvl),
    mcap: JSON.stringify(mcap),
    activemcap: JSON.stringify(activemcap),
    totalsupply: JSON.stringify(totalsupply),
    aggregatedefiactivetvl,
    aggregatemcap,
    aggregatedactivemcap,
  };
}

export type StoreHistoricalOptions = {
  skipAssetMoveGuard?: boolean;
  skipCompletenessGuard?: boolean;
};

const DEFAULT_MIN_WRITE_RATIO = 0.8;

function getMinWriteRatio(): number {
  const ratio = Number(process.env.RWA_MIN_WRITE_RATIO);
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_MIN_WRITE_RATIO;
}

function getRwaLabel(item: any, id: string): string {
  return item?.ticker || item?.canonicalMarketId || item?.name || id;
}

function shouldRunAssetMoveGuard(item: any): boolean {
  // Governance/protocol tokens can move >10% from ordinary market-price action.
  // The guard is meant for supply/metadata shocks in asset-style RWA rows.
  return item?.governance !== true;
}

function getErrorMessage(error: any): string {
  return error?.stack || error?.message || String(error);
}

function hasPositiveAggregate(row: any): boolean {
  if (!row) return false;
  return Number(row.aggregatemcap) > 0 || Number(row.aggregatedactivemcap) > 0;
}

// Resolve the per-asset baseline the move guard compares each incoming row
// against. The baseline must outlive both the 2-day hourly eviction in
// storeHistoricalPG and the prev<=0 "absorbing state": while the guard keeps
// blocking a broken asset, no fresh hourly row is written for it, so its
// last-good hourly row eventually ages out and the guard loses its only
// baseline (findRwaAssetMoveTrips skips ids with no previous), silently letting
// the next 0 through. Fast path = latest hourly when still positive (unchanged
// behaviour); otherwise fall back to the most recent positive daily row, which
// the backbone never evicts.
async function resolveGuardBaselines(ids: string[]): Promise<{ [id: string]: any }> {
  const latestHourly = await fetchLatestRwaRowsForIds(ids);
  const needFallback = ids.filter((id) => !hasPositiveAggregate(latestHourly[id]));
  const lastGoodDaily = needFallback.length
    ? await fetchLastPositiveDailyRowsForIds(needFallback)
    : {};

  const baselines: { [id: string]: any } = {};
  for (const id of ids) {
    const hourly = latestHourly[id];
    baselines[id] = hasPositiveAggregate(hourly) ? hourly : (lastGoodDaily[id] ?? hourly);
  }
  return baselines;
}

// Store historical data
export async function storeHistorical(
  res: { data: { [id: string]: AtvlPerIdData }, timestamp: number },
  options: StoreHistoricalOptions = {}
): Promise<void> {
  const { data, timestamp } = res;
  if (Object.keys(data).length == 0) return;

  const inserts: AtvlInsert[] = [];
  await runInPromisePool({
    items: Object.keys(data),
    concurrency: 5,
    processor: async (id: any) => {
      const insert = buildAtvlInsert(id, data[id], timestamp);
      if (
        isNaN(insert.timestamp) || isNaN(Number(insert.id)) ||
        isNaN(insert.aggregatedefiactivetvl) || isNaN(insert.aggregatemcap) || isNaN(insert.aggregatedactivemcap)
      ) {
        try {
          await sendThrottledRwaAlert({
            alertKey: `historicalInvalidInsert:${id}`,
            message: `ERROR ON ID ${id}`,
            formatted: false,
          });
        } catch (alertError) {
          console.error('[RWA historical] Failed to send invalid insert alert:', (alertError as any)?.message);
        }
        throw new Error(`ERROR ON ID ${id}`);
      }
      inserts.push(insert);
    },
  });

  await initPG();

  let insertsToStore = inserts;
  const guardOptions = getRwaAssetMoveGuardOptionsFromEnv();
  if (!options.skipAssetMoveGuard && guardOptions.enabled) {
    try {
      const guardedInserts = inserts.filter((insert) => shouldRunAssetMoveGuard(data[insert.id]));
      const previousById = await resolveGuardBaselines(guardedInserts.map((insert) => insert.id));
      const labelsById: { [id: string]: string } = {};
      for (const id of Object.keys(data)) labelsById[id] = getRwaLabel(data[id], id);
      const guardResult = await filterRwaAssetMoveGuardInserts({
        inserts: guardedInserts,
        previousById,
        labelsById,
        options: guardOptions,
      });
      insertsToStore = inserts.filter((insert) => !guardResult.blockedIds.has(insert.id));
      if (guardResult.blockedIds.size) {
        console.warn(
          `[RWA asset move guard] Blocked writes for ${guardResult.blockedIds.size} IDs: ${Array.from(guardResult.blockedIds).join(', ')}`
        );
      }
    } catch (error) {
      const message = `RWA asset move guard failed while evaluating historical rows; historical DB writes skipped. Error: ${getErrorMessage(error)}`;
      console.error(`[RWA asset move guard] ${message}`);
      try {
        await sendThrottledRwaAlert({
          alertKey: 'assetMoveGuardEvaluationFailure',
          message,
          formatted: false,
        });
      } catch (alertError) {
        console.error('[RWA asset move guard] Failed to send guard failure alert:', (alertError as any)?.message);
      }
      return;
    }
  }

  if (!insertsToStore.length) {
    console.warn('[RWA asset move guard] No RWA historical inserts left to store after guard filtering');
    return;
  }

  // Completeness guard: a full daily run should write roughly as many rows as
  // recent days. A large shortfall means a partial/incomplete run — abort the
  // ENTIRE write (so we never persist a gap), alert Discord, and throw.
  if (!options.skipCompletenessGuard) {
    const baseline = await fetchRecentMaxDailyRowCount(timestamp);
    const minRatio = getMinWriteRatio();
    if (baseline > 0 && insertsToStore.length < minRatio * baseline) {
      const pct = ((insertsToStore.length / baseline) * 100).toFixed(0);
      const message =
        `Daily-write completeness guard tripped - NOTHING written for ${new Date(timestamp * 1000).toISOString().slice(0, 10)}.\n` +
        `About to write ${insertsToStore.length} rows vs recent peak ${baseline} (${pct}%, floor ${(minRatio * 100).toFixed(0)}%).\n` +
        `Likely a partial run (e.g. upstream price glitch mass-tripping the asset-move guard). ` +
        `Investigate, then backfill via cli/interpolateMissingRwaDays.ts.`;
      console.error(`[RWA completeness guard] ${message}`);
      try {
        await sendRwaAlert(message, { formatted: false });
      } catch (alertError) {
        console.error('[RWA completeness guard] Failed to send alert:', (alertError as any)?.message);
      }
      throw new Error(`RWA daily-write completeness guard tripped: ${insertsToStore.length}/${baseline} rows`);
    }
  }

  await storeHistoricalPG(insertsToStore, timestamp);
}

// Store metadata
export async function storeMetadata(res: { data: { [id: string]: { [key: string]: any } } }): Promise<void> {
  const { data } = res;
  if (Object.keys(data).length == 0) return;

  const inserts = Object.keys(data).map((id: any) => {
    const { [RWA_KEY_MAP.activeMcap]: activeMcap, [RWA_KEY_MAP.onChain]: onChain, [RWA_KEY_MAP.defiActive]: defiActive, ...rest } = data[id];
    return { id, data: JSON.stringify(rest) };
  });
  await initPG();
  await storeMetadataPG(inserts);
}
