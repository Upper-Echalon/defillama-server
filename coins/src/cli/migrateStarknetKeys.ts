/**
 * Surgical starknet key fixes, driven by auditStarknetKeys.ts output. Dry-run by
 * default; writes nothing until --commit.
 *
 *   ts-node --transpile-only src/cli/migrateStarknetKeys.ts --from <audit.json> [--commit] [--garbage]
 *     --commit    actually write
 *     --garbage   give every garbage-bucket token's well-formed forms a DDB SK=0
 *                 redirect to its coingecko id, so /chart + /historical resolve
 *                 via the stripped key after the flip (fixes FXS/FRAX/LINK/...)
 *     --only SYM  run just one token (e.g. --only xtBTC) — skips the kSTRK merge
 *
 * Two operations (NOT a full-history rewrite — coingecko ids already hold price
 * history):
 *
 *   REPOINT  coingecko-backed tokens whose stripped form points at the WRONG id.
 *            Sets every well-formed address form -> the correct coingecko id
 *            (token_addresses + Redis mapping + DDB SK=0 redirect). Idempotent.
 *
 *   MERGE    adapter-priced self-split (kSTRK): two starknet:<form> ids. Copies
 *            the non-canonical id's price history onto the stripped canonical id
 *            so the read-flip doesn't orphan it.
 *
 * MUST run before the read/write flip (starknet-canonical-flip.patch): the flip
 * routes reads to the stripped form, so the stripped form must already be right.
 */
import { readFileSync } from "fs";
import ddb, { getHistoricalValues, batchWrite } from "../utils/shared/dynamodb";
import { dualWriteToChRedis } from "../adapters/utils/chRedisWrite";

const DRY = !process.argv.includes("--commit");
const doGarbage = process.argv.includes("--garbage");
const fromIdx = process.argv.indexOf("--from");
const auditPath = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;
if (fromIdx >= 0 && !auditPath) throw new Error("--from requires a path argument");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null; // run just one symbol
if (onlyIdx >= 0 && !only) throw new Error("--only requires a symbol argument");

// Confirmed corrections: token symbol -> correct coingecko id (bare slug).
const REPOINT: Record<string, string> = {
  strkBTC: "strkbtc",
  xWBTC: "endur-fi-staked-wbtc",
  // endur-fi-staked-btc has a bad/stale CG price (~$101k, +63% over BTC); track the
  // underlying tbtc until that id is reliable, then repoint back to the staked id.
  xtBTC: "tbtc",
  CASH: "opus-cash", // clean forms already correct; repoint is a safe no-op
};
// Adapter-priced self-splits: merge history onto the stripped starknet id.
const MERGE_ADAPTER = new Set(["kSTRK"]);

const pkOf = (addr: string) => `asset#starknet:${addr}`;
const WELLFORMED = /^0x[0-9a-f]{1,64}$/;

// Merge timestamp rows from several PKs keyed by SK; higher confidence wins.
// (Only used for the adapter self-split case.)
export function mergeRows(target: any[], variants: any[][]): { meta: any | null; prices: any[] } {
  const all = [target, ...variants];
  const priceBySk = new Map<number, any>();
  let meta: any | null = null, metaTs = -1;
  const targetMeta = target.find((r) => Number(r.SK) === 0);
  for (let g = 0; g < all.length; g++) {
    for (const r of all[g]) {
      const sk = Number(r.SK);
      if (sk === 0) {
        if (g === 0 && targetMeta) { meta = targetMeta; metaTs = Infinity; }
        else if ((r.timestamp ?? 0) > metaTs) { meta = r; metaTs = r.timestamp ?? 0; }
        continue;
      }
      const prev = priceBySk.get(sk);
      if (!prev || Number(r.confidence ?? 0) > Number(prev.confidence ?? 0)) priceBySk.set(sk, r);
    }
  }
  return { meta, prices: [...priceBySk.values()] };
}

async function repoint(entry: any, cgId: string, now: number) {
  const addrs: string[] = [...new Set<string>(entry.variants.filter((v: any) => WELLFORMED.test(v.address)).map((v: any) => v.address))];
  console.log(`REPOINT  ${entry.symbol.padEnd(10)} ${addrs.length} forms -> coingecko:${cgId}`);
  if (DRY) return;
  // Read each form's record first; derive decimals/symbol from ANY sibling that
  // has them (a missing stripped form must not get decimals=0 — that's the bug
  // that breaks /chart after the flip).
  const existing: Record<string, any> = {};
  let decimals: number | undefined, symbol: string | undefined;
  for (const a of addrs) {
    const item = (await ddb.get({ PK: pkOf(a), SK: 0 })).Item;
    existing[a] = item;
    if (decimals == null && item?.decimals != null) decimals = item.decimals;
    if (symbol == null && item?.symbol) symbol = item.symbol;
  }
  decimals = decimals ?? 0;
  symbol = symbol ?? entry.symbol;
  for (const a of addrs) {
    const e = existing[a] || {};
    const dec = e.decimals ?? decimals, sym = e.symbol ?? symbol;
    // DDB: keep the whole SK=0 record (or create one), only set the redirect.
    const ddbItem = { ...e, PK: pkOf(a), SK: 0, redirect: `coingecko#${cgId}`, symbol: sym, decimals: dec, timestamp: now };
    // CH/Redis: metadata-only (NO price) so token_addresses + mapping update
    // without clobbering the live coingecko price.
    const chItem = { PK: pkOf(a), SK: 0, redirect: `coingecko#${cgId}`, symbol: sym, decimals: dec, timestamp: now };
    await batchWrite([ddbItem], false);
    await dualWriteToChRedis([chItem]);
  }
}

