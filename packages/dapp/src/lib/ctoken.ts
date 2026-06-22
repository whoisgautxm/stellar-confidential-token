// Per-action helpers that mirror the CLI commands but use the dApp's
// wallet-driven signer. All five eERC operations are implemented here:
//   register / deposit / balance / transfer / withdraw
//
// The functions accept a SenderKeypair already derived (via deriveBjjSeed +
// jub.keypairFromSeed) and an `address` (Stellar G-address) for the signer.

import type { Point } from "@zk-kit/baby-jubjub";
import { Buffer } from "buffer";
import {
  balance as sdkBalance,
  jub,
  poseidon as sdkPoseidon,
  prover,
  stellar,
  transfer as sdkTransfer,
  withdraw as sdkWithdraw,
} from "@confidential-token/sdk";
import type { SignXdr } from "@confidential-token/sdk/stellar";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { poseidon3 as poseidonLite3 } from "poseidon-lite";
import { cfg } from "./config.js";

export interface SenderKeypair {
  privateKey: bigint;
  publicKey: Point<bigint>;
  formattedPrivKey: bigint;
}

export interface ActionContext {
  address: string;
  kp: SenderKeypair;
  sign: SignXdr;
  /** Optional progress hook so the UI can render staged messages. */
  onProgress?: (msg: string) => void;
}

// ───────────────────────────── register ─────────────────────────────

export async function register(ctx: ActionContext): Promise<void> {
  const { address, kp, sign, onProgress } = ctx;
  const log = onProgress ?? (() => {});

  log("computing registration witness");
  const accountField = addressToField(address);
  const registrationHash = poseidonLite3([
    cfg.chainId,
    kp.formattedPrivKey,
    accountField,
  ]);

  log("generating Groth16 proof (~1 s)");
  const t0 = Date.now();
  const { proof, publicSignals } = await prover.proveGroth16(
    {
      SenderPrivateKey: kp.formattedPrivKey.toString(),
      SenderPublicKey: kp.publicKey.map((v) => v.toString()),
      SenderAddress: accountField.toString(),
      ChainID: cfg.chainId.toString(),
      RegistrationHash: registrationHash.toString(),
    },
    { wasmPath: cfg.artifacts.registration.wasm, zkeyPath: cfg.artifacts.registration.zkey },
  );
  log(`proof generated in ${Date.now() - t0} ms`);

  const points = prover.proofToBytes(proof);
  const proofScVal = stellar.proofScVal(
    points,
    publicSignals.map((s) => BigInt(s)),
  );

  log("requesting wallet signature + submitting tx");
  await stellar.invokeWithWallet(
    cfg.network,
    address,
    sign,
    cfg.contracts.registrar,
    "register",
    [stellar.addressToScVal(address), proofScVal],
  );
  log("registered ✓");
}

// ───────────────────────────── deposit ─────────────────────────────

export async function deposit(
  ctx: ActionContext & { amount: bigint },
): Promise<void> {
  const { address, kp, sign, amount, onProgress } = ctx;
  const log = onProgress ?? (() => {});
  if (amount <= 0n) throw new Error("amount must be > 0 stroops");

  log("encrypting amount client-side");
  // Same deterministic r = 1 the CLI uses — keeps EGCT reconstructable from
  // the public amount.
  const { cipher } = jub.encryptScalar(kp.publicKey, amount, 1n);
  const amountPct: bigint[] = Array(7).fill(0n);

  const args: xdr.ScVal[] = [
    stellar.addressToScVal(address),
    nativeToScVal(amount, { type: "i128" }),
    egctScVal(cipher[0], cipher[1]),
    xdr.ScVal.scvVec(amountPct.map((v) => nativeToScVal(v, { type: "u256" }))),
  ];

  log("requesting wallet signature + submitting tx");
  await stellar.invokeWithWallet(
    cfg.network,
    address,
    sign,
    cfg.contracts.confidentialToken,
    "deposit",
    args,
  );
  log(`deposit of ${amount} stroops confirmed ✓`);
}

// ───────────────────────────── balance ─────────────────────────────

export interface DecryptedBalance {
  raw: sdkBalance.RawEncryptedBalance;
  /** Plaintext stroops if the slot is initialised, else null. */
  amount: bigint | null;
  /** Milliseconds the BSGS dlog took, or null on empty slot. */
  bsgsMs: number | null;
}

export async function readAndDecryptBalance(
  address: string,
  kp: SenderKeypair,
  target?: string,
): Promise<DecryptedBalance> {
  const userToRead = target ?? address;
  const raw = await readBalance(address, userToRead);
  if (sdkBalance.isEmptyEgct(raw.egct)) return { raw, amount: null, bsgsMs: null };
  if (userToRead !== address) {
    // Can't decrypt someone else's balance — return raw only.
    return { raw, amount: null, bsgsMs: null };
  }
  const t0 = Date.now();
  const amount = sdkBalance.decryptBalance(raw.egct, kp.privateKey);
  return { raw, amount, bsgsMs: Date.now() - t0 };
}

async function readBalance(
  source: string,
  user: string,
): Promise<sdkBalance.RawEncryptedBalance> {
  const result = (await stellar.readContract(
    cfg.network,
    source,
    cfg.contracts.confidentialToken,
    "balance_of",
    [stellar.addressToScVal(user)],
  )) as sdkBalance.RawEncryptedBalance;
  return result;
}

