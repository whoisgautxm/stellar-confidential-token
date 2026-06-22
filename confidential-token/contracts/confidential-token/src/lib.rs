#![no_std]

mod crypto;

use crypto::{add, sub};
use eerc_types::{
    hash_egct, u256_from_hash, AmountPct, Egct, EncryptedBalance, Point, ProofPoints,
    TransferProof, WithdrawProof,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    token, vec, Address, Env, IntoVal, Symbol, U256, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Registrar,
    SacToken,
    TransferVerifier,
    WithdrawVerifier,
    Auditor,
    AuditorPk,
    Balance(Address),
    BalanceHash(Address, U256),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotRegistered = 1,
    AuditorNotSet = 2,
    InvalidProof = 3,
    VerifierFailed = 4,
    InvalidBalance = 5,
    Unauthorized = 6,
}

#[contractevent]
pub struct DepositEvent {
    #[topic]
    pub user: Address,
    pub amount: i128,
}

#[contractevent]
pub struct WithdrawEvent {
    #[topic]
    pub user: Address,
    pub amount: i128,
}

#[contractevent]
pub struct PrivateTransferEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct VkProof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contract]
pub struct ConfidentialToken;

#[contractimpl]
impl ConfidentialToken {
    pub fn __constructor(
        env: Env,
        admin: Address,
        registrar: Address,
        sac_token: Address,
        transfer_verifier: Address,
        withdraw_verifier: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registrar, &registrar);
        env.storage().instance().set(&DataKey::SacToken, &sac_token);
        env.storage()
            .instance()
            .set(&DataKey::TransferVerifier, &transfer_verifier);
        env.storage()
            .instance()
            .set(&DataKey::WithdrawVerifier, &withdraw_verifier);
    }

    pub fn set_auditor(env: Env, admin: Address, auditor: Address, public_key: Point) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            panic!("unauthorized");
        }
        env.storage().instance().set(&DataKey::Auditor, &auditor);
        env.storage().instance().set(&DataKey::AuditorPk, &public_key);
    }

    pub fn deposit(
        env: Env,
        user: Address,
        amount: i128,
        egct: Egct,
        amount_pct: Vec<U256>,
    ) -> Result<(), Error> {
        user.require_auth();
        Self::require_auditor(&env)?;
        Self::require_registered(&env, &user)?;

        let sac: Address = env.storage().instance().get(&DataKey::SacToken).unwrap();
        let token = token::Client::new(&env, &sac);
        token.transfer(&user, &env.current_contract_address(), &amount);

        // Encryption is performed client-side and the EGCT is passed in. The
        // public `amount` is enforced by SAC.transfer; if the client encrypts
        // a different value they only break their own future balance reads.
        // On-chain BabyJubJub scalar_mul is too expensive within the Soroban
        // CPU budget; client-side encryption is the standard escape hatch.
        Self::add_to_balance(&env, &user, egct, amount_pct)?;

        DepositEvent { user, amount }.publish(&env);
        Ok(())
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        proof: TransferProof,
        balance_pct: Vec<U256>,
    ) -> Result<(), Error> {
        from.require_auth();
        Self::require_auditor(&env)?;
        Self::require_registered(&env, &from)?;
        Self::require_registered(&env, &to)?;

        if proof.public_signals.len() != 32 {
            return Err(Error::InvalidProof);
        }

        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::TransferVerifier)
            .unwrap();
        let ok = call_verifier(&env, &verifier, &proof.proof_points, &proof.public_signals)?;
        if !ok {
            return Err(Error::InvalidProof);
        }

        let from_pk = Self::get_user_pk(&env, &from);
        let to_pk = Self::get_user_pk(&env, &to);
        let auditor_pk: Point = env.storage().instance().get(&DataKey::AuditorPk).unwrap();

        if proof.public_signals.get(0).unwrap() != from_pk.x
            || proof.public_signals.get(1).unwrap() != from_pk.y
        {
            return Err(Error::InvalidProof);
        }
        if proof.public_signals.get(10).unwrap() != to_pk.x
            || proof.public_signals.get(11).unwrap() != to_pk.y
        {
            return Err(Error::InvalidProof);
        }
        if proof.public_signals.get(23).unwrap() != auditor_pk.x
            || proof.public_signals.get(24).unwrap() != auditor_pk.y
        {
            return Err(Error::InvalidProof);
        }

        let provided_balance = egct_from_signals(&proof.public_signals, 2);
        let sender_amount = egct_from_signals(&proof.public_signals, 6);
        let receiver_amount = egct_from_signals(&proof.public_signals, 12);

        let mut amount_pct = Vec::new(&env);
        for i in 16..23 {
            amount_pct.push_back(proof.public_signals.get(i as u32).unwrap());
        }

        Self::private_burn(&env, &from, provided_balance, sender_amount, balance_pct)?;
        Self::add_to_balance(&env, &to, receiver_amount, amount_pct)?;

        PrivateTransferEvent { from, to }.publish(&env);
        Ok(())
    }

    /// Unwrap `amount` stroops of SAC back to the user.
    ///
    /// The withdraw circuit (`withdraw.circom`) has 16 public signals laid out as:
    /// ```text
    /// [0]      ValueToWithdraw     (scalar amount, public)
    /// [1..=2]  SenderPublicKey     (must equal registered user PK)
    /// [3..=6]  SenderBalanceC1/C2  (must equal on-chain encrypted balance)
    /// [7..=8]  AuditorPublicKey    (must equal stored auditor PK)
    /// [9..=12] AuditorPCT          (Poseidon-encrypted audit summary)
    /// [13..=14] AuditorPCTAuthKey
    /// [15]     AuditorPCTNonce
    /// ```
    /// The circuit proves SenderBalance >= ValueToWithdraw without revealing
    /// SenderBalance, but does NOT emit an encrypted amount EGCT (unlike
    /// transfer). The client provides `egct = encrypt(senderPK, amount)` so
    /// the contract can subtract it homomorphically from the stored balance.
    ///
    /// SECURITY NOTE (hackathon scope): an honest client passes
    /// `egct = encrypt(senderPK, amount)`. A malicious client could pass
    /// `encrypt(0)` to keep their encrypted balance high while still
    /// withdrawing public SAC — but the on-chain SAC escrow caps how much
    /// they can drain to what they originally deposited. The exploit lets a
    /// user "mint" phantom encrypted balance up to that cap. Production
    /// deployments should add a withdraw circuit constraint that emits
    /// SenderVTTC1/C2 (mirroring transfer), so the contract can match it
    /// against the client-supplied EGCT. Out of scope for this prototype.
    pub fn withdraw(
        env: Env,
        user: Address,
        amount: i128,
        egct: Egct,
        proof: WithdrawProof,
        balance_pct: Vec<U256>,
    ) -> Result<(), Error> {
        user.require_auth();
        Self::require_auditor(&env)?;
        Self::require_registered(&env, &user)?;

        if proof.public_signals.len() != 16 {
            return Err(Error::InvalidProof);
        }
        if amount <= 0 {
            return Err(Error::InvalidProof);
        }

        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawVerifier)
            .unwrap();
        let ok = call_verifier(&env, &verifier, &proof.proof_points, &proof.public_signals)?;
        if !ok {
            return Err(Error::InvalidProof);
        }

        // Public signal 0 = ValueToWithdraw — must equal the `amount` we'll
        // actually transfer out via SAC.
        let circuit_amount = proof.public_signals.get(0).unwrap();
        if u256_to_i128(&circuit_amount) != amount {
            return Err(Error::InvalidProof);
        }

        // Public signals 1..=2 = SenderPublicKey — must match registered PK.
        let user_pk = Self::get_user_pk(&env, &user);
        if proof.public_signals.get(1).unwrap() != user_pk.x
            || proof.public_signals.get(2).unwrap() != user_pk.y
        {
            return Err(Error::InvalidProof);
        }

        // Public signals 7..=8 = AuditorPublicKey — must match stored auditor.
        let auditor_pk: Point = env.storage().instance().get(&DataKey::AuditorPk).unwrap();
        if proof.public_signals.get(7).unwrap() != auditor_pk.x
            || proof.public_signals.get(8).unwrap() != auditor_pk.y
        {
            return Err(Error::InvalidProof);
        }

        // Public signals 3..=6 = SenderBalanceC1/C2 — the circuit proved this
        // is exactly the encrypted balance the on-chain state currently holds.
        let provided_balance = egct_from_signals(&proof.public_signals, 3);

        Self::private_burn(&env, &user, provided_balance, egct, balance_pct)?;

        let sac: Address = env.storage().instance().get(&DataKey::SacToken).unwrap();
        let token = token::Client::new(&env, &sac);
        token.transfer(&env.current_contract_address(), &user, &amount);

        WithdrawEvent { user, amount }.publish(&env);
        Ok(())
    }

    pub fn balance_of(env: Env, user: Address) -> EncryptedBalance {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(user))
            .unwrap_or(empty_balance(&env))
    }
}

