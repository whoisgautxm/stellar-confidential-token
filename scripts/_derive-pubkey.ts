// Derive a BabyJubJub public key from a Stellar Ed25519 secret using the same
// deterministic scheme as packages/cli/src/commands/register.ts.
//
// Usage:
//   npx tsx scripts/_derive-pubkey.ts <S...stellar_secret>
// Prints a single JSON line: {"x":"...","y":"..."}
//
// This script intentionally writes nothing — the calling shell is responsible
// for plumbing the output into testnet.json / set_auditor.

import { Keypair } from "@stellar/stellar-sdk";
import { jub } from "@confidential-token/sdk";

const secret = process.argv[2];
if (!secret) {
  console.error("usage: _derive-pubkey.ts <S...stellar_secret>");
  process.exit(1);
}

const kp = Keypair.fromSecret(secret);
const msg = new TextEncoder().encode(`confidential-token:v1:${kp.publicKey()}`);
const seed = kp.sign(Buffer.from(msg));
const bjj = jub.keypairFromSeed(seed);

process.stdout.write(
  JSON.stringify({ x: bjj.publicKey[0].toString(), y: bjj.publicKey[1].toString() }),
);