async function readReceiverPk(source: string, user: string): Promise<Point<bigint>> {
  const result = (await stellar.readContract(
    cfg.network,
    source,
    cfg.contracts.registrar,
    "get_user_public_key",
    [stellar.addressToScVal(user)],
  )) as { x: bigint; y: bigint };
  if (result.x === 0n && result.y === 0n) {
    throw new Error(`recipient ${user} is not registered`);
  }
  return [result.x, result.y] as Point<bigint>;
}

// ───────────────────────────── transfer ─────────────────────────────

export async function transfer(
  ctx: ActionContext & { to: string; amount: bigint },
): Promise<void> {
  const { address, kp, sign, to, amount, onProgress } = ctx;
  const log = onProgress ?? (() => {});
  if (amount <= 0n) throw new Error("amount must be > 0 stroops");
  if (to === address) throw new Error("cannot self-transfer");

  log("fetching sender encrypted balance");
  const senderEnc = await readBalance(address, address);
  if (sdkBalance.isEmptyEgct(senderEnc.egct)) {
    throw new Error("sender has no balance — deposit first");
  }

  log("fetching receiver public key from registrar");
  const receiverPk = await readReceiverPk(address, to);

  log("decrypting + BSGS sender balance (~1 s)");
  const senderBalance = sdkBalance.decryptBalance(senderEnc.egct, kp.privateKey);
  if (amount > senderBalance) {
    throw new Error(`amount ${amount} > current balance ${senderBalance}`);
  }

  log("generating transfer Groth16 proof");
  const t0 = Date.now();
  const built = await sdkTransfer.buildTransfer({
    sender: kp,
    senderBalance,
    senderEncBalance: senderEnc.egct,
    receiverPk,
    auditorPk: cfg.auditor.publicKey,
    amount,
    wasmPath: cfg.artifacts.transfer.wasm,
    zkeyPath: cfg.artifacts.transfer.zkey,
  });
  log(`proof generated in ${Date.now() - t0} ms (32 public signals)`);

  const args: xdr.ScVal[] = [
    stellar.addressToScVal(address),
    stellar.addressToScVal(to),
    stellar.proofScVal(built.proofPoints, built.publicSignals),
    xdr.ScVal.scvVec(built.balancePct.map((v) => stellar.feScVal(v))),
  ];

  log("requesting wallet signature + submitting tx");
  await stellar.invokeWithWallet(
    cfg.network,
    address,
    sign,
    cfg.contracts.confidentialToken,
    "transfer",
    args,
  );
  log(`private transfer of ${amount} stroops to ${truncAddr(to)} confirmed ✓`);
}

// ───────────────────────────── withdraw ─────────────────────────────

export async function withdraw(
  ctx: ActionContext & { amount: bigint },
): Promise<void> {
  const { address, kp, sign, amount, onProgress } = ctx;
  const log = onProgress ?? (() => {});
  if (amount <= 0n) throw new Error("amount must be > 0 stroops");

  log("fetching sender encrypted balance");
  const senderEnc = await readBalance(address, address);
  if (sdkBalance.isEmptyEgct(senderEnc.egct)) {
    throw new Error("sender has no balance — deposit first");
  }

  log("decrypting + BSGS sender balance (~1 s)");
  const senderBalance = sdkBalance.decryptBalance(senderEnc.egct, kp.privateKey);
  if (amount > senderBalance) {
    throw new Error(`amount ${amount} > current balance ${senderBalance}`);
  }

  log("generating withdraw Groth16 proof");
  const t0 = Date.now();
  const built = await sdkWithdraw.buildWithdraw({
    sender: kp,
    senderBalance,
    senderEncBalance: senderEnc.egct,
    auditorPk: cfg.auditor.publicKey,
    amount,
    wasmPath: cfg.artifacts.withdraw.wasm,
    zkeyPath: cfg.artifacts.withdraw.zkey,
  });
  log(`proof generated in ${Date.now() - t0} ms (16 public signals)`);

  const args: xdr.ScVal[] = [
    stellar.addressToScVal(address),
    nativeToScVal(amount, { type: "i128" }),
    egctScVal([built.amountEgct.c1.x, built.amountEgct.c1.y], [
      built.amountEgct.c2.x,
      built.amountEgct.c2.y,
    ]),
    stellar.proofScVal(built.proofPoints, built.publicSignals),
    xdr.ScVal.scvVec(built.balancePct.map((v) => stellar.feScVal(v))),
  ];

  log("requesting wallet signature + submitting tx");
  await stellar.invokeWithWallet(
    cfg.network,
    address,
    sign,
    cfg.contracts.confidentialToken,
    "withdraw",
    args,
  );
  log(`withdraw of ${amount} stroops back to public SAC confirmed ✓`);
}

// ───────────────────────────── helpers ─────────────────────────────

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

function addressToField(addr: string): bigint {
  // Mirrors confidential-token/crates/eerc-types::address_to_field —
  // first 31 ASCII bytes of the strkey, big-endian.
  const bytes = new TextEncoder().encode(addr);
  const first31 = bytes.slice(0, 31);
  let acc = 0n;
  for (const b of first31) acc = (acc << 8n) | BigInt(b);
  return acc;
}

function truncAddr(a: string): string {
  return `${a.slice(0, 5)}…${a.slice(-4)}`;
}

// Force-import to keep tree-shaker from dropping the Buffer polyfill alias
// the SDK depends on at runtime. No side effects expected.
void Buffer;
void sdkPoseidon;
