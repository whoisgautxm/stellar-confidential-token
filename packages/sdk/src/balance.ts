import type { Point } from "@zk-kit/baby-jubjub";
import { decryptPoint, dlogBoundedBSGS, type Egct as JubEgct } from "./jub.js";

/**
 * On-chain `EncryptedBalance.egct` shape after `scValToNative`.
 * Soroban returns `U256` as bigint and `contracttype` structs as plain objects.
 */
export interface EgctPoints {
  c1: { x: bigint; y: bigint };
  c2: { x: bigint; y: bigint };
}

// Default BSGS ceiling. 2^28 stroops ≈ 268M ≈ 26.8 SAC tokens (7 decimals).
// BSGS time scales with sqrt(max): 2^28 → ~2^14 = 16k steps → typically under
// a second in Node. Raise via the `CTOKEN_BSGS_MAX` env var (decimal stroops)
// or by passing an explicit `maxStroops` argument to `decryptBalance`.
//
// For reference: the previous 2^40 ceiling took ~30s per decrypt, which
// dominated demo recording time.
export const DEFAULT_BSGS_MAX: bigint = (() => {
  const override = typeof process !== "undefined" ? process.env?.CTOKEN_BSGS_MAX : undefined;
  if (override && override.length > 0) {
    try {
      const v = BigInt(override);
      if (v > 0n) return v;
    } catch {
      // fall through to default
    }
  }
  return 1n << 28n;
})();

export function isEmptyEgct(egct: EgctPoints): boolean {
  return (
    egct.c1.x === 0n &&
    egct.c1.y === 0n &&
    egct.c2.x === 0n &&
    egct.c2.y === 0n
  );
}

/**
 * Decrypt the ElGamal ciphertext to the BabyJubJub message point.
 * Returns `null` if the EGCT slot has never been initialised on chain.
 */
export function decryptToPoint(
  egct: EgctPoints,
  privateKey: bigint,
): Point<bigint> | null {
  if (isEmptyEgct(egct)) return null;
  return decryptPoint(
    privateKey,
    [egct.c1.x, egct.c1.y],
    [egct.c2.x, egct.c2.y],
  );
}

/**
 * Decrypt + BSGS to recover the plaintext stroop balance.
 * Throws on an empty slot or on a dlog miss within `maxStroops`.
 */
export function decryptBalance(
  egct: EgctPoints,
  privateKey: bigint,
  maxStroops: bigint = DEFAULT_BSGS_MAX,
): bigint {
  const point = decryptToPoint(egct, privateKey);
  if (point === null) {
    throw new Error("encrypted balance is empty (no deposit recorded)");
  }
  return dlogBoundedBSGS(point, maxStroops);
}

/** Shape of `confidential_token.balance_of(user)` after `scValToNative`. */
export interface RawEncryptedBalance {
  egct: EgctPoints;
  nonce: number;
  transaction_index: number;
  balance_pct: bigint[];
}

/** Re-export the SDK's structural Egct alias for callers that pass it around. */
export type Egct = JubEgct;