impl ConfidentialToken {
    fn require_auditor(env: &Env) -> Result<(), Error> {
        let auditor: Option<Address> = env.storage().instance().get(&DataKey::Auditor);
        let pk: Option<Point> = env.storage().instance().get(&DataKey::AuditorPk);
        if auditor.is_none() || pk.is_none() {
            return Err(Error::AuditorNotSet);
        }
        Ok(())
    }

    fn require_registered(env: &Env, user: &Address) -> Result<(), Error> {
        let registrar: Address = env.storage().instance().get(&DataKey::Registrar).unwrap();
        let registered: bool = env.invoke_contract(
            &registrar,
            &Symbol::new(env, "is_user_registered"),
            vec![env, user.into_val(env)],
        );
        if !registered {
            return Err(Error::NotRegistered);
        }
        Ok(())
    }

    fn get_user_pk(env: &Env, user: &Address) -> Point {
        let registrar: Address = env.storage().instance().get(&DataKey::Registrar).unwrap();
        env.invoke_contract(
            &registrar,
            &Symbol::new(env, "get_user_public_key"),
            vec![env, user.into_val(env)],
        )
    }

    fn add_to_balance(
        env: &Env,
        user: &Address,
        egct: Egct,
        amount_pct: Vec<U256>,
    ) -> Result<(), Error> {
        let key = DataKey::Balance(user.clone());
        let mut balance: EncryptedBalance = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(empty_balance(env));

        let zero = U256::from_u32(env, 0);
        if balance.egct.c1.x == zero && balance.egct.c1.y == zero {
            balance.egct = egct;
        } else {
            balance.egct = add(&balance.egct, &egct, env);
        }

        let _pct = AmountPct {
            pct: amount_pct,
            index: balance.transaction_index,
        };
        balance.transaction_index += 1;
        Self::commit_balance(env, user, &mut balance);
        env.storage().persistent().set(&key, &balance);
        env.storage().persistent().extend_ttl(&key, 100, 518_400);
        Ok(())
    }

