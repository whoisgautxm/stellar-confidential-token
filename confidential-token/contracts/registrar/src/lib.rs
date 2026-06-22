#![no_std]

use eerc_types::{address_to_field, u256_from_be32, Point, RegisterProof};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    vec, Address, Env, IntoVal, Symbol, U256, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier,
    ChainId,
    PublicKey(Address),
    Registered(U256),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidSender = 1,
    InvalidChainId = 2,
    InvalidRegistrationHash = 3,
    AlreadyRegistered = 4,
    ProofInvalid = 5,
    VerifierFailed = 6,
}

#[contracttype]
#[derive(Clone)]
pub struct VkProof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contract]
pub struct RegistrarContract;

#[contractimpl]
impl RegistrarContract {
    pub fn __constructor(env: Env, verifier: Address, chain_id: U256) {
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::ChainId, &chain_id);
    }

    pub fn register(env: Env, caller: Address, proof: RegisterProof) -> Result<(), Error> {
        caller.require_auth();

        if proof.public_signals.len() != 5 {
            return Err(Error::ProofInvalid);
        }

        let pk_x = proof.public_signals.get(0).unwrap();
        let pk_y = proof.public_signals.get(1).unwrap();
        let account_field = proof.public_signals.get(2).unwrap();
        let chain_id = proof.public_signals.get(3).unwrap();
        let registration_hash = proof.public_signals.get(4).unwrap();

        if account_field != address_to_field(&env, &caller) {
            return Err(Error::InvalidSender);
        }

        let configured_chain: U256 = env.storage().instance().get(&DataKey::ChainId).unwrap();
        if chain_id != configured_chain {
            return Err(Error::InvalidChainId);
        }

        let q = field_modulus(&env);
        if registration_hash >= q {
            return Err(Error::InvalidRegistrationHash);
        }

        if env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::Registered(registration_hash.clone()))
            .unwrap_or(false)
            && Self::is_user_registered(env.clone(), caller.clone())
        {
            return Err(Error::AlreadyRegistered);
        }

        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let ok = call_verifier(&env, &verifier, &proof)?;
        if !ok {
            return Err(Error::ProofInvalid);
        }

        env.storage().persistent().set(
            &DataKey::PublicKey(caller.clone()),
            &Point { x: pk_x, y: pk_y },
        );
        env.storage()
            .persistent()
            .set(&DataKey::Registered(registration_hash.clone()), &true);

        env.storage()
            .persistent()
            .extend_ttl(&DataKey::PublicKey(caller), 100, 518_400);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Registered(registration_hash), 100, 518_400);

        Ok(())
    }

    pub fn is_user_registered(env: Env, user: Address) -> bool {
        if let Some(pk) = env
            .storage()
            .persistent()
            .get::<_, Point>(&DataKey::PublicKey(user))
        {
            let zero = U256::from_u32(&env, 0);
            pk.x != zero || pk.y != zero
        } else {
            false
        }
    }

    pub fn get_user_public_key(env: Env, user: Address) -> Point {
        env.storage()
            .persistent()
            .get(&DataKey::PublicKey(user))
            .unwrap_or(Point {
                x: U256::from_u32(&env, 0),
                y: U256::from_u32(&env, 0),
            })
    }

    /// Debug-only: expose what the contract computes for an address.
    pub fn debug_address_field(env: Env, user: Address) -> U256 {
        address_to_field(&env, &user)
    }
}

fn field_modulus(env: &Env) -> U256 {
    u256_from_be32(
        env,
        [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81,
            0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93,
            0xf0, 0x00, 0x00, 0x01,
        ],
    )
}

fn call_verifier(env: &Env, verifier: &Address, proof: &RegisterProof) -> Result<bool, Error> {
    let vk_proof = VkProof {
        a: Bn254G1Affine::from_array(env, &proof.proof_points.a.to_array()),
        b: Bn254G2Affine::from_array(env, &proof.proof_points.b.to_array()),
        c: Bn254G1Affine::from_array(env, &proof.proof_points.c.to_array()),
    };
    let mut frs: Vec<Bn254Fr> = Vec::new(env);
    for s in proof.public_signals.iter() {
        frs.push_back(Bn254Fr::from_u256(s));
    }
    let args: Vec<Val> = vec![env, vk_proof.into_val(env), frs.into_val(env)];
    env.invoke_contract(verifier, &Symbol::new(env, "verify_proof"), args)
}
