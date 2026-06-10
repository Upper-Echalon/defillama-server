import { successResponse, wrap, IResponse, errorResponse } from "./utils/shared";
import ddb from "./utils/shared/dynamodb";
import parseRequestBody from "./utils/shared/parseRequestBody";
import { getRecordClosestToTimestamp } from "./utils/distressedAwareRecord";
import { coinToPK, DAY } from "./utils/processCoin";
import { isDistressedAssetPK } from "./utils/isDistressed";

const handler = async (
    event: AWSLambda.APIGatewayEvent
): Promise<IResponse> => {
    const body = parseRequestBody(event.body)
    const requestedCoin = body.coin;
    const timestampsRequested = body.timestamps as number[];
    const coin = (await ddb.get({
        PK: coinToPK(requestedCoin),
        SK: 0,
    })).Item;
    if (coin === undefined) {
        return errorResponse({ message: "Coin doesn't exist" })
    }
    // Distressed contracts read $0: ignore any coingecko redirect on this PK so
    // the per-timestamp lookups resolve against the asset# PK (-> $0).
    if (isDistressedAssetPK(coin.PK)) coin.redirect = undefined;

    const response = {
        decimals: coin.decimals == null ? undefined : Number(coin.decimals),
        symbol: coin.symbol,
        prices: [] as {
            timestamp: number,
            price: number,
        }[]
    }
    await Promise.all(timestampsRequested.map(async timestampRequested => {
        const finalCoin = await getRecordClosestToTimestamp(coin.redirect ?? coin.PK, timestampRequested, DAY / 2);
        if (finalCoin?.SK === undefined) {
            return
        }
        response.prices.push({
            price: Number(finalCoin.price),
            timestamp: finalCoin.SK
        });
    }))
    return successResponse(response);
};

export default wrap(handler);
