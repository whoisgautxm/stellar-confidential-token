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

export interface BuildWithdrawInput {
  sender: SenderKeypair;
  /** Plaintext stroop balance, recovered client-side via BSGS. */
  senderBalance: bigint;
  /** Current on-chain EGCT — must equal what `balance_of(sender)` returns. */
  senderEncBalance: EgctPoints;
  auditorPk: Point<bigint>;
  /** Stroop amount to unwrap. Must be > 0 and <= senderBalance. */
  amount: bigint;
  wasmPath: string;
  zkeyPath: string;
}

export interface BuiltWithdraw {
  proofPoints: { a: Uint8Array; b: Uint8Array; c: Uint8Array };
  /** Length 16, ordered to match the circuit's public-signals declaration order. */
  publicSignals: bigint[];
  /** Sender's new balance PCT: 7 elems [ct(4) | authKey(2) | nonce(1)]. */
  balancePct: bigint[];
  /**
   * Client-side ElGamal encryption of `amount` under sender's PK. The contract
   * subtracts this from the on-chain encrypted balance — see SECURITY NOTE in
   * confidential_token::withdraw.
   */
  amountEgct: {
    c1: { x: bigint; y: bigint };
    c2: { x: bigint; y: bigint };
  };
}

/**
 * Build a withdraw witness, generate the Groth16 proof, and serialise both the
 * proof and the client-side artefacts into Stellar-friendly types.
 *
 * Mirrors `withdraw()` from EncryptedERC/test/helpers.ts so the same circuit
 * (withdraw.wasm + circuit_final.zkey) accepts our witness without changes.
 */
export async function buildWithdraw(input: BuildWithdrawInput): Promise<BuiltWithdraw> {
  const {
    sender,
    senderBalance,
    senderEncBalance,
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

  // Client-side ElGamal encryption of the withdraw amount. The contract uses
  // this to subtract from the encrypted balance (it cannot derive it cheaply
  // on chain). The public SAC.transfer caps how much actual SAC can be drained
  // even if the client misencrypts; see SECURITY NOTE on the contract method.
  const { cipher: amountCipher } = jub.encryptScalar(sender.publicKey, amount);
  const amountEgct = {
    c1: { x: amountCipher[0][0], y: amountCipher[0][1] },
    c2: { x: amountCipher[1][0], y: amountCipher[1][1] },
  };

  // Poseidon-encrypt the withdraw amount for the auditor's summary.
  const auditorPCT = poseidon.poseidonEncryptInputs([amount], auditorPk);
  // Poseidon-encrypt sender's *new* balance under sender's PK — kept locally
  // so the holder can decrypt their own balance without BSGS next round.
  const senderBalancePCT = poseidon.poseidonEncryptInputs(
    [senderNewBalance],
    sender.publicKey,
  );

  // Field names must match withdraw.circom signal declarations exactly.
  const circuitInput = {
    ValueToWithdraw: amount,
    SenderPrivateKey: sender.formattedPrivKey,
    SenderPublicKey: [sender.publicKey[0], sender.publicKey[1]],
    SenderBalance: senderBalance,
    SenderBalanceC1: [senderEncBalance.c1.x, senderEncBalance.c1.y],
    SenderBalanceC2: [senderEncBalance.c2.x, senderEncBalance.c2.y],
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

  if (publicSignals.length !== 16) {
    throw new Error(
      `withdraw circuit returned ${publicSignals.length} public signals, expected 16`,
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
    amountEgct,
  };
}
