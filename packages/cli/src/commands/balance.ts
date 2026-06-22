import { balance as sdkBalance, jub, stellar } from "@confidential-token/sdk";
import { xdr } from "@stellar/stellar-sdk";
import { loadConfig } from "../config.js";

async function main() {
  const cfg = loadConfig();
  if (!cfg.contractIds.confidentialToken) {
    throw new Error("confidential_token contract id missing");
  }
  const target = process.argv[2] ?? cfg.source.publicKey();

  const args: xdr.ScVal[] = [stellar.addressToScVal(target)];
  const result = (await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.confidentialToken,
    "balance_of",
    args,
  )) as sdkBalance.RawEncryptedBalance;

  console.log("=== encrypted balance ===");
  console.log("user:           ", target);
  console.log("nonce:          ", result.nonce);
  console.log("transaction_idx:", result.transaction_index);
  console.log("egct.c1.x:      ", result.egct.c1.x.toString());
  console.log("egct.c1.y:      ", result.egct.c1.y.toString());
  console.log("egct.c2.x:      ", result.egct.c2.x.toString());
  console.log("egct.c2.y:      ", result.egct.c2.y.toString());

  if (sdkBalance.isEmptyEgct(result.egct)) {
    console.log("\n(no balance recorded yet — deposit first)");
    return;
  }

  if (target !== cfg.source.publicKey()) {
    console.log(
      "\n(cannot decrypt — only the holder can; set STELLAR_SECRET to that account)",
    );
    return;
  }

  const seed = await deriveSeed(cfg.source);
  const kp = jub.keypairFromSeed(seed);

  const message = sdkBalance.decryptToPoint(result.egct, kp.privateKey);
  if (!message) throw new Error("unexpected empty EGCT after isEmpty check");
  console.log("\n=== decrypted message point ===");
  console.log("M.x =", message[0].toString());
  console.log("M.y =", message[1].toString());

  console.log(`\nrunning BSGS dlog up to ${sdkBalance.DEFAULT_BSGS_MAX} stroops...`);
  const start = Date.now();
  const amount = sdkBalance.decryptBalance(result.egct, kp.privateKey);
  const elapsed = Date.now() - start;
  console.log("=== plaintext balance ===");
  console.log(`amount = ${amount} stroops  (BSGS took ${elapsed} ms)`);
  const tokens = Number(amount) / 1e7;
  console.log(`       ≈ ${tokens} CONF`);
}

async function deriveSeed(
  kp: import("@stellar/stellar-sdk").Keypair,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(
    `confidential-token:v1:${kp.publicKey()}`,
  );
  return kp.sign(Buffer.from(msg));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
