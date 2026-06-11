import { getApi } from "../utils/sdk";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList, getTokenAndRedirectData } from "../utils/database";

// wrappers are non-upgradeable and 1:1 with collateral tokens
export default async function getTokenPrices(timestamp: number = 0, writes: Write[] = []) {
  const chain = 'hyperliquid';
  const factory = '0x08d0f806d04f8790e322f830a32bb98d28105c39';
  const api = await getApi(chain, timestamp)

  const wrappers: string[] = await api.call({ target: factory, abi: 'address[]:getAllWrappers' })
  const [underlyings, symbols, decimals] = await Promise.all([
    api.multiCall({ abi: 'address:underlyingToken', calls: wrappers.map((w: string) => ({ target: w })), permitFailure: true }),
    api.multiCall({ abi: 'string:symbol', calls: wrappers, permitFailure: true }),
    api.multiCall({ abi: 'uint8:decimals', calls: wrappers, permitFailure: true }),
  ])

  const underlyingList = underlyings.filter(Boolean).map((u: string) => u.toLowerCase())
  const underlyingData = await getTokenAndRedirectData(underlyingList, chain, timestamp)
  const priceMap: { [address: string]: any } = {}
  underlyingData.forEach((d: any) => { priceMap[d.address] = d })

  wrappers.forEach((wrapper: string, i: number) => {
    const underlying = underlyings[i]
    if (!underlying) return
    const data = priceMap[underlying.toLowerCase()]
    if (!data || !data.price) return // skip wrappers with unpriced underlying
    if (decimals[i] == null || !symbols[i]) return
    addToDBWritesList(
      writes,
      chain,
      wrapper,
      data.price,
      decimals[i],
      symbols[i],
      timestamp,
      'hyperbeat-wrapper',
      data.confidence ?? 0.9,
    )
  })

  return writes
}
