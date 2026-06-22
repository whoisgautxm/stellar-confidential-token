import {
  Base8,
  Fr,
  type Point,
  addPoint,
  mulPointEscalar,
} from "@zk-kit/baby-jubjub";
import { formatPrivKeyForBabyJub, genRandomBabyJubValue } from "maci-crypto";
import { BASE_POINT_ORDER } from "./constants.js";

export type Egct = [Point<bigint>, Point<bigint>];

/**
 * Derive a BabyJubJub keypair from a 32-byte secret.
 * Secret can be any high-entropy bytes — for Stellar we derive from
 * Ed25519 sign(`(network_passphrase || contract_id || address)`).
 */
export function keypairFromSeed(seed: Uint8Array): {
  privateKey: bigint;
  publicKey: Point<bigint>;
  formattedPrivKey: bigint;
} {
  if (seed.length < 32) throw new Error("seed must be >= 32 bytes");
  const hex = Buffer.from(seed.slice(0, 32)).toString("hex");
  const raw = BigInt(`0x${hex}`);
  const privateKey = raw % BASE_POINT_ORDER;
  const formattedPrivKey = formatPrivKeyForBabyJub(privateKey);
  const publicKey = mulPointEscalar(Base8, formattedPrivKey);
  return { privateKey, publicKey, formattedPrivKey };
}

export function encryptPoint(
  publicKey: Point<bigint>,
  point: Point<bigint>,
  random = genRandomBabyJubValue(),
): Egct {
  const c1 = mulPointEscalar(Base8, random);
  const pky = mulPointEscalar(publicKey, random);
  const c2 = addPoint(point, pky);
  return [c1, c2];
}

export function encryptScalar(
  publicKey: Point<bigint>,
  message: bigint,
  random = genRandomBabyJubValue(),
): { cipher: Egct; random: bigint } {
  let r = random;
  if (r >= BASE_POINT_ORDER) {
    r = genRandomBabyJubValue() / 100n;
  }
  const p = mulPointEscalar(Base8, message);
  return { cipher: encryptPoint(publicKey, p, r), random: r };
}

/**
 * Decrypt ElGamal EGCT to a point. Caller must do baby-step-giant-step or
 * a discrete log lookup to recover the integer message from the point.
 */
export function decryptPoint(
  privateKey: bigint,
  c1: Point<bigint>,
  c2: Point<bigint>,
): Point<bigint> {
  const priv = formatPrivKeyForBabyJub(privateKey);
  const c1x = mulPointEscalar(c1, priv);
  const negC1x: Point<bigint> = [Fr.e(c1x[0] * -1n), c1x[1]];
  return addPoint(c2, negC1x);
}

/**
 * Baby-step / giant-step discrete log on BabyJubJub up to `max`.
 * Only useful for small bounded balances — the eERC use case caps amounts
 * to 64-bit values so a precomputed table or BSGS works well.
 */
export function dlogBoundedBSGS(target: Point<bigint>, max: bigint): bigint {
  const m = bigSqrt(max) + 1n;
  const baby = new Map<string, bigint>();
  let cur: Point<bigint> = [0n, 1n]; // identity
  for (let j = 0n; j < m; j++) {
    baby.set(`${cur[0]},${cur[1]}`, j);
    cur = addPoint(cur, Base8);
  }
  const factor = mulPointEscalar(Base8, m);
  const negFactor: Point<bigint> = [Fr.e(factor[0] * -1n), factor[1]];
  let gamma = target;
  for (let i = 0n; i < m; i++) {
    const k = baby.get(`${gamma[0]},${gamma[1]}`);
    if (k !== undefined) return i * m + k;
    gamma = addPoint(gamma, negFactor);
  }
  throw new Error("dlog not found in range");
}

function bigSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
