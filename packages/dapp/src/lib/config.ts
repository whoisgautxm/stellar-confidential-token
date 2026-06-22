import type { Point } from "@zk-kit/baby-jubjub";
import type { NetworkConfig } from "@confidential-token/sdk/stellar";

const network = (import.meta.env.VITE_NETWORK as "testnet" | "mainnet" | "local") ?? "testnet";

export const cfg: {
  network: NetworkConfig;
  chainId: bigint;
  contracts: {
    registrar: string;
    confidentialToken: string;
    sacToken: string;
    verifierRegistration: string;
    verifierTransfer: string;
    verifierWithdraw: string;
  };
  auditor: {
    address: string;
    publicKey: Point<bigint>;
  };
  asset: {
    code: string;
    issuer: string;
  };
  /** URLs for snarkjs circuit artifacts served by Vite from `public/circuits/`. */
  artifacts: {
    registration: { wasm: string; zkey: string };
    transfer: { wasm: string; zkey: string };
    withdraw: { wasm: string; zkey: string };
  };
} = {
  network: { network },
  // Must match the chain id passed to --chain_id at registrar deploy time.
  // deploy-testnet.sh defaults to 0; override at build time with VITE_CHAIN_ID.
  chainId: BigInt(import.meta.env.VITE_CHAIN_ID ?? "0"),
  contracts: {
    registrar: requiredEnv("VITE_REGISTRAR_ID"),
    confidentialToken: requiredEnv("VITE_CONFIDENTIAL_TOKEN_ID"),
    sacToken: requiredEnv("VITE_SAC_ID"),
    verifierRegistration: requiredEnv("VITE_VERIFIER_REGISTRATION_ID"),
    verifierTransfer: requiredEnv("VITE_VERIFIER_TRANSFER_ID"),
    verifierWithdraw: requiredEnv("VITE_VERIFIER_WITHDRAW_ID"),
  },
  auditor: {
    address: requiredEnv("VITE_AUDITOR_ADDRESS"),
    publicKey: [
      BigInt(requiredEnv("VITE_AUDITOR_PK_X")),
      BigInt(requiredEnv("VITE_AUDITOR_PK_Y")),
    ] as Point<bigint>,
  },
  asset: {
    code: (import.meta.env.VITE_ASSET_CODE as string | undefined) ?? "CONF",
    issuer: (import.meta.env.VITE_ASSET_ISSUER as string | undefined) ?? "",
  },
  artifacts: {
    registration: {
      wasm: "/circuits/registration/registration.wasm",
      zkey: "/circuits/registration/registration.zkey",
    },
    transfer: {
      wasm: "/circuits/transfer/transfer.wasm",
      zkey: "/circuits/transfer/transfer.zkey",
    },
    withdraw: {
      wasm: "/circuits/withdraw/withdraw.wasm",
      zkey: "/circuits/withdraw/withdraw.zkey",
    },
  },
};

function requiredEnv(name: string): string {
  const v = import.meta.env[name] as string | undefined;
  if (!v || v.length === 0) {
    throw new Error(
      `dApp env ${name} is not set — run \`npm run sync-env\` in packages/dapp/ ` +
        `after deploying contracts. Last value: ${v}`,
    );
  }
  return v;
}