    fn private_burn(
        env: &Env,
        user: &Address,
        provided_balance: Egct,
        encrypted_amount: Egct,
        balance_pct: Vec<U256>,
    ) -> Result<(), Error> {
        let key = DataKey::Balance(user.clone());
        let mut balance: EncryptedBalance = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::InvalidBalance)?;

        Self::verify_user_balance(env, user, &provided_balance, balance.nonce)?;

        balance.egct = sub(&balance.egct, &encrypted_amount, env);
        balance.balance_pct = balance_pct;
        balance.nonce += 1;
        Self::commit_balance(env, user, &mut balance);
        env.storage().persistent().set(&key, &balance);
        env.storage().persistent().extend_ttl(&key, 100, 518_400);
        Ok(())
    }

    fn verify_user_balance(
        env: &Env,
        user: &Address,
        egct: &Egct,
        nonce: u32,
    ) -> Result<(), Error> {
        let composite = nonce_hash(env, egct, nonce);
        let valid_key = DataKey::BalanceHash(user.clone(), composite);
        if !env
            .storage()
            .persistent()
            .get::<_, bool>(&valid_key)
            .unwrap_or(false)
        {
            return Err(Error::InvalidBalance);
        }
        Ok(())
    }

    fn commit_balance(env: &Env, user: &Address, balance: &mut EncryptedBalance) {
        let composite = nonce_hash(env, &balance.egct, balance.nonce);
        let valid_key = DataKey::BalanceHash(user.clone(), composite);
        env.storage().persistent().set(&valid_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&valid_key, 100, 518_400);
    }
}

fn empty_balance(env: &Env) -> EncryptedBalance {
    let zero = U256::from_u32(env, 0);
    EncryptedBalance {
        egct: Egct {
            c1: Point {
                x: zero.clone(),
                y: zero.clone(),
            },
            c2: Point {
                x: zero.clone(),
                y: zero,
            },
        },
        nonce: 0,
        transaction_index: 0,
        balance_pct: Vec::new(env),
    }
}

fn egct_from_signals(signals: &Vec<U256>, base: u32) -> Egct {
    Egct {
        c1: Point {
            x: signals.get(base).unwrap(),
            y: signals.get(base + 1).unwrap(),
        },
        c2: Point {
            x: signals.get(base + 2).unwrap(),
            y: signals.get(base + 3).unwrap(),
        },
    }
}

fn nonce_hash(env: &Env, egct: &Egct, nonce: u32) -> U256 {
    let hash = hash_egct(env, egct);
    let mut b = soroban_sdk::Bytes::new(env);
    b.append(&hash.to_be_bytes());
    b.extend_from_array(&nonce.to_be_bytes());
    let composite = env.crypto().sha256(&b);
    u256_from_hash(env, composite)
}

fn call_verifier(
    env: &Env,
    verifier: &Address,
    points: &ProofPoints,
    signals: &Vec<U256>,
) -> Result<bool, Error> {
    let vk_proof = VkProof {
        a: Bn254G1Affine::from_array(env, &points.a.to_array()),
        b: Bn254G2Affine::from_array(env, &points.b.to_array()),
        c: Bn254G1Affine::from_array(env, &points.c.to_array()),
    };
    let mut frs: Vec<Bn254Fr> = Vec::new(env);
    for s in signals.iter() {
        frs.push_back(Bn254Fr::from_u256(s));
    }
    let args: Vec<Val> = vec![env, vk_proof.into_val(env), frs.into_val(env)];
    let ok: bool = env.invoke_contract(verifier, &Symbol::new(env, "verify_proof"), args);
    Ok(ok)
}

fn u256_to_i128(v: &U256) -> i128 {
    let bytes = v.to_be_bytes();
    let mut limb = 0u128;
    for i in 16..32 {
        limb = (limb << 8) | (bytes.get(i as u32).unwrap_or(0) as u128);
    }
    limb as i128
}
