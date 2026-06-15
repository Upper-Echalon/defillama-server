import { createHash } from "crypto";
import fetch from "node-fetch";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import tokenMappings from "../tokenMapping.json";

const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const STRKEY_VERSION_ACCOUNT = 6 << 3; // 0x30, "G..."
const STRKEY_VERSION_CONTRACT = 2 << 3; // 0x10, "C..."

const B32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B32_DECODE: { [c: string]: number } = {};
for (let i = 0; i < B32_ALPHA.length; i++) B32_DECODE[B32_ALPHA[i]] = i;

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc16XModem(data: Buffer): Buffer {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  const out = Buffer.alloc(2);
  out.writeUInt16LE(crc, 0);
  return out;
}

function base32Encode(buf: Buffer): string {
  let out = "";
  let bits = 0;
  let val = 0;
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHA[(val >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32_ALPHA[(val << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let val = 0;
  for (const c of s) {
    const v = B32_DECODE[c];
    if (v === undefined) throw new Error(`bad base32 char '${c}' in ${str}`);
    val = (val << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function strkeyEncode(version: number, payload: Buffer): string {
  const versioned = Buffer.concat([Buffer.from([version]), payload]);
  const checksum = crc16XModem(versioned);
  return base32Encode(Buffer.concat([versioned, checksum]));
}

function strkeyDecode(expectedVersion: number, str: string): Buffer {
  const buf = base32Decode(str);
  if (buf.length < 3) throw new Error(`strkey too short: ${str}`);
  if (buf[0] !== expectedVersion)
    throw new Error(
      `strkey version mismatch: expected 0x${expectedVersion
        .toString(16)
        .padStart(2, "0")}, got 0x${buf[0].toString(16).padStart(2, "0")} (${str})`,
    );
  const payload = buf.slice(0, -2);
  const expectedCk = crc16XModem(payload);
  const actualCk = buf.slice(-2);
  if (expectedCk[0] !== actualCk[0] || expectedCk[1] !== actualCk[1])
    throw new Error(`strkey checksum mismatch: ${str}`);
  return payload.slice(1);
}

function encodeAsset(code: string, issuer: string): Buffer {
  if (code === "XLM" && !issuer) return u32be(0); // ASSET_TYPE_NATIVE

  const issuerBytes = strkeyDecode(STRKEY_VERSION_ACCOUNT, issuer);
  if (issuerBytes.length !== 32)
    throw new Error(`issuer pubkey wrong length: ${issuerBytes.length}`);

  const codeBytesRaw = Buffer.from(code, "utf8");
  if (codeBytesRaw.length === 0 || codeBytesRaw.length > 12)
    throw new Error(`asset code length out of range: '${code}'`);

  if (codeBytesRaw.length <= 4) {
    const codePadded = Buffer.alloc(4);
    codeBytesRaw.copy(codePadded);
    return Buffer.concat([u32be(1), codePadded, u32be(0), issuerBytes]);
  }
  const codePadded = Buffer.alloc(12);
  codeBytesRaw.copy(codePadded);
  return Buffer.concat([u32be(2), codePadded, u32be(0), issuerBytes]);
}

export function deriveStellarAssetContractId(
  code: string,
  issuer: string,
  passphrase: string = STELLAR_MAINNET_PASSPHRASE,
): string {
  const networkHash = sha256(Buffer.from(passphrase, "utf8"));
  const assetXdr = encodeAsset(code, issuer);
  const preimage = Buffer.concat([
    u32be(8), // ENVELOPE_TYPE_CONTRACT_ID
    networkHash,
    u32be(1), // CONTRACT_ID_PREIMAGE_FROM_ASSET
    assetXdr,
  ]);
  const contractIdHash = sha256(preimage);
  return strkeyEncode(STRKEY_VERSION_CONTRACT, contractIdHash);
}

export function parseStellarClassicKey(
  key: string,
): { code: string; issuer: string } | null {
  if (!key) return null;
  if (key === "XLM" || key.toLowerCase() === "xlm")
    return { code: "XLM", issuer: "" };

  // Skip keys that are already a Stellar contract id (start with C, 56 chars).
  if (key.length === 56 && (key[0] === "C" || key[0] === "c")) return null;

  // "CODE-ISSUER" or "CODE-ISSUER-N"
  const parts = key.split("-");
  if (parts.length < 2 || parts.length > 3) return null;
  const code = parts[0];
  const issuer = parts[1].toUpperCase();
  if (issuer.length !== 56 || issuer[0] !== "G") return null;
  if (code.length < 1 || code.length > 12) return null;
  return { code, issuer };
}

export async function isSacDeployed(sac: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.stellar.expert/explorer/public/contract/${sac}`);
    if (res.status === 404) return false;
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  }
}

export default async function getTokenPrices(timestamp: number = 0, writes: Write[] = []): Promise<Write[]> {
  const stellar: any = (tokenMappings as any).stellar;
  if (!stellar) return writes;

  const existing = new Set<string>();
  for (const k of Object.keys(stellar)) existing.add(k.toUpperCase());

  const seen = new Set<string>(); // dedupe SACs derived more than once in this run (e.g. "X-ISSUER" and "X-ISSUER-1")
  const candidates: { sac: string; decimals: number; symbol: string; to: string }[] = [];
  for (const [from, raw] of Object.entries(stellar)) {
    const { to, symbol, decimals: decimalsNum } = raw as any;
    const decimals = +decimalsNum;
    if (isNaN(decimals)) continue;

    const parsed = parseStellarClassicKey(from);
    if (!parsed) continue;

    let sac: string;
    try {
      sac = deriveStellarAssetContractId(parsed.code, parsed.issuer);
    } catch {
      continue;
    }
    if (existing.has(sac) || seen.has(sac)) continue;
    seen.add(sac);

    candidates.push({ sac, decimals, symbol, to });
  }

  // only price SACs that are actually deployed
  const deployed = await Promise.all(candidates.map((c) => isSacDeployed(c.sac)));
  candidates.forEach((c, i) => {
    if (!deployed[i]) return;
    // SAC is an alias of the classic asset id, so redirect it to the same price
    addToDBWritesList(writes, "stellar", c.sac, undefined, c.decimals, c.symbol, timestamp, "stellar-sac", 1.01, c.to);
  });

  return writes;
}
