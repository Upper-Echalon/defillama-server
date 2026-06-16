import type { RwaAssetMoveTrip } from './assetMoveGuard';

type AssetMoveMetric = RwaAssetMoveTrip['metric'];

// A declarative acknowledgement of a KNOWN, correctly-blocked asset move.
//
// The asset-move guard freezes an asset's last good value when it blocks a write,
// so a price-feed gap (or any genuinely-stuck situation) re-trips and re-alerts on
// EVERY cron run — producing the same lines every few hours forever. An ack mutes
// that Discord alert *without* changing the block (we still want to keep the stale
// value frozen) and *without* muting the asset for unrelated moves.
//
// The mute is fingerprinted, not blanket: it only suppresses while the blocked move
// still MATCHES the acked shape (metrics, direction, and value band). If the move
// drifts out of the band — e.g. the gap resolves and the asset then makes a real
// move, or a frozen baseline finally advances — the ack stops matching and the alert
// fires again. So you never go blind on something genuinely new.
//
// This is for self-healing gaps and known-benign blocks only. For a move the guard is
// WRONGLY blocking (a real redemption-to-zero, a real repricing like RLP), the fix is
// to let the write through (delist / corroborated-move / manual override), NOT to ack
// it — acking would hide a real value error.
export type AssetMoveAck = {
  id: string;
  // If set, every trip for the asset must be one of these metrics to be acked.
  metrics?: AssetMoveMetric[];
  // If set, every trip must move in this direction (price gaps are always 'down').
  direction?: 'up' | 'down';
  // If set, every trip's CURRENT value must be <= this (e.g. 1 for a drop-to-~$0 gap).
  maxCurrentUsd?: number;
  // If set, every trip's PREVIOUS value must be >= this (guards against acking a
  // different, smaller situation that happens to share the id).
  minPreviousUsd?: number;
  note: string;
};

// Known-correct blocks. Each is banded to a DOWN move that collapses to ~$0 (the
// signature of a feed/read dropout), so the block stays correct (last good value is
// kept) while the repeating alert is muted. The band means any real move — a partial
// decline, a recovery, or a new value once the underlying issue is fixed — leaves the
// band and re-alerts. Add/remove as situations are triaged or resolved.
//
// NOT acked on purpose (these need action, not muting — left alerting):
//   386 USDYc  — real redemption-to-0; PM is setting it 'delisted'.
//   660 RLP    — real, sustained -58% repricing; needs an unblock, not a mute.
//   4075 CMBMINT, 4090 RSC — unverified large drops; verify on-chain before acking.
//   2721 MNRL, 2976 REALU, 4049 CREV, 4063 PC0000029, 4071 ABUTF, 4076 XDFIS,
//   4083 DIA-L-COL1, 3987 EUROB, 3803 GOLDST — root cause unknown; keep alerting.
//   2984 VIDS  — fixed at source by the Aktionariat getLiquidity fail-open wrap.
//   xStock "ink" cohort (IJRx, BTBTx, MARAx, OKLOx, PALLx, PYPLx, TMUSx, WULFx, MOOx)
//     — Ink cron supply-read glitch, being fixed at source in a separate effort.
// minPreviousUsd is a low ID-collision floor, NOT a "was this asset big" gate: it only stops the
// ack from auto-muting a *different, much smaller* situation that later reuses the same id. It is
// deliberately well below the smallest acked asset's last-good mcap (FIUSD ~$335k) so every entry
// below stays muted; a real large repricing-to-~$0 is excluded by id (see the NOT-acked list above),
// not by this band. Raising it toward the millions would wrongly un-mute FIUSD/bERNX.
const DROP_TO_ZERO = { metrics: ['onChainMcap', 'activeMcap'] as AssetMoveMetric[], direction: 'down' as const, maxCurrentUsd: 1000, minPreviousUsd: 100_000 };

export const RWA_ASSET_MOVE_ACKS: AssetMoveAck[] = [
  // Coins-API price-feed gaps: the asset is priced fine normally but the feed
  // periodically returns nothing, zeroing mcap until it returns. Block keeps the
  // last good value; the alert is pure noise while gapped.
  { id: '94', ...DROP_TO_ZERO, note: 'FIUSD price-feed gap; blocked correctly, value frozen.' },
  { id: '278', ...DROP_TO_ZERO, note: 'bERNX (Backed) price-feed gap; a Backed equity to ~$0 is a feed dropout.' },
  { id: '387', ...DROP_TO_ZERO, note: 'mUSD ($1 peg) price-feed gap; a peg to ~$0 is always a dropout.' },
  { id: '433', ...DROP_TO_ZERO, note: 'USD+ ($1 peg) price-feed gap.' },
  { id: '4048', ...DROP_TO_ZERO, note: 'flUSD ($1 peg) price-feed gap.' },

  // By design: Dinari dShare with no order fills in >14d (MAX_FILL_AGE) goes unpriced.
  { id: '441', ...DROP_TO_ZERO, note: 'USFR.d Dinari dShare: no fills >14d (MAX_FILL_AGE) → unpriced by design.' },
];

function tripMatchesAck(trip: RwaAssetMoveTrip, ack: AssetMoveAck): boolean {
  if (ack.metrics && !ack.metrics.includes(trip.metric)) return false;
  if (ack.direction && trip.direction !== ack.direction) return false;
  if (ack.maxCurrentUsd != null && !(trip.current <= ack.maxCurrentUsd)) return false;
  if (ack.minPreviousUsd != null && !(trip.previous >= ack.minPreviousUsd)) return false;
  return true;
}

// An asset's grouped trips are acknowledged only when an ack entry for that id matches
// EVERY trip — so a partially-new move (one acked metric + one fresh one) still alerts.
export function getAssetMoveAck(
  id: string,
  trips: RwaAssetMoveTrip[],
  acks: AssetMoveAck[] = RWA_ASSET_MOVE_ACKS
): AssetMoveAck | undefined {
  if (!trips.length) return undefined;
  return acks.find((ack) => ack.id === id && trips.every((trip) => tripMatchesAck(trip, ack)));
}
