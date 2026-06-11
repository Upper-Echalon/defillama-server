import { successResponse, wrap, IResponse, errorResponse } from "./utils/shared";
import protocols, { Protocol} from "./protocols/data";
import { getLastRecord, hourlyUsdTokensTvl } from "./utils/getLastRecord";
import { importAdapter } from "./utils/imports/importAdapter";
import { chainKeyToChainLabelMap } from "./utils/normalizeChain";

const isTokenAmountMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isValidAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isBaseChainKey = (key: string) => chainKeyToChainLabelMap[key] !== undefined;

const getMatchingTokenAmounts = (tokenTvl: Record<string, unknown>, symbol: string) => {
  const amountUsd = {} as Record<string, number>;

  Object.entries(tokenTvl).forEach(([token, value]) => {
    if (token.includes(symbol) && isValidAmount(value)) {
      amountUsd[token] = value;
    }
  });

  return amountUsd;
};

const getMatchingTokenAmountsByChain = (lastTvl: Record<string, unknown>, symbol: string) => {
  const amountUsdByChain = {} as Record<string, Record<string, number>>;

  Object.entries(lastTvl).forEach(([storeKey, tokenTvl]) => {
    if (!isBaseChainKey(storeKey) || !isTokenAmountMap(tokenTvl)) return;

    const chainAmounts = getMatchingTokenAmounts(tokenTvl, symbol);

    if (Object.keys(chainAmounts).length > 0) {
      amountUsdByChain[storeKey] = chainAmounts;
    }
  });

  return amountUsdByChain;
};

function _protocolHasMisrepresentedTokens(protocol: Protocol): boolean{
  const module = importAdapter(protocol);
  return module.misrepresentedTokens
}

async function _getLastHourlyTokensUsd(protocol: Protocol){
  return getLastRecord(hourlyUsdTokensTvl(protocol.id))
}

export async function getTokensInProtocolsInternal(symbol: string, {
  protocolList = protocols,
  getLastHourlyTokensUsd = _getLastHourlyTokensUsd,
  protocolHasMisrepresentedTokens = _protocolHasMisrepresentedTokens
} = {}){
  return (await Promise.all(
    protocolList.map(async (protocol) => {
      const lastTvl = await getLastHourlyTokensUsd(protocol);
      if(!isTokenAmountMap(lastTvl?.tvl)){
        return null
      }
      const amountUsd = getMatchingTokenAmounts(lastTvl.tvl, symbol)
      if(Object.keys(amountUsd).length === 0){
        return null
      }
      const amountUsdByChain = getMatchingTokenAmountsByChain(lastTvl, symbol)
      const misrepresentedTokens = protocolHasMisrepresentedTokens(protocol);
      return {
          name: protocol.name,
          category: protocol.category,
          amountUsd,
          amountUsdByChain,
          misrepresentedTokens,
      }
    })
  )).filter(r=>r !== null)
}

const handler = async (
  event: AWSLambda.APIGatewayEvent
): Promise<IResponse> => {
  const symbol = decodeURI(event.pathParameters?.symbol?.toUpperCase() ?? "");
  if(symbol === ""){
    return errorResponse({message: "Ser you need to provide a token"})
  }
  const protocolsIncluded = await getTokensInProtocolsInternal(symbol)
  return successResponse(protocolsIncluded, 20 * 60); // 10 mins cache
};

export default wrap(handler);
