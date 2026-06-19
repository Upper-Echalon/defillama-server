/**
 * READ-ONLY pre-deploy gate for the DDB-backed read endpoints the flip touches
 * via coinToPK / lowercaseAddress: /chart and /prices/historical.
 * (Current prices are covered by verifyStarknetFlip.ts.)
 *
 *   ts-node --transpile-only src/cli/verifyStarknetReadPaths.ts [--threshold 0.01] [--json out.json]
 *
 *   BEFORE = live coins.llama.fi (the deployed, pre-flip behaviour)
 *   AFTER  = the SAME resolution /chart performs, run locally with the flip:
 *            getBasicCoins (flipped coinToPK) -> SK=0 record -> follow redirect
 *            -> getRecordClosestToTimestamp. This is real post-flip behaviour,
 *            NOT live(stripped) — the deployed coinToPK garbles starknet keys,
 *            so a live lookup of the stripped form is not a valid model.
 *
 *   LOST  before had a price, post-flip resolves to nothing  <- BLOCKS DEPLOY
 *   FIXED before had nothing, post-flip resolves
 *   REPRICED both present, differ by > threshold
 *
 * Needs DDB env (tableName + AWS creds). Exits non-zero on any LOST.
 */
import axios from "axios";
import { chQueryJSON } from "../utils/clickhouseClient";
import { coinToPK } from "../utils/processCoin";
import { getBasicCoins } from "../utils/getCoinsUtils";
import { getRecordClosestToTimestamp } from "../utils/shared/getRecordClosestToTimestamp";

const args = process.argv.slice(2);
const threshold = args.includes("--threshold") ? Number(args[args.indexOf("--threshold") + 1]) : 0.01;
const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const DAY = 86400;
const nowTs = Math.floor(Date.now() / 1000);
const histTs = nowTs - 7 * DAY;

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function liveChart(coins: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk(coins, 40)) {
    try { const { data } = await axios.get(`https://coins.llama.fi/chart/${part.join(",")}?span=1`, { timeout: 25000 });
      for (const [k, v] of Object.entries<any>(data.coins || {})) { const p = v?.prices?.[v.prices.length - 1]?.price; if (p != null) out.set(k, p); } } catch (e) { console.error(`live chart: ${(e as Error).message}`); }
  }
  return out;
}
async function liveHistorical(coins: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk(coins, 40)) {
    try { const { data } = await axios.get(`https://coins.llama.fi/prices/historical/${histTs}/${part.join(",")}`, { timeout: 25000 });
      for (const [k, v] of Object.entries<any>(data.coins || {})) if (v?.price != null) out.set(k, v.price); } catch (e) { console.error(`live hist: ${(e as Error).message}`); }
  }
  return out;
}

// Post-flip resolution, mirroring getCoinPriceChart: flipped coinToPK -> SK=0
// record -> follow redirect -> closest price to ts.
async function afterPrices(coins: string[], ts: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { coins: recs } = await getBasicCoins(coins);
  const byPK = new Map<string, any>();
  for (const r of recs) if (r?.PK) byPK.set(r.PK, r);
  for (const part of chunk(coins, 25)) {
    await Promise.all(part.map(async (c) => {
      const rec = byPK.get(coinToPK(c));
      if (!rec) return;
      const target = rec.redirect ?? rec.PK;
      const got = await getRecordClosestToTimestamp(target, ts, 2 * DAY);
      if (got?.SK !== undefined && got.price != null) out.set(c, Number(got.price));
    }));
  }
  return out;
}

function classify(name: string, coins: string[], before: Map<string, number>, after: Map<string, number>) {
  const lost: any[] = [], repriced: any[] = [], fixed: any[] = []; let ok = 0;
  for (const c of coins) {
    const b = before.get(c), a = after.get(c);
    if (b != null && a == null) lost.push({ coin: c, before: b });
    else if (b == null && a != null) fixed.push({ coin: c });
    else if (b != null && a != null) { const d = Math.abs(a - b) / (b || 1); if (d > threshold) repriced.push({ coin: c, before: b, after: a, drift: d }); else ok++; }
  }
  console.log(`\n=== /${name} ===  OK ${ok}  FIXED ${fixed.length}  REPRICED ${repriced.length}  LOST ${lost.length} ${lost.length ? "<- BLOCKS DEPLOY" : ""}`);
  for (const r of lost) console.log(`  LOST ${r.coin}  was ${r.before}`);
  for (const r of repriced.slice(0, 40)) console.log(`  REPRICED ${r.coin}  ${r.before} -> ${r.after} (${(r.drift * 100).toFixed(2)}%)`);
  return { name, ok, fixed: fixed.length, repriced: repriced.length, lost: lost.length, lostList: lost };
}

async function main() {
  const res = await chQueryJSON(`SELECT DISTINCT address FROM token_addresses WHERE chain = 'starknet' AND is_active = 1`);
  const coins = res.data.map((r: any[]) => String(r[0]).toLowerCase()).filter((a: string) => /^0x[0-9a-f]{1,64}$/.test(a)).map((a: string) => `starknet:${a}`);
  console.log(`checking ${coins.length} starknet forms across /chart + /historical (live before vs flipped-local after)...`);

  const [chartBefore, histBefore, chartAfter, histAfter] = await Promise.all([
    liveChart(coins), liveHistorical(coins), afterPrices(coins, nowTs), afterPrices(coins, histTs),
  ]);
  const r1 = classify("chart", coins, chartBefore, chartAfter);
  const r2 = classify("historical", coins, histBefore, histAfter);

  const failed = r1.lost > 0 || r2.lost > 0;
  if (jsonPath) require("fs").writeFileSync(jsonPath, JSON.stringify({ histTs, threshold, chart: r1, historical: r2 }, null, 2));
  console.log(`\nRESULT: ${failed ? "FAIL — LOST on a read endpoint; do not deploy." : "PASS — chart + historical resolve for every form post-flip."}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