// Coingecko id a single-cid (garbage/dupform) entry should resolve to.
function soleCgId(entry: any): string | null {
  const cg = (entry.distinctCids || []).map((c: any) => c.cid).filter((c: string) => c.startsWith("coingecko:"));
  return cg.length === 1 ? cg[0].slice("coingecko:".length) : (entry.dominantCid?.startsWith("coingecko:") ? entry.dominantCid.slice("coingecko:".length) : null);
}

async function mergeAdapter(entry: any, now: number) {
  // canonical = stripped form; sources = the other well-formed starknet forms.
  const canonicalAddr = entry.realAddress;
  const targetPK = pkOf(canonicalAddr);
  const sourceAddrs = entry.variants
    .filter((v: any) => WELLFORMED.test(v.address) && v.address !== canonicalAddr)
    .map((v: any) => v.address);
  const targetRows = await getHistoricalValues(targetPK);
  const sourceRows = await Promise.all(sourceAddrs.map((a: string) => getHistoricalValues(pkOf(a))));
  const { meta, prices } = mergeRows(targetRows, sourceRows);
  console.log(`MERGE    ${entry.symbol.padEnd(10)} ${sourceAddrs.length} src forms, ${prices.length} history rows -> ${targetPK}`);
  if (DRY) return;
  const canonicalMeta = meta ? { ...meta, PK: targetPK, SK: 0, redirect: undefined } : null;
  const priceItems = prices.map((r) => ({ ...r, PK: targetPK }));
  const aliasItems = sourceAddrs.map((a: string) => ({ PK: pkOf(a), SK: 0, redirect: targetPK, symbol: entry.symbol, timestamp: now }));
  const ddb = [...(canonicalMeta ? [canonicalMeta] : []), ...priceItems, ...aliasItems];
  await batchWrite(ddb, false);
  await dualWriteToChRedis(ddb);
}

// Ensure every well-formed form of a single-cid (garbage-bucket) token has a
// DDB SK=0 redirect to its coingecko id. Without this the stripped form can lack
// a DDB record, so /chart and /prices/historical (which read the DDB PK and
// follow `redirect`) return nothing after the flip. The malformed 0xstarknet:..
// rows are skipped (never queried; harmless).
async function fixGarbageRedirects(garbage: any[], now: number) {
  for (const entry of garbage) {
    const cgId = soleCgId(entry);
    if (!cgId) { console.log(`GARBAGE  ${entry.symbol}: no single coingecko id — skipped`); continue; }
    await repoint(entry, cgId, now);
  }
}

async function main() {
  if (!auditPath) throw new Error("pass --from <audit.json>");
  let audit: any;
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch (e) {
    throw new Error(`could not read/parse audit file ${auditPath}: ${(e as Error).message}`);
  }
  const bySymbol = (arr: any[], sym: string) => arr.find((e: any) => e.symbol === sym);
  const now = Math.floor(Date.now() / 1000);

  console.log(`\n=== starknet key migration ${DRY ? "(DRY RUN)" : "(COMMIT)"} ===\n`);

  for (const [sym, cgId] of Object.entries(REPOINT)) {
    if (only && sym !== only) continue;
    const entry = bySymbol(audit.split, sym) || bySymbol(audit.garbage, sym) || bySymbol(audit.dupform, sym);
    if (!entry) { console.log(`REPOINT  ${sym}: NOT FOUND in audit — skipped`); continue; }
    await repoint(entry, cgId, now);
  }
  for (const sym of MERGE_ADAPTER) {
    if (only && sym !== only) continue;
    const entry = bySymbol(audit.split, sym);
    if (!entry) { console.log(`MERGE    ${sym}: NOT FOUND in audit split — skipped`); continue; }
    await mergeAdapter(entry, now);
  }
  // `--only garbage` runs JUST the garbage-redirect fix (skips repoint+merge, so
  // the kSTRK history isn't re-inserted). `--garbage` with no --only runs it too.
  if ((doGarbage && !only) || only === "garbage") await fixGarbageRedirects(audit.garbage || [], now);

  console.log(`\n=== ${DRY ? "PLAN (dry run — nothing written; re-run with --commit)" : "DONE"} ===\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
