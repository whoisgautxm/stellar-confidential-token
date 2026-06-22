import { config as loadDotenv } from "dotenv";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { Point } from "@zk-kit/baby-jubjub";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkConfig } from "@confidential-token/sdk/stellar";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const packageRoot = resolve(__dirname, "..");

// Load .env from the CLI package directory, regardless of CWD.
loadDotenv({ path: join(packageRoot, ".env") });

export interface CliConfig {
  network: NetworkConfig;
  contractIds: {
    registrar?: string;
    verifierRegistration?: string;
    verifierTransfer?: string;
    verifierWithdraw?: string;
    confidentialToken?: string;
    sacToken?: string;
  };
  source: Keypair;
  chainId: bigint;
  artifactsDir: string;
  /** Auditor's Stellar G-address (informational). */
  auditorAddress?: string;
  /** Auditor's BabyJubJub public key — required for transfer/withdraw witnesses. */
  auditorPk?: Point<bigint>;
}

export function loadConfig(): CliConfig {
  const network = (process.env.STELLAR_NETWORK ?? "testnet") as
    | "testnet"
    | "mainnet"
    | "local";

  if (!process.env.STELLAR_SECRET) {
    throw new Error(
      "missing STELLAR_SECRET env var (use a funded testnet account)",
    );
  }
  const source = Keypair.fromSecret(process.env.STELLAR_SECRET);

  const cfgPath = join(repoRoot, "packages", "sdk", "config", `${network}.json`);
  let contractIds: CliConfig["contractIds"] = {};
  let auditorAddress: string | undefined;
  let auditorPk: Point<bigint> | undefined;
  if (existsSync(cfgPath)) {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    const { auditorAddress: addr, auditorPk: pk, ...rest } = raw;
    contractIds = rest as CliConfig["contractIds"];
    if (typeof addr === "string") auditorAddress = addr;
    if (pk && typeof pk === "object") {
      const { x, y } = pk as { x?: unknown; y?: unknown };
      if (typeof x === "string" && typeof y === "string") {
        auditorPk = [BigInt(x), BigInt(y)] as Point<bigint>;
      }
    }
  }

  return {
    network: { network },
    contractIds,
    source,
    // Must match the value passed to `--chain_id` when deploying the registrar.
    // Default deploy script uses 0; override via CHAIN_ID env if you redeployed.
    chainId: BigInt(process.env.CHAIN_ID ?? "0"),
    artifactsDir: join(repoRoot, "EncryptedERC", "circom", "build"),
    auditorAddress,
    auditorPk,
  };
}

export function persistContractId(name: keyof CliConfig["contractIds"], id: string) {
  const network = (process.env.STELLAR_NETWORK ?? "testnet") as string;
  const cfgPath = join(repoRoot, "packages", "sdk", "config", `${network}.json`);
  let current: Record<string, string> = {};
  if (existsSync(cfgPath)) current = JSON.parse(readFileSync(cfgPath, "utf8"));
  current[name] = id;
  writeFileSync(cfgPath, JSON.stringify(current, null, 2));
}

function hashChainId(_passphrase: string): bigint {
  // Unused — kept for reference; chainId comes from env / deploy time.
  return 0n;
}
