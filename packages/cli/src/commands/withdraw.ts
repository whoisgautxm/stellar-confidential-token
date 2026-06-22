import {
  balance as sdkBalance,
  jub,
  stellar,
  withdraw as sdkWithdraw,
} from "@confidential-token/sdk";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { join } from "node:path";
import { loadConfig, type CliConfig } from "../config.js";

async function main() {
  const cfg = loadConfig();
  const amount = BigInt(process.argv[2] ?? process.env.CTOKEN_AMOUNT ?? "0");

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

  // 1. derive sender BabyJubJub kp (same seed as register/deposit/balance).
  const seed = await deriveSeed(cfg.source);
  const kp = jub.keypairFromSeed(seed);
  console.log("sender BabyJubJub pk:");
  console.log("  x =", kp.publicKey[0].toString());
  console.log("  y =", kp.publicKey[1].toString());

  // 2. snapshot on-chain encrypted balance.
  console.log("\nfetching sender encrypted balance...");
  const senderEnc = await readBalance(cfg, cfg.source.publicKey());
  if (sdkBalance.isEmptyEgct(senderEnc.egct)) {
    throw new Error("sender has no balance — run `deposit` first");
  }

  // 3. local decrypt + BSGS to recover plaintext balance.
  console.log("decrypting + BSGS sender balance (this may take ~1s)...");
  const senderBalance = sdkBalance.decryptBalance(senderEnc.egct, kp.privateKey);
  console.log(`sender plaintext balance = ${senderBalance} stroops`);
  if (amount > senderBalance) {
    throw new Error(`amount ${amount} > balance ${senderBalance}`);
  }

  // 4. build witness + Groth16 proof.
  console.log("\ngenerating withdraw Groth16 proof (this can take 5-30s)...");
  const t0 = Date.now();
  const built = await sdkWithdraw.buildWithdraw({
    sender: kp,
    senderBalance,
    senderEncBalance: senderEnc.egct,
    auditorPk: cfg.auditorPk,
    amount,
    wasmPath: join(cfg.artifactsDir, "withdraw", "withdraw.wasm"),
    zkeyPath: join(cfg.artifactsDir, "withdraw", "circuit_final.zkey"),
  });
  console.log(`proof generated in ${Date.now() - t0} ms`);
  console.log(`public signals: ${built.publicSignals.length} (expected 16)`);

  // 5. invoke confidential_token.withdraw.
  const args: xdr.ScVal[] = [
    stellar.addressToScVal(cfg.source.publicKey()),
    nativeToScVal(amount, { type: "i128" }),
    egctScVal(built.amountEgct),
    stellar.proofScVal(built.proofPoints, built.publicSignals),
    xdr.ScVal.scvVec(built.balancePct.map((v) => stellar.feScVal(v))),
  ];

  console.log("\ninvoking confidential_token.withdraw on chain...");
  const result = await stellar.invoke(
    cfg.network,
    cfg.source,
    cfg.contractIds.confidentialToken,
    "withdraw",
    args,
  );
  console.log("withdraw result:", result);
  console.log("\nDONE.");
  console.log(`  - ${amount} stroops of SAC transferred back to ${cfg.source.publicKey()}`);
  console.log(`  - encrypted balance reduced from ${senderBalance} to ${senderBalance - amount}`);
  console.log("Verify with: npx tsx packages/cli/src/commands/balance.ts");
}

async function deriveSeed(
  kp: import("@stellar/stellar-sdk").Keypair,
): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(
    `confidential-token:v1:${kp.publicKey()}`,
  );
  return kp.sign(Buffer.from(msg));
}

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

function egctScVal(egct: sdkWithdraw.BuiltWithdraw["amountEgct"]): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c1"),
      val: pointScVal(egct.c1.x, egct.c1.y),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c2"),
      val: pointScVal(egct.c2.x, egct.c2.y),
    }),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
