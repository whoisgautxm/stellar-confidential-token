# Architecture — Nebula (Confidential Token on Stellar, Option A)

This document distills the design decisions for the Stellar Hacks: Real-World
ZK hackathon submission. The full upstream plan with diagrams lives in
[`.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md`](../.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md).

## Goal

Build a confidential fungible token on Soroban that:

- hides **balances** and **transfer amounts**
- keeps **sender/receiver addresses public** (Stellar confidential-token model)
- reuses Avalanche [EncryptedERC](https://github.com/ava-labs/EncryptedERC)
  circuits and TS crypto unchanged
- ports on-chain BabyJubJub Edwards arithmetic to Soroban guest Rust
- uses Stellar BN254 `pairing_check` host functions for Groth16 verification
- operates in **converter mode** wrapping a custom Stellar Asset Contract (SAC)

## Why Option A (guest BabyJubJub + host BN254 pairing)?

The eERC scheme uses **BabyJubJub** for ElGamal balance encryption and
**BN254** as the proving curve. They are different curves, so we cannot
substitute one with the other on chain.

- **BabyJubJub arithmetic** is implemented in guest Rust (`crates/baby-jubjub`).
  Edwards point add/sub are cheap; full scalar multiplication ended up being
  too expensive within the Soroban CPU budget for the deposit/withdraw
  encryption paths and was moved to the client (see [Client-side encryption](#client-side-encryption)).
- **Groth16 verification** uses `env.crypto().bn254().pairing_check`, the
  same primitive consumed by the [`groth16_verifier` Soroban example](https://github.com/stellar/soroban-examples/tree/main/groth16_verifier).

Option B (rewrite the scheme on BN254 G1 ElGamal) was rejected: the entire
eERC circuit set, audit literature, and TypeScript client would have to be
redone.

## Contract decomposition

Each contract is a separate Wasm to stay under the 64 KB per-contract limit
and to allow independent verifier upgrades:

| Contract                  | Purpose                                  |
|---------------------------|------------------------------------------|
| `verifier-registration`   | Groth16 verifier, 5 public signals       |
| `verifier-transfer`       | Groth16 verifier, 32 public signals      |
| `verifier-withdraw`       | Groth16 verifier, 16 public signals      |
| `registrar`               | User → BabyJubJub PK map; calls registration verifier |
| `confidential-token`      | Main orchestrator (deposit/transfer/withdraw/set_auditor) |

The main contract talks to the verifiers and to the registrar via
`env.invoke_contract` to keep its WASM small and avoid linker collisions on
the shared `verify_proof` export.

### Storage keys

| Key                                | Storage     | Purpose                                  |
|------------------------------------|-------------|------------------------------------------|
| `DataKey::Admin`                   | instance    | admin Stellar address                    |
| `DataKey::Registrar`               | instance    | registrar contract id                    |
| `DataKey::SacToken`                | instance    | SAC contract id (single-asset allowlist) |
| `DataKey::TransferVerifier`        | instance    | transfer verifier id                     |
| `DataKey::WithdrawVerifier`        | instance    | withdraw verifier id                     |
| `DataKey::Auditor` + `AuditorPk`   | instance    | compliance auditor address + BabyJubJub PK |
| `DataKey::Balance(addr)`           | persistent  | `EncryptedBalance` (EGCT + nonce + tx_index + balance_pct) |
| `DataKey::BalanceHash(addr, h)`    | persistent  | replay-protection valid balance map      |

Persistent storage is TTL-extended on every write.

## End-to-end flows

### Registration

```
SDK derives BabyJubJub keypair from Stellar Ed25519 signature →
SDK builds Groth16 proof for registration circuit →
client calls registrar.register(caller, proof) →
registrar checks: chain id match, address-as-field match, hash < BN254 Fr,
not-already-registered, then calls verifier.verify_proof via invoke_contract,
then stores public key.
```

The auditor is configured separately via
[`confidential_token.set_auditor(admin, auditor_addr, public_key)`](../confidential-token/contracts/confidential-token/src/lib.rs).
For demo, the script [`scripts/set-auditor.sh`](../scripts/set-auditor.sh)
reuses the `admin` Stellar key as the auditor and writes its derived
BabyJubJub pubkey to `packages/sdk/config/testnet.json` so client witness
builders can use it.

### Deposit (no ZK proof, client-encrypted EGCT)

```
SDK encrypts amount with sender PK locally (jub.encryptScalar) →
user signs deposit(user, amount, egct, amount_pct) →
main contract: SAC.transfer(user → contract, amount),
               homomorphically add egct to balance.egct,
               commit BalanceHash(user, h(egct, nonce)).
```

The amount is public on the SAC.transfer boundary, so misencryption can only
corrupt the user's own future balance reads — there is no risk to the protocol
beyond that. On-chain scalar multiplication for the encryption was tried first
but exceeded the Soroban CPU budget; client-side encryption is the standard
escape hatch.

### Private transfer

```
SDK fetches encrypted balance, decrypts + BSGS locally, picks transfer amount →
SDK builds 32-public-signal Groth16 proof:
  [0,1]   sender PK
  [2..5]  current balance EGCT (must match on-chain)
  [6..9]  sender-side amount EGCT (encrypted under sender PK)
  [10,11] receiver PK
  [12..15] receiver-side amount EGCT
  [16..22] receiver PCT (Poseidon-encrypted amount for auditable view)
  [23,24] auditor PK
  [25..31] auditor PCT
SDK also computes balance_pct = Poseidon-encrypted new balance under sender PK
client calls transfer(from, to, proof, balance_pct) →
main contract: verify_proof, check PK/auditor binding, verify balance hash,
homomorphic EGCT sub from sender, add to receiver, store new balance_pct,
emit PrivateTransferEvent { from, to } with no amount.
```

### Withdraw

```
SDK fetches encrypted balance, decrypts + BSGS locally →
SDK encrypts the withdraw amount with sender PK locally (jub.encryptScalar) →
SDK builds 16-public-signal Groth16 proof:
  [0]    ValueToWithdraw (public scalar amount)
  [1,2]  sender PK
  [3..6] current balance EGCT
  [7,8]  auditor PK
  [9..15] auditor PCT (ciphertext + authKey + nonce)
SDK also computes balance_pct = Poseidon-encrypted new balance under sender PK
client calls withdraw(user, amount, egct, proof, balance_pct) →
main contract: verify_proof,
               check ValueToWithdraw == i128 amount,
               check sender PK matches registered key,
               check auditor PK matches stored auditor,
               subtract egct from balance.egct (client-trusted EGCT),
               SAC.transfer(contract → user, amount),
               commit new BalanceHash + balance_pct,
               emit WithdrawEvent { user, amount }.
```

#### Withdraw security caveat (hackathon scope)

The withdraw circuit proves `SenderBalance >= ValueToWithdraw` but does **not**
emit a sender-amount EGCT (unlike transfer). To avoid on-chain scalar mul
(too expensive for the Soroban budget) we accept the EGCT from the client.

An honest client passes `egct = encrypt(senderPK, amount)`. A malicious client
could pass `encrypt(0)` and keep the encrypted balance unchanged while still
withdrawing public SAC. The cap on damage is the SAC escrow — a user can
only drain back what they originally deposited — but the encrypted-balance
ledger can be inflated by an attacker willing to "keep" a phantom balance.

Production should add `SenderVTTC1/C2` signals to `withdraw.circom` (mirroring
the structure of `transfer.circom`) and have the contract verify the
client-passed EGCT matches them. Out of scope for this prototype.

## Replay & balance-hash model

Ported from eERC's [`EncryptedUserBalances.sol`](../EncryptedERC/contracts/EncryptedUserBalances.sol):

- Every balance write commits `sha256(hash_egct(balance) || nonce)` to
  persistent storage as a valid-balance marker.
- Every state-changing operation that reads the balance (transfer, withdraw)
  takes the user's "provided balance" from public signals and checks the
  composite hash exists — this binds the proof to the most recent balance
  snapshot and rejects stale proofs.
- The nonce monotonically increments on every burn-side operation
  (transfer-from-sender, withdraw); deposit-side operations only bump
  `transaction_index`, not `nonce`.

We use SHA-256 instead of Poseidon for the on-chain hash because the Poseidon
host function (CAP-0075) is not yet implemented on testnet at the time of
writing. The circuit-side hash is still Poseidon over BN254 — the contract
hash is a separate domain-separated tag.

## Client / SDK

`packages/sdk` is the TypeScript port of `EncryptedERC/src/`:

- [`jub.ts`](../packages/sdk/src/jub.ts) — keypair derivation from a 32-byte
  seed, ElGamal encrypt/decrypt, bounded BSGS discrete log to recover small
  integer balances.
- [`poseidon.ts`](../packages/sdk/src/poseidon.ts) — Poseidon-encrypted PCTs
  (Plaintext Cipher Tokens) for the auditor/balance metadata fields.
- [`prover.ts`](../packages/sdk/src/prover.ts) — snarkjs wrapper that
  produces Groth16 proofs and serializes them to the 64/128/64-byte layout
  that Stellar BN254 verifiers expect.
- [`stellar.ts`](../packages/sdk/src/stellar.ts) — RPC server, ScVal helpers,
  single-shot invoke that simulates then submits and waits for finality.
- [`balance.ts`](../packages/sdk/src/balance.ts) — typed shape of
  `confidential_token.balance_of` and a shared `decryptBalance` helper that
  combines ElGamal decrypt + BSGS.
- [`transfer.ts`](../packages/sdk/src/transfer.ts) — full witness builder for
  the 32-signal transfer circuit, returns ready-to-submit `proofPoints`,
  `publicSignals`, and the sender's new `balance_pct`.
- [`withdraw.ts`](../packages/sdk/src/withdraw.ts) — full witness builder for
  the 16-signal withdraw circuit, returns `proofPoints`, `publicSignals`,
  `balance_pct`, and a client-encrypted `amountEgct` for the contract.

### Key derivation

eERC derives the BabyJubJub private key from an EIP-712 signature. On Stellar
we sign a domain-separated message with the user's Ed25519 wallet key:

```
seed = Ed25519.sign(`confidential-token:v1:${address}`)
privateKey = BigInt(seed[0..32]) mod ℓ
```

This binds the keypair to the wallet's secret while staying compatible with
the eERC circuits. The same derivation is used by [`scripts/_derive-pubkey.ts`](../scripts/_derive-pubkey.ts)
to compute the auditor's BabyJubJub PK from its Stellar secret.

### Address → field encoding

The registration circuit takes the account address as a BN254 field element.
We compute it as `big-endian first 31 bytes of the strkey`, padded with a
leading zero, guaranteeing the value is `< 2^248 < BN254_Fr_modulus` so
snarkjs does not silently reduce. Both the contract
([`eerc-types::address_to_field`](../confidential-token/crates/eerc-types/src/lib.rs))
and the CLI
([`register.ts addressToField`](../packages/cli/src/commands/register.ts))
implement this identical scheme.

## Security posture

- Verifier-only crypto in the verifier contracts (no policy logic).
- All four state-changing entrypoints call `require_auth()` on the caller.
- Single-SAC allowlist enforced at construction time; no arbitrary token
  parameter accepted.
- Balance hash + nonce protects against proof replay.
- TTL extension on every persistent write.
- Sender / receiver / auditor PK binding checked on every transfer.
- Sender / auditor PK binding checked on every withdraw.
- This codebase is **not audited**. Hackathon prototype only.

## Known limitations

1. **Withdraw amount-EGCT is client-trusted** — see the security caveat
   above. Fix requires extending the withdraw circuit.
2. **Auditor PCT well-formedness** is enforced at the circuit level for
   transfer (`CheckPCT`); the contract additionally binds the auditor PK
   match. We do not yet ship an end-to-end auditor-side decrypt CLI; the
   Poseidon helpers in `packages/sdk/poseidon.ts` are sufficient to build
   one in ~50 lines.
3. **Per-tx amount history** is dropped on the contract side
   (`add_to_balance` constructs an `AmountPct` struct then never persists it).
   Adding append-only history would increase storage cost and is out of scope.
4. **BN254 + Poseidon CAP status** — verify both are live on the target
   network before deploying. See `.cursor/rules/stellar-zk-hackathon.mdc`.

## File map

- Plan: [`.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md`](../.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md)
- Soroban workspace: [`confidential-token/`](../confidential-token/)
- TS SDK: [`packages/sdk/`](../packages/sdk/)
- CLI: [`packages/cli/`](../packages/cli/)
- dApp scaffold: [`packages/dapp/`](../packages/dapp/)
- Scripts: [`scripts/`](../scripts/)
