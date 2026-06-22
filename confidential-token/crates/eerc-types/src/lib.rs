#![no_std]

use soroban_sdk::{contracttype, Address, Bytes, U256, Vec};

pub const PCT_LEN: u32 = 7;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Point {
    pub x: U256,
    pub y: U256,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Egct {
    pub c1: Point,
    pub c2: Point,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmountPct {
    pub pct: Vec<U256>,
    pub index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceHistory {
    pub index: u32,
    pub is_valid: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedBalance {
    pub egct: Egct,
    pub nonce: u32,
    pub transaction_index: u32,
    pub balance_pct: Vec<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofPoints {
    pub a: soroban_sdk::BytesN<64>,
    pub b: soroban_sdk::BytesN<128>,
    pub c: soroban_sdk::BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisterProof {
    pub proof_points: ProofPoints,
    pub public_signals: Vec<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferProof {
    pub proof_points: ProofPoints,
    pub public_signals: Vec<U256>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawProof {
    pub proof_points: ProofPoints,
    pub public_signals: Vec<U256>,
}

/// Encode a Stellar `Address` into a BN254 scalar field element for registration circuits.
/// Takes the first 31 ASCII bytes of the strkey, big-endian, with a leading zero
/// byte. This guarantees the value is < 2^248 < BN254 Fr modulus so the circuit
/// can use it as a field element without modular reduction surprises.
pub fn address_to_field(env: &soroban_sdk::Env, addr: &Address) -> U256 {
    let bytes = addr.to_string().to_bytes();
    let mut raw = [0u8; 32];
    let len = bytes.len().min(31) as u32;
    for i in 0..len {
        raw[31 - i as usize] = bytes.get(len - 1 - i).unwrap();
    }
    u256_from_be32(env, raw)
}

pub fn u256_from_be32(env: &soroban_sdk::Env, bytes: [u8; 32]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &bytes))
}

pub fn hash_egct(env: &soroban_sdk::Env, egct: &Egct) -> U256 {
    let mut data = Bytes::new(env);
    data.append(&egct.c1.x.to_be_bytes());
    data.append(&egct.c1.y.to_be_bytes());
    data.append(&egct.c2.x.to_be_bytes());
    data.append(&egct.c2.y.to_be_bytes());
    let hash: Bytes = env.crypto().sha256(&data).into();
    U256::from_be_bytes(env, &hash)
}

pub fn u256_from_hash(env: &soroban_sdk::Env, hash: soroban_sdk::crypto::Hash<32>) -> U256 {
    let bytes: Bytes = hash.into();
    U256::from_be_bytes(env, &bytes)
}
