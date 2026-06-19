
import axios from "axios";
import { getAllAirtableRecords } from "../../utils/airtable"
import protocols, { protocolsById, parentChildProtocolMap, _InternalProtocolMetadataMap, } from '../../protocols/data'
import parentProtocols, { parentProtocolsById } from '../../protocols/parentProtocols'
import { deadChainsSet } from '../../config/deadChains'
import { chainCoingeckoIds, getChainDisplayName } from '../../utils/normalizeChain'
import loadAdaptorsData from '../../adaptors/data'
import { ADAPTER_TYPES } from '../../adaptors/types'
import { baseIconsUrl } from '../../constants'

type GraveyardEntry = {
  Name?: string
  'DefiLlama ID'?: string
  Date?: string
  'Shutdown Date'?: string
  'Announcement Link'?: string
  Notes?: string
  // why this entry is considered dead - an entry can match several sources
  indicators: string[]
  // enriched fields (filled in if linkable to a Defillama metadata record)
  category?: string
  chains?: string[]
  website?: string
  logo?: string | null
  currentTvl?: number
}

// turn an "https://icons.llama.fi/..." url into the cdn variant used elsewhere
function getLlamaoLogo(logo?: string | null) {
  if (!logo) return logo ?? null
  if (logo.includes('chains')) return logo.replace("https://icons.llama.fi/", "https://icons.llamao.fi/icons/")
  return logo.replace("https://icons.llama.fi/", "https://icons.llamao.fi/icons/protocols/")
}

function getChainLogoKey(chainName: string) {
  if (chainName.toLowerCase() === 'bsc') return 'binance'
  return chainName.toLowerCase()
}

// map a chain config key (lower-cased, as used in deadChains / dimension adapters)
// to its display-name entry in chainCoingeckoIds
const chainKeyToName: Record<string, { name: string, obj: any }> = {}
Object.entries(chainCoingeckoIds).forEach(([name, obj]: [string, any]) => {
  const key = name.toLowerCase()
  if (!chainKeyToName[key]) chainKeyToName[key] = { name, obj }
})

function enrichFromChain(entry: GraveyardEntry, chainKey: string) {
  const match = chainKeyToName[chainKey.toLowerCase()]
  if (!match) return
  const { name, obj } = match
  const displayName = getChainDisplayName(name, true)
  if (!entry.Name) entry.Name = displayName
  entry.category = 'Chain'
  entry.chains = [displayName]
  if (obj.url && !obj.deadUrl) entry.website = obj.url
  entry.logo = getLlamaoLogo(`${baseIconsUrl}/chains/rsz_${getChainLogoKey(name)}.jpg`)
}

function enrichFromProtocol(entry: GraveyardEntry, protocol: any) {
  if (!protocol) return
  if (!entry.Name) entry.Name = protocol.name
  const meta = _InternalProtocolMetadataMap[protocol.id]
  const category = meta?.category ?? protocol.category
  if (category) entry.category = category
  if (protocol.chains?.length) entry.chains = protocol.chains
  else if (protocol.chain) entry.chains = [protocol.chain]
  // url is blanked out for deadUrl/rugged protocols, fall back to original if present
  if (protocol.url) entry.website = protocol.url
  if (protocol.logo) entry.logo = getLlamaoLogo(protocol.logo)
}

// enrich a graveyard entry using its "DefiLlama ID" (numeric protocol id, parent#slug, or chain#slug)
function enrichEntry(entry: GraveyardEntry, tvlById: Record<string, number>) {
  const id = entry['DefiLlama ID']
  if (!id) return
  if (id.startsWith('chain#')) {
    enrichFromChain(entry, id.slice('chain#'.length))
  } else if (id.startsWith('parent#')) {
    enrichFromProtocol(entry, parentProtocolsById[id])
  } else {
    enrichFromProtocol(entry, protocolsById[id])
  }
  if (tvlById[id] !== undefined) entry.currentTvl = tvlById[id]
}

// a (child) protocol is considered dead if its tvl adapter is dead or its url is dead
function isProtocolDead(protocol: any): boolean {
  return !!(_InternalProtocolMetadataMap[protocol.id]?.isDead || protocol.deadFrom || protocol.deadUrl === true)
}

async function getDeadDimensionAdapterIds(): Promise<Set<string>> {
  const deadIds = new Set<string>()
  await Promise.all(ADAPTER_TYPES.map(async (adapterType) => {
    try {
      const { protocolAdaptors } = loadAdaptorsData(adapterType)
      protocolAdaptors.forEach((p: any) => {
        if (p.isDead && p.defillamaId) deadIds.add(String(p.defillamaId))
      })
    } catch (e) {
      console.log(`Error loading dimensions data for ${adapterType}:`, (e as Error).message)
    }
  }))
  return deadIds
}

