import { jub, stellar } from "@confidential-token/sdk";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";

async function main() {
  const cfg = loadConfig();
  if (!cfg.contractIds.confidentialToken) {
    throw new Error("confidential_token contract id missing");
  }

  const amount = BigInt(process.argv[2] ?? process.env.CTOKEN_AMOUNT ?? "0");
  if (amount <= 0n) throw new Error("amount must be > 0");

  // Derive the same BabyJubJub keypair we used at register time.
  const seed = await deriveSeed(cfg.source);
  const kp = jub.keypairFromSeed(seed);

  // Match eERC deposit semantics: encrypt the public amount with r = 1
  // (deterministic) so anyone watching can reconstruct the EGCT and verify
  // it equals encrypt(pk, amount). This contract path does NOT enforce that
  // equality on chain (would require an extra ZK proof). For our hackathon
  // demo the SAC.transfer establishes the public boundary; misencryption
  // only breaks the user's own future balance reads.
  const { cipher: egct } = jub.encryptScalar(kp.publicKey, amount, 1n);

  // amount_pct: short Vec<U256> placeholder — Poseidon-encrypted amount
  // metadata for the auditor. Zeros are accepted by the contract; real
  // deployments should fill these via packages/sdk Poseidon helpers.
  const amountPct: bigint[] = Array(7).fill(0n);

  const args: xdr.ScVal[] = [
    stellar.addressToScVal(cfg.source.publicKey()),
    nativeToScVal(amount, { type: "i128" }),
    egctScVal(egct[0], egct[1]),
    xdr.ScVal.scvVec(amountPct.map((v) => nativeToScVal(v, { type: "u256" }))),
  ];

  console.log("invoking confidential_token.deposit...");
  const result = await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.confidentialToken,
    "deposit",
    args,
  );
  console.log("deposit result:", result);
}

async function deriveSeed(
  kp: import("@stellar/stellar-sdk").Keypair,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(
    `confidential-token:v1:${kp.publicKey()}`,
  );
  return kp.sign(Buffer.from(msg));
}

function pointScVal(x: bigint, y: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("x"),
      val: nativeToScVal(x, { type: "u256" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("y"),
      val: nativeToScVal(y, { type: "u256" }),
    }),
  ]);
}

function egctScVal(
  c1: readonly [bigint, bigint],
  c2: readonly [bigint, bigint],
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c1"),
      val: pointScVal(c1[0], c1[1]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c2"),
      val: pointScVal(c2[0], c2[1]),
    }),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
