import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  scValToNative,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL, type Stellar } from "./constants.js";

export interface NetworkConfig {
  network: Stellar;
  rpcUrl?: string;
  passphrase?: string;
}

export function getServer(cfg: NetworkConfig): rpc.Server {
  const url = cfg.rpcUrl ?? RPC_URL[cfg.network];
  return new rpc.Server(url, { allowHttp: url.startsWith("http://") });
}

export function passphraseFor(cfg: NetworkConfig): string {
  return cfg.passphrase ?? NETWORK_PASSPHRASE[cfg.network];
}

/** big-endian 32-byte field-element ScVal */
export function feScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u256" });
}

/** 64-byte ScVal for G1 proof point */
export function bytesNScVal(bytes: Uint8Array, expectedLen: number): xdr.ScVal {
  if (bytes.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

export function proofPointsScVal(
  a: Uint8Array,
  b: Uint8Array,
  c: Uint8Array,
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("a"),
      val: bytesNScVal(a, 64),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("b"),
      val: bytesNScVal(b, 128),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c"),
      val: bytesNScVal(c, 64),
    }),
  ]);
}

export function proofScVal(
  points: { a: Uint8Array; b: Uint8Array; c: Uint8Array },
  publicSignals: bigint[],
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("proof_points"),
      val: proofPointsScVal(points.a, points.b, points.c),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("public_signals"),
      val: xdr.ScVal.scvVec(publicSignals.map(feScVal)),
    }),
  ]);
}

/** Simulate + submit a single Soroban invocation, return the parsed return value. */
export async function invoke(
  cfg: NetworkConfig,
  source: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const server = getServer(cfg);
  const account = await server.getAccount(source.publicKey());
  const passphrase = passphraseFor(cfg);

  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  let tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(source);

  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(send.errorResult)}`);
  }

  let attempt = 0;
  while (attempt < 30) {
    await sleep(2000);
    const tr = await server.getTransaction(send.hash);
    if (tr.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      if (tr.returnValue) return scValToNative(tr.returnValue);
      return undefined;
    }
    if (tr.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`tx ${send.hash} failed`);
    }
    attempt++;
  }
  throw new Error(`tx ${send.hash} timed out`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function addressToScVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

/**
 * Sign an assembled Soroban transaction via an external signer (Freighter,
 * Stellar Wallets Kit, hardware wallet, etc.) and return the signed XDR.
 *
 * The signer receives the unsigned XDR string and must return either a signed
 * XDR string or an object containing `signedTxXdr`. This matches the surface
 * area exposed by `@creit.tech/stellar-wallets-kit`'s `signTransaction()`.
 */
export type SignXdr = (
  unsignedXdr: string,
  opts: { networkPassphrase: string; address: string },
) => Promise<{ signedTxXdr: string } | string>;

/**
 * Wallet-flavored counterpart to {@link invoke}. Simulates the operation
 * locally, asks the external signer to sign the assembled transaction, then
 * submits and waits for finality. Use this from any browser / dApp context
 * where the user's secret never leaves the wallet extension.
 */
export async function invokeWithWallet(
  cfg: NetworkConfig,
  sourceAddress: string,
  signXdr: SignXdr,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const server = getServer(cfg);
  const account = await server.getAccount(sourceAddress);
  const passphrase = passphraseFor(cfg);

  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  let tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }
  tx = rpc.assembleTransaction(tx, sim).build();

  const signed = await signXdr(tx.toXDR(), {
    networkPassphrase: passphrase,
    address: sourceAddress,
  });
  const signedXdr = typeof signed === "string" ? signed : signed.signedTxXdr;
  const signedTx = TransactionBuilder.fromXDR(signedXdr, passphrase) as Transaction;

  const send = await server.sendTransaction(signedTx);
  if (send.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(send.errorResult)}`);
  }

  let attempt = 0;
  while (attempt < 30) {
    await sleep(2000);
    const tr = await server.getTransaction(send.hash);
    if (tr.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      if (tr.returnValue) return scValToNative(tr.returnValue);
      return undefined;
    }
    if (tr.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`tx ${send.hash} failed`);
    }
    attempt++;
  }
  throw new Error(`tx ${send.hash} timed out`);
}

/**
 * Read-only contract call: simulates without ever submitting.
 * Returns the decoded ScVal (or undefined if the method returns void).
 * Use this for getters like `balance_of`, `get_user_pk`, etc.
 */
export async function readContract(
  cfg: NetworkConfig,
  sourceAddress: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const server = getServer(cfg);
  const account = await server.getAccount(sourceAddress);
  const passphrase = passphraseFor(cfg);

  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }
  // simulateTransaction returns the function's return value in result.retval
  if ("result" in sim && sim.result?.retval) {
    return scValToNative(sim.result.retval);
  }
  return undefined;
}
