# Nebula — Confidential Tokens on Stellar

> **Hackathon submission — Stellar Hacks: Real-World ZK.**
> Research prototype. Not audited. Testnet only.

> *A nebula is a visible cloud on the sky map that obscures the stars inside
> it — exactly the privacy model here: addresses stay public, balances stay
> hidden.*

**Nebula** is a confidential fungible token built on Soroban that hides
**balances and transfer amounts** while keeping **sender/receiver addresses
public** — the Stellar Confidential Token model. It reuses the
[Avalanche EncryptedERC](https://github.com/ava-labs/EncryptedERC) Circom
circuits and TypeScript crypto client, with on-chain BabyJubJub arithmetic
ported to Soroban guest Rust and Groth16 verification done via Stellar's
BN254 `pairing_check` host functions.

The full converter round-trip — register / deposit / private transfer /
withdraw — runs end-to-end on Stellar testnet today. See
[docs/submission.md](docs/submission.md) for the demo script and the
exact contract IDs.

## What it does

- **Register** — user publishes a BabyJubJub public key after proving they
  know the matching secret (Groth16 over the registration circuit; 5 public
  signals).
- **Deposit** — wraps a custom Stellar Asset Contract (SAC). The user
  transfers classic SAC to the confidential-token contract and provides a
  client-encrypted EGCT of the amount under their BabyJubJub PK; the contract
  homomorphically adds it to the user's encrypted balance.
- **Private transfer** — sender produces a Groth16 proof (32 public signals)
  that the new ciphertexts are well-formed and sum-consistent with their
  current encrypted balance; contract verifies the proof and updates encrypted
  balances for sender + receiver. The amount is hidden; addresses are public.
  No SAC movement.
- **Withdraw** — user produces a Groth16 proof (16 public signals) that they
  own enough encrypted balance, contract subtracts the client-encrypted amount
  EGCT and pays the public SAC amount back out.

## Repo layout

```
stellar-hackathon/
├── EncryptedERC/                          # Reference: circuits + TS crypto
├── confidential-token/                    # Soroban workspace (Rust)
│   ├── crates/baby-jubjub/                # Guest port of BabyJubJub Edwards arith
│   ├── crates/eerc-types/                 # Shared #[contracttype] structs
│   └── contracts/
│       ├── verifier-registration/         # Groth16 verifier (5 public signals)
│       ├── verifier-transfer/             # Groth16 verifier (32 public signals)
│       ├── verifier-withdraw/             # Groth16 verifier (16 public signals)
│       ├── registrar/                     # BabyJubJub PK registry
│       └── confidential-token/            # Main orchestrator (deposit/transfer/withdraw)
├── packages/
│   ├── sdk/                               # TS port of eERC + Stellar invoke glue
│   ├── cli/                               # ctoken register/deposit/transfer/withdraw/balance
│   └── dapp/                              # Vite/React + Freighter (UI scaffold)
├── scripts/
│   ├── issue-test-asset.sh                # Create CONF asset + deploy SAC
│   ├── deploy-testnet.sh                  # Build + deploy all 5 contracts
│   ├── set-auditor.sh                     # Configure auditor + persist its BabyJubJub pk
│   ├── redeploy-token-only.sh             # Rotate ONLY confidential_token; preserve registrations
│   ├── fund-conf.sh                       # Operator helper: send CONF to a dApp user's account
│   └── _derive-pubkey.ts                  # Stellar secret → BabyJubJub pubkey helper
└── docs/{architecture,deployment,submission}.md
```

Architecture decisions live in
[.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md](.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md)
and [docs/architecture.md](docs/architecture.md).

## Build & test

### Soroban contracts

```bash
cd confidential-token
cargo test -p baby-jubjub                  # native unit tests vs eERC vectors
cargo build --target wasm32v1-none --release
```

Artifacts land in `target/wasm32v1-none/release/*.wasm`. All five contracts
fit well under the 64 KB Wasm limit.

### TypeScript SDK + CLI

```bash
npm install
npm run typecheck -w @confidential-token/sdk
npm run typecheck -w @confidential-token/cli
```

### dApp (full end-to-end via Freighter)

```bash
cd packages/dapp
npm run dev    # auto-runs sync-env: writes .env from packages/sdk/config/<network>.json
               # and copies the circom wasm/zkey artifacts into public/circuits/
```

Open `http://localhost:5173`, install [Freighter](https://www.freighter.app/),
switch it to **testnet**. The dApp ships with self-serve onboarding for
brand-new accounts:

1. **Connect Freighter** → the dApp asks the wallet to sign a deterministic
   message and derives a BabyJubJub keypair from the signature (cached in
   `localStorage`).
2. **Fund XLM via Friendbot** (button under your address) — creates the
   account on testnet if it doesn't exist yet.
3. **Setup CONF trustline** (button under your address) — signs a classic
   `ChangeTrust` op via Freighter so your account can hold CONF.
4. Ask the operator to send you CONF: `./scripts/fund-conf.sh <your-address> 1000`.
5. **Register / Deposit / Balance / Transfer / Withdraw** tabs run the
   matching flows. The Activity panel shows every stage (witness build,
   Groth16 proof time, wallet sign, on-chain submit, BSGS time).

The dApp uses browser-side snarkjs and `@stellar/stellar-sdk` only — there
is no backend service. Private keys never leave Freighter.

## Deploying to testnet

Prerequisites: [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli),
Rust + `wasm32v1-none` target, `jq`, Node 20+.

```bash
# 1. Issue the test SAC (creates issuer/distributor accounts, mints 1M CONF)
./scripts/issue-test-asset.sh

# 2. Build + deploy all 5 Soroban contracts; persists IDs to packages/sdk/config/testnet.json
./scripts/deploy-testnet.sh

# 3. Configure the auditor (uses `admin` Stellar key for the demo; rotate in prod)
./scripts/set-auditor.sh

# 4. Set up CLI environment
cp packages/cli/.env.example packages/cli/.env  # set STELLAR_SECRET=<funded testnet key>
```

### Run the full flow

```bash
# As the admin / sender
npx tsx packages/cli/src/commands/register.ts
npx tsx packages/cli/src/commands/deposit.ts 100
npx tsx packages/cli/src/commands/balance.ts          # decrypts client-side

# Register a second account
stellar keys generate alice --network testnet --fund
ALICE_SECRET=$(stellar keys secret alice)
STELLAR_SECRET="$ALICE_SECRET" npx tsx packages/cli/src/commands/register.ts

# Private transfer (amount hidden on chain)
npx tsx packages/cli/src/commands/transfer.ts "$(stellar keys address alice)" 30

# Withdraw 20 back to the public SAC balance
npx tsx packages/cli/src/commands/withdraw.ts 20
```

See [docs/deployment.md](docs/deployment.md) for the full step-by-step
including before/after verification commands.

### Iterating on the contract

For quick iteration during dev:

```bash
./scripts/redeploy-token-only.sh    # rebuilds + redeploys ONLY confidential_token,
                                    # preserving user registrations in the registrar
```

A full `./scripts/deploy-testnet.sh` rotates every contract id (including the
registrar), which **invalidates all user registrations** — only use it when
you've changed registrar or verifier source.

## ZK & Stellar status notes

- **BN254 + `pairing_check`** is gated on [CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md);
  verify it is implemented on your target network's protocol version before
  deploying mainnet.
- **Poseidon host function** ([CAP-0075](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md))
  would let us drop the SHA-256 nonce-binding fallback; status-sensitive.
- This codebase pins `soroban-sdk = "26"` and targets `wasm32v1-none`.

## Performance characteristics observed on live testnet

| Operation | Component | Time |
|---|---|---|
| register | snarkjs Groth16 fullProve (Node) | ~1 s |
| register | on-chain `verify_proof` + storage write | ~3-4 s round-trip |
| deposit | client-side ElGamal encrypt | < 50 ms |
| deposit | on-chain SAC.transfer + EGCT add | ~3-4 s round-trip |
| transfer | snarkjs Groth16 fullProve (Node) | ~1 s |
| transfer | on-chain verify + 2 EGCT add/sub + 2 BalanceHash commits | ~3-4 s round-trip |
| withdraw | snarkjs Groth16 fullProve (Node) | ~0.6 s |
| withdraw | on-chain verify + EGCT sub + SAC.transfer | ~3-4 s round-trip |
| balance decrypt (BSGS) | bounded discrete log on BabyJubJub, default ceiling 2^28 stroops (~26 tokens) | ~0.5-1 s |

The BSGS ceiling is overridable via the `CTOKEN_BSGS_MAX` env var if you ever
demo larger balances.

## Security posture

- Verifier contracts check **cryptographic validity only** (Groth16 over the
  embedded VK).
- Main contract enforces: registration, auditor configured, balance hash +
  nonce validity, single SAC allowlist, sender/receiver/auditor PK binding on
  every transfer and withdraw.
- `Address::require_auth()` on every state-changing entrypoint.
- Encrypted balance state is **persistent** with TTL extension on every write.
- Private keys and plaintext amounts **never** touch on-chain storage.

### Known hackathon-scope security caveat

`deposit` and `withdraw` both accept a client-encrypted EGCT instead of doing
on-chain BabyJubJub scalar multiplication (which exceeds the Soroban CPU
budget). On deposit a misencryption only corrupts the user's own future
balance reads. On withdraw a malicious user can mint phantom encrypted
balance up to the public SAC cap they originally deposited — they cannot
drain SAC beyond their share, but the encrypted-balance accounting can be
inflated. Production requires extending the withdraw circuit to emit a
sender-amount EGCT (mirroring transfer); see the SECURITY NOTE in
[`confidential-token/contracts/confidential-token/src/lib.rs`](confidential-token/contracts/confidential-token/src/lib.rs)
on the `withdraw` method.

This codebase is a hackathon prototype and has not been audited. Do not
use with real funds.

## License

MIT. Reference circuits and TypeScript crypto are © Ava Labs under MIT
(see [EncryptedERC/LICENSE](EncryptedERC/LICENSE)).
