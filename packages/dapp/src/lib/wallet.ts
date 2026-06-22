// Freighter / Stellar Wallets Kit adapter.
//
// Provides:
//   - a singleton StellarWalletsKit configured for our network
//   - deriveBjjSeed(): asks Freighter to sign a deterministic message and
//     returns the 32 leading bytes of that signature as the BabyJubJub seed
//   - makeWalletSigner(): produces the SignXdr callback that the SDK's
//     invokeWithWallet helper expects
//
// CAVEAT: the BabyJubJub key derived here is not guaranteed to match the key
// you would get by signing the same message with the CLI (Keypair.sign). The
// CLI signs the raw bytes directly; Freighter's signMessage may add SEP-43
// domain framing. So: use one modality (CLI or dApp) per Stellar account.

import {
  FREIGHTER_ID,
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
} from "@creit.tech/stellar-wallets-kit";
import type { SignXdr } from "@confidential-token/sdk/stellar";

const NETWORK_MAP: Record<"testnet" | "mainnet" | "local", WalletNetwork> = {
  testnet: WalletNetwork.TESTNET,
  mainnet: WalletNetwork.PUBLIC,
  local: WalletNetwork.STANDALONE,
};

let _kit: StellarWalletsKit | null = null;

export function getKit(network: "testnet" | "mainnet" | "local"): StellarWalletsKit {
  if (_kit) return _kit;
  _kit = new StellarWalletsKit({
    network: NETWORK_MAP[network],
    selectedWalletId: FREIGHTER_ID,
    modules: allowAllModules(),
  });
  return _kit;
}

const DOMAIN = "confidential-token:v1:";

/**
 * Ask the wallet to sign the deterministic message and return the first 32
 * bytes of the (Ed25519) signature as a seed. We cache the seed in
 * localStorage keyed by address so the user is only prompted once.
 */
export async function deriveBjjSeed(
  kit: StellarWalletsKit,
  address: string,
): Promise<Uint8Array> {
  const key = `ctoken:seed:${address}`;
  const cached = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  if (cached) return hexToBytes(cached);

  const message = DOMAIN + address;
  const { signedMessage } = await kit.signMessage(message, { address });
  // Freighter returns the signature base64-encoded. Decode and slice.
  const bytes = base64ToBytes(signedMessage);
  if (bytes.length < 32) {
    throw new Error(
      `wallet returned ${bytes.length}-byte signed message; need >= 32 for BJJ seed`,
    );
  }
  const seed = bytes.slice(0, 32);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(key, bytesToHex(seed));
  }
  return seed;
}

export function clearCachedSeed(address: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`ctoken:seed:${address}`);
}

export function makeWalletSigner(kit: StellarWalletsKit): SignXdr {
  return async (xdr, opts) => {
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      networkPassphrase: opts.networkPassphrase,
      address: opts.address,
    });
    return { signedTxXdr };
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
