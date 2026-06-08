import { getCurrentUnixTimestamp } from "../../utils/date";

export const DEFAULT_MAX_ORACLE_AGE_SECONDS = 27 * 60 * 60;

// Business-day NAV oracles (T-bills, money-market funds, tokenized equities) only
// publish on trading days, so a Friday print must survive the weekend: Fri->Mon is
// ~72h and a 3-day holiday weekend (Fri->Tue) is ~96h. The 27h default trips every
// Monday by construction. ~100h tolerates that gap while still flagging a genuinely
// dead feed within ~4 days. NOTE: longer EU/US closures (e.g. Easter's Good Friday +
// Easter Monday, ~120h) can still trip at 100h — bump this if those recur.
export const NAV_ORACLE_MAX_AGE_SECONDS = 100 * 60 * 60;

type FreshnessOpts = {
  timestamp: number;
  maxAgeSeconds?: number;
  label?: string;
  throwIfStale?: boolean;
};

export function checkOracleFresh(
  updatedAt: number | bigint | string,
  {
    timestamp,
    maxAgeSeconds = DEFAULT_MAX_ORACLE_AGE_SECONDS,
    label = "oracle",
    throwIfStale = true,
  }: FreshnessOpts,
): boolean {
  const now = timestamp == 0 ? getCurrentUnixTimestamp() : timestamp;
  const updated = Number(updatedAt);
  const fresh = !!updated && updated >= now - maxAgeSeconds;
  if (!fresh && throwIfStale) {
    throw new Error(
      `${label} price is stale (updatedAt=${updated}, now=${now}, maxAge=${maxAgeSeconds}s)`,
    );
  }
  return fresh;
}
