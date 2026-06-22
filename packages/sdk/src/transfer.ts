import type { Point } from "@zk-kit/baby-jubjub";
import type { EgctPoints } from "./balance.js";
import * as jub from "./jub.js";
import * as poseidon from "./poseidon.js";
import * as prover from "./prover.js";

export interface SenderKeypair {
  privateKey: bigint;
  publicKey: Point<bigint>;
  formattedPrivKey: bigint;
}

export interface BuildTransferInput {
  sender: SenderKeypair;
  /** Plaintext stroop balance, recovered client-side via BSGS. */
  senderBalance: bigint;
  /** Current on-chain EGCT — must equal what `balance_of(sender)` returns. */
  senderEncBalance: EgctPoints;
  receiverPk: Point<bigint>;
  auditorPk: Point<bigint>;
  /** Stroop amount to move. Must be > 0 and <= senderBalance. */
  amount: bigint;
  wasmPath: string;
  zkeyPath: string;
}

export interface BuiltTransfer {
  proofPoints: { a: Uint8Array; b: Uint8Array; c: Uint8Array };
  /** Length 32, ordered to match the circuit's public-signals declaration order. */
  publicSignals: bigint[];
  /** Sender's new balance PCT: 7 elems [ct(4) | authKey(2) | nonce(1)]. */
  balancePct: bigint[];
}

/**
 * Build a transfer witness, generate the Groth16 proof, and serialise both the
 * proof and the sender's new balance PCT into Stellar-friendly types.
 *
 * Mirrors `privateTransfer()` from EncryptedERC/test/helpers.ts so the same
 * circuit (transfer.wasm/.zkey) accepts our witness without modification.
 */
export async function buildTransfer(input: BuildTransferInput): Promise<BuiltTransfer> {
  const {
    sender,
    senderBalance,
    senderEncBalance,
    receiverPk,
    auditorPk,
    amount,
    wasmPath,
    zkeyPath,
  } = input;

  if (amount <= 0n) throw new Error("amount must be > 0");
  if (amount > senderBalance) {
    throw new Error(`amount ${amount} exceeds balance ${senderBalance}`);
  }
  const senderNewBalance = senderBalance - amount;

  // 1. ElGamal-encrypt the transfer amount under sender's PK (for SenderVTT).
  const { cipher: senderVTT } = jub.encryptScalar(sender.publicKey, amount);
  // 2. ElGamal-encrypt the transfer amount under receiver's PK (for ReceiverVTT).
  const { cipher: receiverVTT, random: receiverVTTRandom } = jub.encryptScalar(
    receiverPk,
    amount,
  );

  // 3. Poseidon-encrypt the transfer amount for the receiver's auditable summary.
  const receiverPCT = poseidon.poseidonEncryptInputs([amount], receiverPk);
  // 4. Poseidon-encrypt the transfer amount for the auditor's summary.
  const auditorPCT = poseidon.poseidonEncryptInputs([amount], auditorPk);
  // 5. Poseidon-encrypt sender's *new* balance under sender's PK — kept locally
  //    so the holder can decrypt their own balance without BSGS next round.
  const senderBalancePCT = poseidon.poseidonEncryptInputs(
    [senderNewBalance],
    sender.publicKey,
  );

  // Field names must match transfer.circom signal declarations exactly. snarkjs
  // accepts native bigints and serialises them to field elements.
  const circuitInput = {
    ValueToTransfer: amount,
    SenderPrivateKey: sender.formattedPrivKey,
    SenderPublicKey: [sender.publicKey[0], sender.publicKey[1]],
    SenderBalance: senderBalance,
    SenderBalanceC1: [senderEncBalance.c1.x, senderEncBalance.c1.y],
    SenderBalanceC2: [senderEncBalance.c2.x, senderEncBalance.c2.y],
    SenderVTTC1: [senderVTT[0][0], senderVTT[0][1]],
    SenderVTTC2: [senderVTT[1][0], senderVTT[1][1]],
    ReceiverPublicKey: [receiverPk[0], receiverPk[1]],
    ReceiverVTTC1: [receiverVTT[0][0], receiverVTT[0][1]],
    ReceiverVTTC2: [receiverVTT[1][0], receiverVTT[1][1]],
    ReceiverVTTRandom: receiverVTTRandom,
    ReceiverPCT: receiverPCT.ciphertext,
    ReceiverPCTAuthKey: [receiverPCT.authKey[0], receiverPCT.authKey[1]],
    ReceiverPCTNonce: receiverPCT.nonce,
    ReceiverPCTRandom: receiverPCT.encRandom,
    AuditorPublicKey: [auditorPk[0], auditorPk[1]],
    AuditorPCT: auditorPCT.ciphertext,
    AuditorPCTAuthKey: [auditorPCT.authKey[0], auditorPCT.authKey[1]],
    AuditorPCTNonce: auditorPCT.nonce,
    AuditorPCTRandom: auditorPCT.encRandom,
  };

  const { proof, publicSignals } = await prover.proveGroth16(circuitInput, {
    wasmPath,
    zkeyPath,
  });

  if (publicSignals.length !== 32) {
    throw new Error(
      `transfer circuit returned ${publicSignals.length} public signals, expected 32`,
    );
  }

  return {
    proofPoints: prover.proofToBytes(proof),
    publicSignals: publicSignals.map((s) => BigInt(s)),
    balancePct: [
      ...senderBalancePCT.ciphertext,
      senderBalancePCT.authKey[0],
      senderBalancePCT.authKey[1],
      senderBalancePCT.nonce,
    ],
  };
}
