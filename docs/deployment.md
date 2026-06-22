# Testnet deployment guide

Step-by-step for deploying the Confidential Token stack to Stellar testnet
and running the full register → deposit → transfer → withdraw flow end-to-end.

## Prerequisites

```bash
# Rust toolchain + wasm target
rustup target add wasm32v1-none

# Stellar CLI
cargo install --locked stellar-cli --features opt

# Node 20+
node --version

# Misc
brew install jq      # required by the deploy + set-auditor scripts
```

Verify the target network supports BN254 host functions (CAP-0074). Most
Stellar testnet protocol versions ≥ 23 include them, but always check
[stellar-protocol releases](https://github.com/stellar/stellar-protocol/releases)
and the active testnet protocol via `https://soroban-testnet.stellar.org`.

## 1. Build all WASM contracts

```bash
cd confidential-token
cargo test -p baby-jubjub        # confirm crypto invariants
cargo build --target wasm32v1-none --release
ls -lh target/wasm32v1-none/release/*.wasm
```

Expected output (sizes will vary slightly by Rust version):

```
confidential_token.wasm    ~54K
registrar.wasm             ~18K
verifier_registration.wasm ~14K
verifier_transfer.wasm     ~16K
verifier_withdraw.wasm     ~15K
```

All comfortably under the 64 KB per-contract limit.

## 2. Issue the test SAC

```bash
cd ..
./scripts/issue-test-asset.sh
# writes the SAC contract id to ./.sac-id
```

This creates an issuer + distributor account, mints 1M `CONF` to distributor,
deploys the SAC, and writes the SAC contract id to `.sac-id`. Script is
idempotent — safe to re-run.

## 3. Deploy all five Soroban contracts

```bash
./scripts/deploy-testnet.sh
# persists ids to packages/sdk/config/testnet.json
```

This deploys:

| Contract | Why |
|---|---|
| `verifierRegistration` | Groth16 verifier (5 public signals) |
| `verifierTransfer`     | Groth16 verifier (32 public signals) |
| `verifierWithdraw`     | Groth16 verifier (16 public signals) |
| `registrar`            | BabyJubJub PK registry, calls registration verifier |
| `confidentialToken`    | Main contract — deposit/transfer/withdraw/set_auditor |

`confidentialToken`'s `__constructor` is wired to the registrar +
transfer/withdraw verifier + SAC ids automatically.

> **Note:** every run of `deploy-testnet.sh` rotates **all** contract ids,
> which invalidates all user registrations (they live in the registrar). For
> iterative dev on `confidential_token` only, use
> `./scripts/redeploy-token-only.sh` instead — it preserves registrations.

Also funds an `admin` Stellar key if one doesn't already exist.

## 4. Configure the auditor

```bash
./scripts/set-auditor.sh
```

This derives the auditor's BabyJubJub pubkey from the `admin` Stellar secret
(for the hackathon — production should use a separate independent account),
calls `confidential_token.set_auditor(...)` on chain, and persists both
`auditorAddress` and `auditorPk: {x, y}` to `packages/sdk/config/testnet.json`.

The CLI's `transfer` and `withdraw` commands fail fast with a clear error
message if `auditorPk` is missing from the config.

## 5. Configure the CLI

```bash
cp packages/cli/.env.example packages/cli/.env
# edit STELLAR_SECRET to the admin's funded testnet account
npm install
```

Sanity-check the resolved config:

```bash
npx tsx packages/cli/src/index.ts config
# {
#   network: 'testnet',
#   source: 'G...ADMIN',
#   chainId: '0',
#   contractIds: { registrar: 'C...', confidentialToken: 'C...', ... },
#   artifactsDir: '/.../EncryptedERC/circom/build'
# }
```

## 6. Run the full converter flow

### a. Register the admin key

```bash
npx tsx packages/cli/src/commands/register.ts
# generates a Groth16 proof (5 public signals), invokes registrar.register
```

### b. Deposit 100 stroops of CONF

The CLI encrypts the amount client-side under the admin's BabyJubJub PK and
passes the EGCT to the contract along with the public `i128` amount:

```bash
npx tsx packages/cli/src/commands/deposit.ts 100
# admin's SAC balance → -100; contract escrow → +100; encrypted balance → Enc(pk, 100)
```

### c. Inspect the encrypted balance

```bash
npx tsx packages/cli/src/commands/balance.ts
# Prints the on-chain EGCT struct, then BSGS-decodes to 100 stroops locally.
# Decrypt time depends on CTOKEN_BSGS_MAX (default 2^28 ≈ 1 s).
```

### d. Set up a second account for the transfer demo

```bash
stellar keys generate alice --network testnet --fund
ALICE=$(stellar keys address alice)
ALICE_SECRET=$(stellar keys secret alice)

STELLAR_SECRET="$ALICE_SECRET" npx tsx packages/cli/src/commands/register.ts
```

### e. Private transfer (the headline feature)

```bash
npx tsx packages/cli/src/commands/transfer.ts "$ALICE" 30
```

The CLI:

1. fetches the admin's current encrypted balance from chain,
2. decrypts + BSGSes it locally to recover plaintext (`70 ✓`),
3. fetches alice's BabyJubJub PK from the registrar,
4. builds the 32-signal Groth16 witness (sender/receiver/auditor EGCTs and PCTs),
5. runs `snarkjs.groth16.fullProve` (~1 s),
6. submits `confidential_token.transfer(admin, alice, proof, balance_pct)`.

The on-chain SAC escrow is **untouched** — private transfer is purely a
movement in the encrypted-state ledger.

### f. Verify before/after balances

```bash
ADMIN=$(stellar keys address admin)
CT=$(jq -r .confidentialToken packages/sdk/config/testnet.json)
SAC=$(jq -r .sacToken packages/sdk/config/testnet.json)

echo "admin public SAC (unchanged):"
stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$ADMIN"
echo "alice public SAC (unchanged):"
stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$ALICE"
echo "contract SAC escrow (unchanged — private transfer doesn't touch SAC):"
stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$CT"

echo "admin encrypted balance (should BSGS to 70):"
npx tsx packages/cli/src/commands/balance.ts
echo "alice encrypted balance (should BSGS to 30):"
STELLAR_SECRET="$ALICE_SECRET" npx tsx packages/cli/src/commands/balance.ts
```

### g. Withdraw 20 back to public SAC

```bash
npx tsx packages/cli/src/commands/withdraw.ts 20
# admin SAC → +20; contract escrow → -20; admin encrypted balance → -20
```

Final state for the demo recording:

| | Public SAC | Encrypted balance |
|---|---|---|
| admin | 920 (+20 from withdraw) | 50 (was 70 after transfer) |
| alice | 0 | 30 |
| contract escrow | 80 (was 100) | n/a |

### 6b. Run the same flow via the dApp (recommended for the demo)

The dApp drives all five eERC operations end-to-end through Freighter — no
CLI required after the contracts are deployed. Browser snarkjs handles
Groth16 proving; `@stellar/stellar-sdk` builds the txs; Freighter signs them.

```bash
cd packages/dapp
npm install        # one-time
npm run dev        # `predev` runs sync-env: writes .env from
                   # packages/sdk/config/<network>.json (contract ids,
                   # auditor pk, CONF asset code + issuer) and copies the
                   # circom wasm/zkey artifacts into public/circuits/
# Open http://localhost:5173 in a browser with Freighter installed on testnet
```

#### Onboarding a brand-new Freighter account

A fresh account has no XLM, no CONF trustline, and no CONF balance. The
dApp self-serves the first two; the operator (you) supplies the third via
`scripts/fund-conf.sh`.

1. **Connect Freighter**. The dApp asks the wallet to sign
   `confidential-token:v1:<address>` once and caches the derived BabyJubJub
   keypair under `localStorage["ctoken:seed:<address>"]`.
2. **Fund XLM via Friendbot** (button under your address, testnet only).
   Creates the Stellar account on testnet by sending it 10k XLM.
3. **Setup CONF trustline** (button under your address). Builds and signs a
   classic `ChangeTrust` op via Freighter so the account can hold CONF.
   Idempotent — clicking on an already-trusting account is a no-op.
4. Run the operator helper to actually send some CONF:
   ```bash
   ./scripts/fund-conf.sh <user's G-address> 1000
   ```
   This uses the `distributor` keyring entry created by `issue-test-asset.sh`
   to send 1000 CONF to the user.
5. Now the user can hit **Register**, **Deposit**, **Balance**, **Transfer**,
   **Withdraw**. The Activity panel logs every stage (witness, proof gen
   time, wallet sign, on-chain submit, BSGS decryption time).

#### Mixed CLI ↔ dApp accounts

The dApp's BJJ key derivation is not byte-identical to the CLI's (Freighter
wraps the message per SEP-43 before signing). **Pick one modality per
Stellar account** — re-registering in the other modality after a successful
register on one will mismatch the on-chain BabyJubJub PK and cause
`InvalidProof` on every subsequent transfer/withdraw.

Best practice: dApp for end-user / demo flow, CLI for backend operations
and scripting.

## 7. Iterating during development

If you only changed code in `confidential-token/contracts/confidential-token/`:

```bash
./scripts/redeploy-token-only.sh
# Rebuilds + redeploys ONLY confidential_token, reuses existing
# registrar/verifier/SAC ids, then re-runs set-auditor.sh.
# Encrypted balances are reset (they live in the new contract instance)
# but user registrations are preserved.
```

After this you can re-deposit and continue without re-registering every
account.

## Common issues

- **`stellar` CLI not found** — install via `cargo install --locked stellar-cli --features opt`.
- **Insufficient balance** — fund accounts with `stellar keys fund <name> --network testnet`.
- **`Error(Contract, #1) NotRegistered`** on deposit — happens after a full
  `deploy-testnet.sh` because the registrar was rotated. Re-run `register`
  for every account.
- **`Error(Contract, #2) AuditorNotSet`** — run `./scripts/set-auditor.sh`.
- **`Error(Contract, #3) InvalidProof`** — most often the public signal
  ordering is wrong, the auditor pubkey in the config is stale, or the user
  changed their Stellar secret between register and transfer. Compare
  `cfg.auditorPk` against what the contract stored.
- **`Error(Contract, #4) AlreadyRegistered`** — you've already registered
  this account on the current registrar. Move on.
- **`Error(Contract, #5) InvalidBalance`** — the EGCT you proved against
  doesn't match the on-chain hash. Likely the balance changed between
  snapshot and submit. Re-run the command.
- **`Error(Budget, ExceededLimit)`** — bump `fee` in
  [`packages/sdk/src/stellar.ts`](../packages/sdk/src/stellar.ts) line 96.
- **`Error(Contract, #13)` on dApp deposit** — almost always the SAC.transfer
  step failing. Most common causes:
  - Account not funded with XLM. Use the dApp's **Fund XLM via Friendbot**
    button, or `stellar keys fund <name> --network testnet`.
  - Missing CONF trustline. Use the dApp's **Setup CONF trustline** button.
  - Account has trustline but zero CONF. Run
    `./scripts/fund-conf.sh <user-address> <amount>`.
- **dApp shows `Account not found: G…`** — the connected Freighter account
  has never been created on chain. Click **Fund XLM via Friendbot**.
- **dApp shows `trustline entry is missing for account`** — click
  **Setup CONF trustline**, then have the operator run `fund-conf.sh`.
- **dApp throws `Should not already be working` / `Do not know how to
  serialize a BigInt`** — only happens if `index.html`'s top-level BigInt
  toJSON polyfill was edited out. Restore it; it must execute before any
  module loads.
- **snarkjs `Assertion failed` during witness gen** — your local plaintext
  balance doesn't match the on-chain EGCT (out-of-date view). The CLI
  always refetches before proof gen, so this is rare.
- **WASM > 64 KB** — increase optimization (`opt-level = "z"`, LTO) or split
  more aggressively. Current artifacts already optimized.
