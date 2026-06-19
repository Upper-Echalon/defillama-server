/**
 * READ-ONLY audit of starknet key normalization in ClickHouse. Writes NOTHING.
 *
 *   ts-node --transpile-only src/cli/auditStarknetKeys.ts [--json <path>] [--all]
 *
 * Groups every starknet token_addresses row by the REAL underlying address
 * (handling the `0xstarknet:0x..` double-prefix corruption from the old
 * lowercaseAddress bug) and classifies each asset:
 *
 *   SPLIT    address forms point to DIFFERENT canonical_ids (real mismap — pick one)
 *   GARBAGE  at least one variant address is malformed (0xstarknet:.. etc.)
 *   DUPFORM  padded + stripped forms, same canonical_id (benign; just needs all
 *            forms present in the Redis mapping so either request resolves)
 *
 * The canonical_id is NOT rewritten — it is whatever the token already uses
 * (usually a coingecko id). The goal is to make every form point at the one
 * correct existing id.
 */
import { chQueryJSON } from "../utils/clickhouseClient";
import { canonicalizeStarknetAddress, padAddress } from "../utils/coingeckoPlatforms";
import { writeFileSync } from "fs";

type AddrRow = { address: string; canonical_id: string; symbol: string; decimals: number };
type CidStat = { latest: number; rows: number };

const WELLFORMED = /^0x[0-9a-f]{1,64}$/;

// Pull the trailing 0x<hex> out of any value (fixes `0xstarknet:0x00ab..`), then
// pad+strip to the canonical stripped felt. This is the real asset identity.
function realAddress(addr: string): string {
  const m = addr.match(/0x[0-9a-f]+$/i);
  const hex = m ? m[0].toLowerCase() : addr.toLowerCase();
  return canonicalizeStarknetAddress(padAddress(hex));
}

function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
  if (jsonIdx >= 0 && !jsonPath) throw new Error("--json requires a path argument");
  const activeFilter = args.includes("--all") ? "" : "AND is_active = 1";

  const res = await chQueryJSON(
    `SELECT address, canonical_id, symbol, decimals
       FROM token_addresses WHERE chain = 'starknet' ${activeFilter}`,
  );
  const rows: AddrRow[] = res.data.map((r: any[]) => ({
    address: String(r[0]).toLowerCase(),
    canonical_id: String(r[1]),
    symbol: r[2] ?? "",
    decimals: parseInt(r[3]) || 0,
  }));

  // Price coverage per canonical_id. toUnixTimestamp avoids the DateTime->NaN bug.
  const cids = [...new Set(rows.map((r) => r.canonical_id))];
  const stat = new Map<string, CidStat>();
  for (const part of chunk(cids, 400)) {
    const inList = part.map((c) => `'${c.replace(/'/g, "")}'`).join(",");
    const pr = await chQueryJSON(
      `SELECT canonical_id, toUnixTimestamp(max(timestamp)) AS latest, count() AS rows
         FROM coins_prices WHERE canonical_id IN (${inList}) GROUP BY canonical_id`,
    );
    for (const row of pr.data) stat.set(String(row[0]), { latest: Number(row[1]), rows: Number(row[2]) });
  }

  const groups = new Map<string, AddrRow[]>();
  for (const r of rows) {
    const k = realAddress(r.address);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const now = Math.floor(Date.now() / 1000);
  const fresh = (cid: string) => { const s = stat.get(cid); return s ? now - s.latest < 24 * 3600 : false; };

  const split: any[] = [], garbage: any[] = [], dupform: any[] = [];
  for (const [real, variants] of groups) {
    const cidsHere = [...new Set(variants.map((v) => v.canonical_id))];
    const hasGarbage = variants.some((v) => !WELLFORMED.test(v.address));
    // dominant id = most price rows (the one actually carrying history)
    const dominant = cidsHere.slice().sort((a, b) => (stat.get(b)?.rows ?? 0) - (stat.get(a)?.rows ?? 0))[0];
    const entry = {
      symbol: variants[0].symbol,
      realAddress: real,
      canonicalForm: `starknet:${real}`,
      distinctCids: cidsHere.map((c) => ({ cid: c, rows: stat.get(c)?.rows ?? 0, fresh: fresh(c) })),
      dominantCid: dominant,
      variants: variants.map((v) => ({ address: v.address, canonical_id: v.canonical_id, wellformed: WELLFORMED.test(v.address) })),
    };
    if (cidsHere.length > 1) split.push(entry);
    else if (hasGarbage) garbage.push(entry);
    else if (variants.length > 1) dupform.push(entry);
  }

  console.log(`\n=== starknet key audit ===`);
  console.log(`address rows        : ${rows.length}`);
  console.log(`real assets         : ${groups.size}`);
  console.log(`SPLIT  (mismapped)  : ${split.length}   <- pick the correct id`);
  console.log(`GARBAGE (0xstarknet) : ${garbage.length}   <- malformed rows to clean`);
  console.log(`DUPFORM (benign)    : ${dupform.length}   <- padded+stripped, same id\n`);

  const show = (title: string, list: any[]) => {
    if (!list.length) return;
    console.log(`--- ${title} ---`);
    for (const a of list.slice(0, 60)) {
      console.log(`${(a.symbol || "?").padEnd(10)} ${a.canonicalForm}  dominant=${a.dominantCid}`);
      for (const c of a.distinctCids) console.log(`   id ${c.cid}  rows=${c.rows}${c.fresh ? " FRESH" : ""}`);
      for (const v of a.variants) console.log(`   addr ${v.address}${v.wellformed ? "" : "  ⚠MALFORMED"} -> ${v.canonical_id}`);
    }
    if (list.length > 60) console.log(`... and ${list.length - 60} more`);
    console.log("");
  };
  show("SPLIT", split);
  show("GARBAGE", garbage);

  if (jsonPath) {
    try {
      writeFileSync(jsonPath, JSON.stringify({ generatedAt: now, summary: { rows: rows.length, assets: groups.size, split: split.length, garbage: garbage.length, dupform: dupform.length }, split, garbage, dupform }, null, 2));
      console.log(`full report -> ${jsonPath}`);
    } catch (e) {
      throw new Error(`failed to write report to ${jsonPath}: ${(e as Error).message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
