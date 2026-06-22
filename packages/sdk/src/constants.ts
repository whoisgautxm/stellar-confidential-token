// BN254 scalar field modulus (curve order used by BabyJubJub circuits).
export const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// BabyJubJub base point order (subgroup order ℓ).
export const BASE_POINT_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type Stellar = "testnet" | "mainnet" | "local";

export const NETWORK_PASSPHRASE: Record<Stellar, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  local: "Standalone Network ; February 2017",
};

export const RPC_URL: Record<Stellar, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
  local: "http://localhost:8000/rpc",
};