// current tvl per defillama id (numeric & parent#) from the public protocols dataset
async function getCurrentTvlById(): Promise<Record<string, number>> {
  const tvlById: Record<string, number> = {}
  try {
    const { data } = await axios.get('https://defillama-datasets.llama.fi/lite/v2/protocols')
    const list: any[] = Array.isArray(data) ? data : (data.protocols ?? [])
    for (const p of list) {
      if (p?.id !== undefined && typeof p.tvl === 'number') tvlById[String(p.id)] = p.tvl
    }
  } catch (e) {
    console.log("Error fetching current tvl dataset:", (e as Error).message)
  }
  return tvlById
}

export async function generateGraveyard() {

  // entries keyed by DefiLlama ID so multiple sources accumulate onto one entry
  const byId: Record<string, GraveyardEntry> = {}
  // curated rows without a DefiLlama ID can't be deduped, keep them separately
  const unkeyed: GraveyardEntry[] = []

  const addIndicator = (id: string, indicator: string, base?: Partial<GraveyardEntry>) => {
    if (!byId[id]) byId[id] = { 'DefiLlama ID': id, indicators: [], ...base }
    const entry = byId[id]
    if (base) for (const [k, v] of Object.entries(base)) if ((entry as any)[k] === undefined) (entry as any)[k] = v
    if (!entry.indicators.includes(indicator)) entry.indicators.push(indicator)
  }

  // 1. curated records from airtable (the original source)
  let curatedCount = 0
  try {
    const records = await getAllAirtableRecords('appGpVsrkpqsZ9qHH/tblPMzuRf2pWlUvao')
    curatedCount = records.length
    for (const record of records) {
      const fields = record.fields as GraveyardEntry
      const id = fields['DefiLlama ID']
      if (id) {
        addIndicator(id, 'curated', fields)
      } else {
        unkeyed.push({ ...fields, indicators: ['curated'] })
      }
    }
  } catch (e) {
    console.log("Error fetching Airtable records:", e)
  }

  // 2. dead chains from config
  for (const chainKey of deadChainsSet) {
    addIndicator(`chain#${chainKey}`, 'deadChains')
  }

  // 3. protocols whose metadata has deadUrl set, and/or whose tvl adapter is marked dead
  for (const protocol of protocols) {
    const isTvlDead = _InternalProtocolMetadataMap[protocol.id]?.isDead || !!(protocol as any).deadFrom
    const isDeadUrl = (protocol as any).deadUrl === true
    if (isTvlDead) addIndicator(protocol.id, 'tvlAdapterDead')
    if (isDeadUrl) addIndicator(protocol.id, 'deadUrl')
  }

  // 3b. parent protocols flagged deadUrl
  for (const parent of parentProtocols) {
    if ((parent as any).deadUrl === true) addIndicator(parent.id, 'deadUrl')
  }

  // 4. dimensions adapters marked dead
  const deadDimensionIds = await getDeadDimensionAdapterIds()
  for (const id of deadDimensionIds) {
    addIndicator(id, 'dimensionsAdapterDead')
  }

  // 5. reconcile parent protocols against their children:
  //    - a parent is dead ONLY if every one of its children is dead. In that case
  //      we represent the whole family by the parent and drop the child entries.
  //    - if even one child is still alive the parent is NOT dead, so we remove it
  //      from the graveyard (e.g. it was flagged deadUrl but a sister is live).
  const deadParents: { id: string, name?: string, children: string[] }[] = []
  const filteredChildren: { id: string, name?: string, parent: string }[] = []
  for (const parent of parentProtocols) {
    const children = parentChildProtocolMap[parent.id] ?? []
    if (!children.length) continue
    const allChildrenDead = children.every(isProtocolDead)
    if (allChildrenDead) {
      addIndicator(parent.id, 'allChildrenDead')
      // drop the individual dead children, the parent now represents them
      for (const child of children) {
        if (byId[child.id]) {
          delete byId[child.id]
          filteredChildren.push({ id: child.id, name: child.name, parent: parent.id })
        }
      }
      deadParents.push({ id: parent.id, name: parent.name, children: children.map((c: any) => c.id) })
    } else if (byId[parent.id]) {
      // a sister protocol is still alive -> the parent is not dead
      delete byId[parent.id]
    }
  }

  // enrich every entry (including curated) with metadata + current tvl where linkable
  const tvlById = await getCurrentTvlById()
  const entries = [...Object.values(byId), ...unkeyed]
  for (const entry of entries) enrichEntry(entry, tvlById)

  console.log(`Generated graveyard with ${entries.length} entries (${curatedCount} curated)`)

  console.log(`\nDead parents (all children dead): ${deadParents.length}`)
  // for (const p of deadParents)
  //   console.log(`  - ${p.name ?? p.id} (${p.id}) — ${p.children.length} children`)

  console.log(`\nFiltered-out children (folded into a dead parent): ${filteredChildren.length}`)
  // for (const c of filteredChildren)
  //   console.log(`  - ${c.name ?? c.id} (${c.id}) -> ${c.parent}`)

  return entries
}
