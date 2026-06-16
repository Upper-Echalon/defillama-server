import {
  filterRwaAssetMoveGuardInserts,
  findRwaAssetMoveTrips,
  formatRwaAssetMoveGuardMessage,
  RwaAssetMoveGuardOptions,
} from './assetMoveGuard';
import { getAssetMoveAck, AssetMoveAck } from './assetMoveAcks';

const baseOptions: RwaAssetMoveGuardOptions = {
  enabled: true,
  blockWrites: true,
  minDelta: 5_000_000,
  minRatio: 0.10,
  maxContributors: 3,
  minIntervalMs: 4 * 60 * 60 * 1000,
  maxPriceDrift: 2,
};

describe('rwa asset move guard', () => {
  it('detects per-asset mcap moves that cross both absolute and percentage thresholds', () => {
    const trips = findRwaAssetMoveTrips(
      [{
        id: '89',
        aggregatemcap: 1_373_000_000,
        aggregatedactivemcap: 617_000_000,
        mcap: { ethereum: 994_000_000, plume_mainnet: 0, sei: 0 },
        activemcap: { ethereum: 231_000_000, plume_mainnet: 0, sei: 0 },
      }],
      {
        '89': {
          id: '89',
          aggregatemcap: 2_142_000_000,
          aggregatedactivemcap: 1_392_000_000,
          mcap: { ethereum: 994_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
          activemcap: { ethereum: 231_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
        },
      },
      { '89': 'USDY' },
      baseOptions
    );

    expect(trips).toHaveLength(2);
    expect(trips.map((trip) => trip.metric).sort()).toEqual(['activeMcap', 'onChainMcap']);
    expect(trips[0].direction).toBe('down');
    expect(trips[0].contributors[0]).toEqual({
      chain: 'plume_mainnet',
      previous: 505_000_000,
      current: 0,
      delta: -505_000_000,
    });
  });

  it('does not trip when only one threshold is crossed or previous value is zero', () => {
    const trips = findRwaAssetMoveTrips(
      [
        {
          id: 'small-ratio',
          aggregatemcap: 106_000_000,
          aggregatedactivemcap: 100_000_000,
        },
        {
          id: 'small-delta',
          aggregatemcap: 14_000_000,
          aggregatedactivemcap: 10_000_000,
        },
        {
          id: 'new-asset',
          aggregatemcap: 20_000_000,
          aggregatedactivemcap: 20_000_000,
        },
      ],
      {
        'small-ratio': { id: 'small-ratio', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 },
        'small-delta': { id: 'small-delta', aggregatemcap: 10_000_000, aggregatedactivemcap: 10_000_000 },
        'new-asset': { id: 'new-asset', aggregatemcap: 0, aggregatedactivemcap: 0 },
      },
      {},
      baseOptions
    );

    expect(trips).toHaveLength(0);
  });

  it('blocks only the tripped asset and sends one alert per asset id', async () => {
    const sendAlert = jest.fn(async (_alertKey: string, _message: string) => {});
    const result = await filterRwaAssetMoveGuardInserts({
      inserts: [
        { id: '89', aggregatemcap: 80_000_000, aggregatedactivemcap: 80_000_000 },
        { id: '90', aggregatemcap: 11_000_000, aggregatedactivemcap: 11_000_000 },
      ],
      previousById: {
        '89': { id: '89', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 },
        '90': { id: '90', aggregatemcap: 10_000_000, aggregatedactivemcap: 10_000_000 },
      },
      labelsById: { '89': 'USDY', '90': 'TBILL' },
      options: baseOptions,
      sendAlert,
    });

    expect(result.blockedIds).toEqual(new Set(['89']));
    expect(result.allowedInserts.map((insert) => insert.id)).toEqual(['90']);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const [[alertKey, message]] = sendAlert.mock.calls;
    expect(alertKey).toBe('assetMoveGuard:89:activeMcap:down,onChainMcap:down');
    expect(message).toContain('USDY#89');
    expect(message).toContain('WRITE BLOCKED');
  });

  it('can alert without blocking writes', async () => {
    const result = await filterRwaAssetMoveGuardInserts({
      inserts: [{ id: '89', aggregatemcap: 80_000_000, aggregatedactivemcap: 80_000_000 }],
      previousById: { '89': { id: '89', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 } },
      options: { ...baseOptions, blockWrites: false },
      sendAlert: jest.fn(async (_alertKey: string, _message: string) => {}),
    });

    expect(result.blockedIds.size).toBe(0);
    expect(result.allowedInserts.map((insert) => insert.id)).toEqual(['89']);
  });

  it('does NOT trip a real redemption: mcap and supply drop together at a stable price (rUSDY case)', () => {
    // rUSDY: $1.36B -> ~$12M because supply unwrapped 1.36B -> 12M tokens; price stays ~$1.
    const trips = findRwaAssetMoveTrips(
      [{
        id: '385',
        aggregatemcap: 12_000_000,
        aggregatedactivemcap: 12_000_000,
        totalsupply: { ethereum: 12_000_000 },
      }],
      {
        '385': {
          id: '385',
          aggregatemcap: 1_356_000_000,
          aggregatedactivemcap: 1_356_000_000,
          totalsupply: { ethereum: 1_356_000_000 },
        },
      },
      { '385': 'rUSDY' },
      baseOptions
    );
    expect(trips).toHaveLength(0); // supply corroborates the move -> not a glitch
  });

  it('STILL trips when mcap drops but supply does not (the desync/glitch signature)', () => {
    // mcap frozen-vs-collapse without a matching supply move => implied price jumps => block.
    const trips = findRwaAssetMoveTrips(
      [{
        id: '385',
        aggregatemcap: 12_000_000,
        aggregatedactivemcap: 12_000_000,
        totalsupply: { ethereum: 1_356_000_000 }, // supply unchanged while mcap collapsed
      }],
      {
        '385': {
          id: '385',
          aggregatemcap: 1_356_000_000,
          aggregatedactivemcap: 1_356_000_000,
          totalsupply: { ethereum: 1_356_000_000 },
        },
      },
      { '385': 'rUSDY' },
      baseOptions
    );
    expect(trips.length).toBeGreaterThan(0);
  });

  it('falls back to normal blocking when supply data is absent (no corroboration possible)', () => {
    const trips = findRwaAssetMoveTrips(
      [{ id: '89', aggregatemcap: 80_000_000, aggregatedactivemcap: 80_000_000 }],
      { '89': { id: '89', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 } },
      { '89': 'USDY' },
      baseOptions
    );
    expect(trips.length).toBeGreaterThan(0); // unchanged behaviour without supply
  });

  it('formats a concise message with thresholds and contributors', () => {
    const message = formatRwaAssetMoveGuardMessage('89', [{
      id: '89',
      label: 'USDY',
      metric: 'onChainMcap',
      previous: 2_142_000_000,
      current: 1_373_000_000,
      delta: -769_000_000,
      ratio: -0.359,
      direction: 'down',
      contributors: [{ chain: 'sei', previous: 257_000_000, current: 0, delta: -257_000_000 }],
    }], baseOptions);

    expect(message).toContain('USDY#89');
    expect(message).toContain('WRITE BLOCKED');
    expect(message).toContain('sei');
    expect(message).toContain('-35.9%');
  });
});

describe('rwa asset move acknowledgements', () => {
  // A drop-to-~$0 price-gap on a known asset, banded to the down direction and a
  // ~zero current value.
  const gapTrip = {
    id: '94',
    label: 'FIUSD',
    metric: 'onChainMcap' as const,
    previous: 5_000_000,
    current: 0,
    delta: -5_000_000,
    ratio: -1,
    direction: 'down' as const,
    contributors: [],
  };
  const ack: AssetMoveAck = {
    id: '94',
    metrics: ['onChainMcap', 'activeMcap'],
    direction: 'down',
    maxCurrentUsd: 1,
    note: 'known price-feed gap',
  };

  it('matches a banded ack only for the right id, direction and value band', () => {
    expect(getAssetMoveAck('94', [gapTrip], [ack])).toBe(ack);
    // wrong id
    expect(getAssetMoveAck('95', [{ ...gapTrip, id: '95' }], [ack])).toBeUndefined();
    // current value above the band (gap resolved + a real partial move) -> alert
    expect(getAssetMoveAck('94', [{ ...gapTrip, current: 3_000_000, delta: -2_000_000, ratio: -0.4 }], [ack])).toBeUndefined();
    // an unrelated UP move on the same id -> alert
    expect(getAssetMoveAck('94', [{ ...gapTrip, direction: 'up', current: 9_000_000, delta: 4_000_000, ratio: 0.8 }], [ack])).toBeUndefined();
  });

  it('requires EVERY trip to match (a partially-new move still alerts)', () => {
    const freshTrip = { ...gapTrip, metric: 'activeMcap' as const, current: 4_000_000, delta: -1_000_000, ratio: -0.2 };
    expect(getAssetMoveAck('94', [gapTrip, freshTrip], [ack])).toBeUndefined();
  });

  it('suppresses the alert for an acked move but STILL blocks the write', async () => {
    const sendAlert = jest.fn(async (_alertKey: string, _message: string) => {});
    const result = await filterRwaAssetMoveGuardInserts({
      inserts: [{ id: '94', aggregatemcap: 0, aggregatedactivemcap: 0, mcap: { arbitrum: 0 } }],
      previousById: { '94': { id: '94', aggregatemcap: 5_000_000, aggregatedactivemcap: 5_000_000, mcap: { arbitrum: 5_000_000 } } },
      labelsById: { '94': 'FIUSD' },
      options: baseOptions,
      acks: [ack],
      sendAlert,
    });

    expect(sendAlert).not.toHaveBeenCalled();        // alert muted
    expect(result.blockedIds.has('94')).toBe(true);  // write still blocked
    expect(result.allowedInserts.map((i) => i.id)).toEqual([]);
  });

  it('still alerts for a non-acked asset', async () => {
    const sendAlert = jest.fn(async (_alertKey: string, _message: string) => {});
    await filterRwaAssetMoveGuardInserts({
      inserts: [{ id: '99', aggregatemcap: 0, aggregatedactivemcap: 0, mcap: { ethereum: 0 } }],
      previousById: { '99': { id: '99', aggregatemcap: 50_000_000, aggregatedactivemcap: 50_000_000, mcap: { ethereum: 50_000_000 } } },
      options: baseOptions,
      acks: [ack],
      sendAlert,
    });

    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});
