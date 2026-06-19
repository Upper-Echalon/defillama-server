/**
 * READ-ONLY pre-deploy safety net for the starknet canonicalization flip.
 *
 *   ts-node --transpile-only src/cli/verifyStarknetFlip.ts [--threshold 0.005] [--json out.json]
 *
 * For EVERY starknet address prod knows (token_addresses), compares:
 *   BEFORE = current live prod price for that exact form (coins.llama.fi)
 *   AFTER  = the SAME serving primitives the deployed route uses
 *            (redisCurrentPrices -> chCurrentPrices), running locally with the
 *            flip applied. These import the flipped normalizeInput, so this is
 *            the real post-flip behaviour against the real stores — not a model.
 *
 * Per form:
 *   LOST      live had a price, post-flip returns nothing   <- BLOCKS DEPLOY
 *   REPRICED  both present, differ by > threshold           <- review
 *   FIXED     live had nothing, post-flip now resolves       <- the bug fix working
 *   OK        unchanged within threshold
 *
 * This is the check the unit tests could not be: it runs the real resolution
 * against real data across the whole starknet set. Exits non-zero on any LOST.
 *
 * Needs the same env as serving: REDIS_SERVING_CONFIG (or sentinel) + CH_* .
 */
import axios from "axios";
import { chQueryJSON } from "../utils/clickhouseClient";
import { redisCurrentPrices, chCurrentPrices, CoinsResponse } from "../utils/servingLayer";

const args = process.argv.slice(2);
const threshold = args.includes("--threshold") ? Number(args[args.indexOf("--threshold") + 1]) : 0.005;
const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function livePrices(coins: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk(coins, 60)) {
    try {
      const { data } = await axios.get(`https://coins.llama.fi/prices/current/${part.join(",")}`, { timeout: 20000 });
      for (const [k, v] of Object.entries<any>(data.coins || {})) out.set(k, v.price);
    } catch (e) { console.error(`live fetch failed: ${(e as Error).message}`); }
  }
  return out;
}

// Mirror the route's layering: Redis first, ClickHouse fills the rest.
async function servedPrices(coins: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunk(coins, 100)) {
    const merged: CoinsResponse = {};
    const r = await redisCurrentPrices(part).catch(() => null);
    if (r) Object.assign(merged, r);
    const missing = part.filter((c) => merged[c] == null);
    if (missing.length) { const c = await chCurrentPrices(missing).catch(() => null); if (c) Object.assign(merged, c); }
    for (const [k, v] of Object.entries(merged)) if (v?.price != null) out.set(k, v.price);
  }
  return out;
}

async function main() {
  const res = await chQueryJSON(`SELECT DISTINCT address FROM token_addresses WHERE chain = 'starknet' AND is_active = 1`);
  const coins = res.data
    .map((r: any[]) => String(r[0]).toLowerCase())
    .filter((a: string) => /^0x[0-9a-f]{1,64}$/.test(a)) // skip 0xstarknet: junk (never requested)
    .map((a: string) => `starknet:${a}`);

  console.log(`checking ${coins.length} starknet forms: live (before) vs flipped serving (after)...`);
  const [before, after] = await Promise.all([livePrices(coins), servedPrices(coins)]);

  const lost: any[] = [], repriced: any[] = [], fixed: any[] = []; let ok = 0;
  for (const c of coins) {
    const b = before.get(c), a = after.get(c);
    if (b != null && a == null) lost.push({ coin: c, before: b });
    else if (b == null && a != null) fixed.push({ coin: c, after: a });
    else if (b != null && a != null) {
      const drift = Math.abs(a - b) / (b || 1);
      if (drift > threshold) repriced.push({ coin: c, before: b, after: a, drift }); else ok++;
    }
  }

  console.log(`\n=== starknet flip verification (threshold ${threshold * 100}%) ===`);
  console.log(`forms     : ${coins.length}`);
  console.log(`OK        : ${ok}`);
  console.log(`FIXED     : ${fixed.length}  (were missing live, now resolve)`);
  console.log(`REPRICED  : ${repriced.length}`);
  console.log(`LOST      : ${lost.length}  ${lost.length ? "<- BLOCKS DEPLOY" : ""}\n`);

  if (lost.length) { console.log("--- LOST ---"); for (const r of lost) console.log(`  ${r.coin}  was ${r.before}`); console.log(""); }
  if (repriced.length) { console.log("--- REPRICED ---"); for (const r of repriced.slice(0, 80)) console.log(`  ${r.coin}  ${r.before} -> ${r.after}  (${(r.drift * 100).toFixed(2)}%)`); if (repriced.length > 80) console.log(`  ...and ${repriced.length - 80} more`); console.log(""); }

  if (jsonPath) require("fs").writeFileSync(jsonPath, JSON.stringify({ threshold, summary: { forms: coins.length, ok, fixed: fixed.length, repriced: repriced.length, lost: lost.length }, lost, repriced, fixed }, null, 2));
  console.log(lost.length ? "RESULT: FAIL — resolve LOST before deploying the flip." : "RESULT: PASS — no starknet form loses its price under the flip.");
  process.exit(lost.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
