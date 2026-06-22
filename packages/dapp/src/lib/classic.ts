// Classic (non-Soroban) Stellar operations that the dApp needs in order to
// onboard a brand-new Freighter account onto our test asset. Today this is
// limited to ChangeTrust so the user can hold CONF — the actual CONF payment
// has to come from the asset distributor, which lives in the CLI keyring.
//
// All ops here are built with @stellar/stellar-sdk, simulated, and submitted
// to Horizon REST endpoints. We deliberately use Horizon (not Soroban RPC)
// because Soroban RPC won't process classic-only operations.

import {
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { SignXdr } from "@confidential-token/sdk/stellar";

const HORIZON_URL: Record<"testnet" | "mainnet" | "local", string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  local: "http://localhost:8000",
};

const PASSPHRASE: Record<"testnet" | "mainnet" | "local", string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  local: Networks.STANDALONE,
};

/**
 * Establishes a trustline from `sourceAddress` to `code:issuer`. Idempotent —
 * if the trustline already exists, Stellar returns op_already_exists and we
 * surface that as a no-op. The wallet (Freighter) signs the transaction.
 */
export async function changeTrust(args: {
  network: "testnet" | "mainnet" | "local";
  sourceAddress: string;
  sign: SignXdr;
  code: string;
  issuer: string;
  limit?: string;
}): Promise<{ hash: string; skipped: boolean }> {
  const { network, sourceAddress, sign, code, issuer, limit } = args;
  const horizonUrl = HORIZON_URL[network];
  const passphrase = PASSPHRASE[network];

  const server = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith("http://") });
  const account = await server.loadAccount(sourceAddress);

  const asset = new Asset(code, issuer);

  const tx: Transaction = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.changeTrust({ asset, limit }))
    .setTimeout(60)
    .build();

  const signed = await sign(tx.toXDR(), { networkPassphrase: passphrase, address: sourceAddress });
  const signedXdr = typeof signed === "string" ? signed : signed.signedTxXdr;
  const signedTx = TransactionBuilder.fromXDR(signedXdr, passphrase) as Transaction;

  try {
    const res = await server.submitTransaction(signedTx);
    return { hash: res.hash, skipped: false };
  } catch (e) {
    const codes = extractOpCodes(e);
    if (codes.includes("op_already_exists")) {
      return { hash: "", skipped: true };
    }
    const msg = codes.length ? `tx_failed (${codes.join(",")})` : errorMsg(e);
    throw new Error(msg);
  }
}

function extractOpCodes(e: unknown): string[] {
  if (!e || typeof e !== "object") return [];
  const r = (e as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } })
    .response?.data?.extras?.result_codes?.operations;
  return Array.isArray(r) ? r : [];
}

function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
