import {
  balance as sdkBalance,
  jub,
  stellar,
  transfer as sdkTransfer,
} from "@confidential-token/sdk";
import { xdr } from "@stellar/stellar-sdk";
import { join } from "node:path";
import { loadConfig, type CliConfig } from "../config.js";

async function main() {
  const cfg = loadConfig();
  const to = process.argv[2] ?? process.env.CTOKEN_TO;
  const amount = BigInt(process.argv[3] ?? process.env.CTOKEN_AMOUNT ?? "0");

  if (!to) throw new Error("recipient address required: ctoken transfer <to> <amount>");
  if (amount <= 0n) throw new Error("amount must be > 0");
  if (!cfg.contractIds.confidentialToken) {
    throw new Error("confidential_token contract id missing");
  }
  if (!cfg.contractIds.registrar) throw new Error("registrar contract id missing");
  if (!cfg.auditorPk) {
    throw new Error(
      "auditorPk missing from config — run ./scripts/set-auditor.sh first",
    );
  }
  if (to === cfg.source.publicKey()) {
    throw new Error("self-transfer not supported (would still work but useless for demo)");
  }

  // 1. derive sender BabyJubJub kp (same seed as register/deposit/balance).
  const seed = await deriveSeed(cfg.source);
  const kp = jub.keypairFromSeed(seed);
  console.log("sender BabyJubJub pk:");
  console.log("  x =", kp.publicKey[0].toString());
  console.log("  y =", kp.publicKey[1].toString());

  // 2. snapshot on-chain state.
  console.log("\nfetching sender encrypted balance...");
  const senderEnc = await readBalance(cfg, cfg.source.publicKey());
  if (sdkBalance.isEmptyEgct(senderEnc.egct)) {
    throw new Error("sender has no balance — run `deposit` first");
  }

  console.log("fetching recipient public key from registrar...");
  const receiverPk = await readReceiverPk(cfg, to);

  // 3. local decrypt + BSGS to recover plaintext balance.
  console.log("decrypting + BSGS sender balance (this may take ~1s)...");
  const senderBalance = sdkBalance.decryptBalance(senderEnc.egct, kp.privateKey);
  console.log(`sender plaintext balance = ${senderBalance} stroops`);
  if (amount > senderBalance) {
    throw new Error(`amount ${amount} > balance ${senderBalance}`);
  }

  // 4. build witness + Groth16 proof.
  console.log("\ngenerating transfer Groth16 proof (this can take 5-30s)...");
  const t0 = Date.now();
  const built = await sdkTransfer.buildTransfer({
    sender: kp,
    senderBalance,
    senderEncBalance: senderEnc.egct,
    receiverPk,
    auditorPk: cfg.auditorPk,
    amount,
    wasmPath: join(cfg.artifactsDir, "transfer", "transfer.wasm"),
    zkeyPath: join(cfg.artifactsDir, "transfer", "transfer.zkey"),
  });
  console.log(`proof generated in ${Date.now() - t0} ms`);
  console.log(`public signals: ${built.publicSignals.length} (expected 32)`);

  // 5. invoke confidential_token.transfer.
  const args: xdr.ScVal[] = [
    stellar.addressToScVal(cfg.source.publicKey()),
    stellar.addressToScVal(to),
    stellar.proofScVal(built.proofPoints, built.publicSignals),
    xdr.ScVal.scvVec(built.balancePct.map((v) => stellar.feScVal(v))),
  ];

  console.log("\ninvoking confidential_token.transfer on chain...");
  const result = await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.confidentialToken,
    "transfer",
    args,
  );
  console.log("transfer result:", result);
  console.log("\nDONE. Verify with:");
  console.log("  npx tsx packages/cli/src/commands/balance.ts");
  console.log(`  STELLAR_SECRET=<recipient_secret> npx tsx packages/cli/src/commands/balance.ts`);
}

async function deriveSeed(
  kp: import("@stellar/stellar-sdk").Keypair,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(
    `confidential-token:v1:${kp.publicKey()}`,
  );
  return kp.sign(Buffer.from(msg));
}

/** Read-only invoke of `confidential_token.balance_of(user)`. */
async function readBalance(
  cfg: CliConfig,
  user: string,
): Promise<sdkBalance.RawEncryptedBalance> {
  const result = await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.confidentialToken as string,
    "balance_of",
    [stellar.addressToScVal(user)],
  );
  return result as sdkBalance.RawEncryptedBalance;
}

/** Read-only invoke of `registrar.get_user_public_key(user)`. */
async function readReceiverPk(
  cfg: CliConfig,
  user: string,
): Promise<import("@zk-kit/baby-jubjub").Point<bigint>> {
  const result = (await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.registrar as string,
    "get_user_public_key",
    [stellar.addressToScVal(user)],
  )) as { x: bigint; y: bigint };
  if (result.x === 0n && result.y === 0n) {
    throw new Error(
      `recipient ${user} is not registered — they must run \`register\` first`,
    );
  }
  return [result.x, result.y] as import("@zk-kit/baby-jubjub").Point<bigint>;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
