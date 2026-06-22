// snarkjs wrapper for generating Groth16 proofs against the eERC circuits.
// Reuses the prebuilt artifacts in EncryptedERC/circom/build/<circuit>/.

// @ts-ignore — snarkjs has no shipped types
import * as snarkjs from "snarkjs";

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

export interface ProverArtifacts {
  /** absolute path to <circuit>.wasm */
  wasmPath: string;
  /** absolute path to circuit_final.zkey */
  zkeyPath: string;
}

export async function proveGroth16(
  inputs: Record<string, unknown>,
  artifacts: ProverArtifacts,
): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    artifacts.wasmPath,
    artifacts.zkeyPath,
  );
  return { proof: proof as Groth16Proof, publicSignals: publicSignals as string[] };
}

/**
 * Serialize a Groth16 proof into the uncompressed 64/128/64 byte layout that
 * Stellar's BN254 host functions expect. Coordinates are stored big-endian.
 */
export function proofToBytes(proof: Groth16Proof): {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
} {
  const a = g1ToBytes(proof.pi_a[0], proof.pi_a[1]);
  const b = g2ToBytes(proof.pi_b[0], proof.pi_b[1]);
  const c = g1ToBytes(proof.pi_c[0], proof.pi_c[1]);
  return { a, b, c };
}

function fpToBytes(v: string): Uint8Array {
  const hex = BigInt(v).toString(16).padStart(64, "0");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function g1ToBytes(x: string, y: string): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(fpToBytes(x), 0);
  buf.set(fpToBytes(y), 32);
  return buf;
}

function g2ToBytes(
  x: [string, string],
  y: [string, string],
): Uint8Array {
  // BN254 G2 element order in Stellar's serialization is x.c1, x.c0, y.c1, y.c0
  // matching circom/snarkjs layout (pi_b[i] = [c0, c1]) — swap to [c1, c0].
  const buf = new Uint8Array(128);
  buf.set(fpToBytes(x[1]), 0);
  buf.set(fpToBytes(x[0]), 32);
  buf.set(fpToBytes(y[1]), 64);
  buf.set(fpToBytes(y[0]), 96);
  return buf;
}
