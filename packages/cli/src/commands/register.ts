import { jub, prover, stellar } from "@confidential-token/sdk";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { poseidon3 as poseidonLite3 } from "poseidon-lite";
import { join } from "node:path";
import { loadConfig } from "../config.js";

async function main() {
  const cfg = loadConfig();
  if (!cfg.contractIds.registrar) {
    throw new Error("registrar contract id not configured");
  }

  const seed = await deriveSeed(cfg.source);
  const kp = jub.keypairFromSeed(seed);
  console.log("BabyJubJub pubkey:");
  console.log("  x =", kp.publicKey[0].toString());
  console.log("  y =", kp.publicKey[1].toString());

  // Must match the contract's `address_to_field`:
  // take the first 32 ASCII bytes of the strkey, interpret big-endian.
  const accountField = addressToField(cfg.source.publicKey());

  // Must match eERC user.ts: poseidon3([chainId, FORMATTED privKey, address]).
  const registrationHash = poseidonLite3([
    cfg.chainId,
    kp.formattedPrivKey,
    accountField,
  ]);

  console.log("chainId:", cfg.chainId.toString());
  console.log("accountField:", accountField.toString());
  console.log("registrationHash:", registrationHash.toString());

  const wasmPath = join(cfg.artifactsDir, "registration", "registration.wasm");
  const zkeyPath = join(cfg.artifactsDir, "registration", "circuit_final.zkey");

  const inputs = {
    SenderPrivateKey: kp.formattedPrivKey.toString(),
    SenderPublicKey: kp.publicKey.map((v) => v.toString()),
    SenderAddress: accountField.toString(),
    ChainID: cfg.chainId.toString(),
    RegistrationHash: registrationHash.toString(),
  };

  console.log("generating Groth16 proof (this can take 5-30s)...");
  const { proof, publicSignals } = await prover.proveGroth16(inputs, {
    wasmPath,
    zkeyPath,
  });
  console.log("proof generated, public signals:", publicSignals);

  const points = prover.proofToBytes(proof);
  const proofScVal = stellar.proofScVal(
    points,
    publicSignals.map((s) => BigInt(s)),
  );

  const args: xdr.ScVal[] = [
    stellar.addressToScVal(cfg.source.publicKey()),
    proofScVal,
  ];

  console.log("invoking registrar.register on chain...");
  const result = await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.registrar,
    "register",
    args,
  );
  console.log("register result:", result);

  // Persist BabyJubJub keypair for later commands. PrivateKey kept locally
  // only; the demo derives it deterministically from the Stellar Ed25519 key.
  console.log("\nDONE. Run `npm run balance` to inspect.");
}

async function deriveSeed(
  kp: import("@stellar/stellar-sdk").Keypair,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(
    `confidential-token:v1:${kp.publicKey()}`,
  );
  return kp.sign(Buffer.from(msg));
}

function addressToField(addr: string): bigint {
  // Must match `address_to_field` in confidential-token/crates/eerc-types:
  // first 31 ASCII bytes of the strkey, big-endian (always < 2^248 < BN254 Fr).
  const bytes = new TextEncoder().encode(addr);
  const first31 = bytes.slice(0, 31);
  let acc = 0n;
  for (const b of first31) acc = (acc << 8n) | BigInt(b);
  return acc;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
