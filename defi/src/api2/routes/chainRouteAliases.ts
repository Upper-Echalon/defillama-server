import * as HyperExpress from "hyper-express";
import { chainCoingeckoIds, getChainDisplayName, getChainIdFromDisplayName } from "../../utils/normalizeChain";
import { fileResponse } from "./utils";

const chainRoutePrefixes = ["v2/historicalChainTvl", "lite/charts", "charts"];

// chart files are only ever stored under current chain labels, so requests using
// old labels (charts/Optimism) are rewritten to the current one (charts/OP Mainnet)
export function resolveChainRoutePath(routePath: string) {
  return getAliasedChainRoutePath(routePath) ?? routePath;
}

export function chainChartFileResponse(routePath: string, res: HyperExpress.Response) {
  return fileResponse(resolveChainRoutePath(routePath), res);
}

function getAliasedChainRoutePath(routePath: string) {
  for (const prefix of chainRoutePrefixes) {
    const routePrefix = `${prefix}/`;
    if (!routePath.startsWith(routePrefix)) continue;

    const rawChainName = routePath.slice(routePrefix.length);
    if (!rawChainName || rawChainName.includes("/")) return null;

    const chainName = decodeRouteSegment(rawChainName);
    if (!chainName || chainName.includes("/")) return null;

    const chainKey = getChainIdFromDisplayName(chainName);
    const chainLabel = getChainDisplayName(chainKey, true);
    if (chainLabel === chainName || chainCoingeckoIds[chainLabel] === undefined) return null;

    return `${prefix}/${chainLabel}`;
  }

  return null;
}

function decodeRouteSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
