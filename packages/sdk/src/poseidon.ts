import { type Point, Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import {
  formatPrivKeyForBabyJub,
  genRandomBabyJubValue,
  poseidonDecrypt,
  poseidonEncrypt,
} from "maci-crypto";
import { randomBytes } from "node:crypto";
import { BASE_POINT_ORDER } from "./constants.js";

export function randomNonce(): bigint {
  const bytes = randomBytes(16);
  return BigInt(`0x${bytes.toString("hex")}`) + 1n;
}

export function poseidonEncryptInputs(
  inputs: bigint[],
  publicKey: Point<bigint>,
): {
  ciphertext: bigint[];
  nonce: bigint;
  encRandom: bigint;
  encryptionKey: Point<bigint>;
  authKey: Point<bigint>;
} {
  const nonce = randomNonce();
  let encRandom = genRandomBabyJubValue();
  if (encRandom >= BASE_POINT_ORDER) encRandom = genRandomBabyJubValue() / 10n;
  const encryptionKey = mulPointEscalar(publicKey, encRandom);
  const authKey = mulPointEscalar(Base8, encRandom);
  const ciphertext = poseidonEncrypt(inputs, encryptionKey, nonce);
  return { ciphertext, nonce, encRandom, encryptionKey, authKey };
}

export function poseidonDecryptInputs(
  ciphertext: bigint[],
  authKey: Point<bigint>,
  nonce: bigint,
  privateKey: bigint,
  length: number,
): bigint[] {
  const sharedKey = mulPointEscalar(authKey, formatPrivKeyForBabyJub(privateKey));
  return poseidonDecrypt(ciphertext, sharedKey, nonce, length).slice(0, length);
}
