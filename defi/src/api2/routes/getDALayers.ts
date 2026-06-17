import { IProtocol, processProtocols, TvlItem } from "../../storeGetCharts";
import { extraSections, getChainDisplayName, chainCoingeckoIds } from "../../utils/normalizeChain";
import { _InternalProtocolMetadata } from "../../protocols/data";

interface SumDailyTvls {
  [timestamp: number]: {
    [daProvider: string]: {
      [key: string]: number;
    };
  };
}

interface DAProtocols {
  [timestamp: number]: {
    [daProvider: string]: {
      [protocol: string]: {
        [chain: string]: number;
      };
    };
  };
}

interface Item {
  [key: string]: number;
}

interface IChainByDA {
  [daProvider: string]: Record<string, number>;
}

function sum(
  totalByChain: SumDailyTvls,
  total: SumDailyTvls,
  daProvider: string,
  time: number,
  item: Item = {},
  daProtocolsHistory: DAProtocols,
  protocol: IProtocol,
  chain: string | null
) {
  if (!totalByChain[time]) totalByChain[time] = {};
  if (!total[time]) total[time] = {};
  if (!daProtocolsHistory[time]) daProtocolsHistory[time] = {};

  const dataByChain = totalByChain[time][daProvider] ?? {};
  const data = total[time][daProvider] ?? {};

  if (!daProtocolsHistory[time][daProvider]) {
    daProtocolsHistory[time][daProvider] = {};
  }
  if (!daProtocolsHistory[time][daProvider][protocol.name]) {
    daProtocolsHistory[time][daProvider][protocol.name] = {};
  }

  const isOldTvlRecord = Object.keys(item).filter((item) => !["PK", "SK", "tvl"].includes(item)).length === 0;

  for (const section in item) {
    const sectionSplit = (isOldTvlRecord && section === "tvl" ? protocol.chain : section).split("-");

    if (
      ![
        "SK",
        "PK",
        "tvl",
        "tvlPrev1Week",
        "tvlPrev1Day",
        "tvlPrev1Hour",
        "Stake",
        "oec",
        "treasury_bsc",
        "Earn",
        "eth",
        "WooPP",
        "bscStaking",
        "avaxStaking",
        "pool3",
        "masterchef",
        "staking_eth",
        "staking_bsc",
      ].includes(sectionSplit[0]) &&
      (chain ? sectionSplit[0] === chain : true)
    ) {
      const sectionKey = `${getChainDisplayName(sectionSplit[0], true)}${sectionSplit[1] ? `-${sectionSplit[1]}` : ""}`;
      dataByChain[sectionKey] = (dataByChain[sectionKey] ?? 0) + item[section];

      if (extraSections.includes(section)) {
        data[section] = (data[section] ?? 0) + item[section];
      } else if (extraSections.includes(sectionSplit[1])) {
        // per-chain extra section (e.g. Base-staking) -> aggregate under its DA layer
        data[sectionSplit[1]] = (data[sectionSplit[1]] ?? 0) + item[section];
      } else if (!sectionSplit[1]) {
        data.tvl = (data.tvl ?? 0) + item[section];
      }

      daProtocolsHistory[time][daProvider][protocol.name][sectionKey] =
        (daProtocolsHistory[time][daProvider][protocol.name][sectionKey] ?? 0) + item[section];
    }
  }

  totalByChain[time][daProvider] = dataByChain;
  total[time][daProvider] = data;
}

export async function getDALayersInternal({ ...options }: any = {}) {
  const sumDailyTvls = {} as SumDailyTvls;
  const sumDailyTvlsByChain = {} as SumDailyTvls;
  const daProtocols = {} as DAProtocols;

  // Map each chain (by display name) to the DA layer it declares as its parent.
  const daByChainName: { [normalizedChain: string]: string } = {};
  Object.entries(chainCoingeckoIds).forEach(([chainName, chainData]) => {
    if (chainData.parent?.da) {
      daByChainName[getChainDisplayName(chainName, true)] = chainData.parent.da;
    }
  });

  await processProtocols(
    async (timestamp: number, item: TvlItem, protocol: IProtocol, _protocolMetadata: _InternalProtocolMetadata) => {
      try {
        const isOldTvlRecord = Object.keys(item).filter((i) => !["PK", "SK", "tvl"].includes(i)).length === 0;

        const daChainsInItem = new Map<string, string>(); // raw section chain name -> DA provider
        if (isOldTvlRecord) {
          const daProvider = protocol.chain && daByChainName[getChainDisplayName(protocol.chain, true)];
          if (daProvider) daChainsInItem.set(protocol.chain, daProvider);
        } else {
          for (const section in item) {
            const chainName = section.split("-")[0];
            const daProvider = daByChainName[getChainDisplayName(chainName, true)];
            if (daProvider) daChainsInItem.set(chainName, daProvider);
          }
        }

        for (const [chainName, daProvider] of daChainsInItem) {
          sum(sumDailyTvlsByChain, sumDailyTvls, daProvider, timestamp, item, daProtocols, protocol, chainName);
        }
      } catch (error) {
        console.log(protocol.name, error);
      }
    },
    { includeBridge: false, ...options }
  );

  const timestamps = Object.keys(daProtocols);
  const latestTimestamp = timestamps[timestamps.length - 1];

  const daTVS = latestTimestamp ? daProtocols[parseInt(latestTimestamp)] : {};

  const daTvlByChain = {} as IChainByDA;
  const latestTvlByChainByDA = Object.entries(sumDailyTvlsByChain).slice(-1)[0]?.[1] ?? {};

  for (const daProvider in latestTvlByChainByDA) {
    const chains = Object.fromEntries(
      Object.entries(latestTvlByChainByDA[daProvider] as Record<string, number>)
        .filter((c) => !c[0].includes("-") && !extraSections.includes(c[0]))
        .sort((a, b) => b[1] - a[1])
    );

    daTvlByChain[daProvider] = chains;
  }

  const finalChainsByDA: Record<string, Array<string>> = {};
  for (const daProvider in daTvlByChain) {
    finalChainsByDA[daProvider] = Object.keys(daTvlByChain[daProvider]);
  }

  return {
    chart: sumDailyTvls,
    chainChart: sumDailyTvlsByChain,
    daTVS: daTVS,
    daLayers: Object.fromEntries(
      Object.entries(daTVS).map(([daProvider, protocols]) => [daProvider, Object.keys(protocols)])
    ),
    chainsByDA: finalChainsByDA,
  };
}
