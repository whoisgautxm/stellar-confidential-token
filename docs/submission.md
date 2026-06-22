# Hackathon submission notes

**Project:** Confidential Token on Stellar
**Track:** Stellar Hacks: Real-World ZK
**Status:** Research prototype, testnet only, not audited.

## One-line pitch

A confidential fungible token on Soroban that hides balances and transfer
amounts while keeping sender/receiver addresses public — built by porting
Avalanche's `EncryptedERC` to Stellar's BN254 + BabyJubJub host stack, with
a complete CLI demonstrating the full converter round-trip live on testnet.

## Why Stellar

- The Stellar protocol already had **first-class assets** via classic
  trustlines; SAC bridges them into Soroban with deterministic contract ids.
  We wrap a custom CONF asset so existing Stellar tooling (Freighter,
  StellarExpert) keeps working for the public boundary while the private
  state lives in Soroban.
- BN254 `pairing_check` (CAP-0074) and BLS12-381 host functions make
  on-chain Groth16 verification cheap enough to use in user-facing flows.

## What's novel

- We didn't redesign the cryptography. We took an audited, production-style
  reference implementation (eERC) and proved it can land on Stellar with
  **only the curve arithmetic ported** — no new circuits, no new trusted
  setup, no new security assumptions beyond Stellar's host crypto.
- The verifier contracts are auto-generated from the eERC verification keys
  using `soroban-verifier-gen`. Anyone with an eERC-style circuit and a
  `verification_key.json` can ship a Stellar deploy of the same scheme in
  minutes.
- The complete client + on-chain stack is exercised end-to-end on testnet
  through **both** modalities: a Node CLI and a browser dApp signing with
  Freighter. Every operation has been observed to land successfully and
  the encrypted-state transitions have been independently verified by
  BSGS-decrypting both sides.
- The dApp ships **self-serve onboarding** for brand-new Freighter accounts
  (Friendbot funding + classic `ChangeTrust` signed in-browser), so a
  reviewer with nothing but Freighter installed can run the full demo
  without touching the CLI.

## Architecture in 5 bullets

1. **Three Groth16 verifier contracts** (registration / transfer / withdraw),
   each <16 KB Wasm, each calling `env.crypto().bn254().pairing_check`.
2. **`baby-jubjub` guest crate** — pure Rust port of `BabyJubJub.sol`
   Edwards arithmetic, native-tested against eERC vectors.
3. **`registrar`** maps Stellar `Address → BabyJubJub Point`. Registration
   proves knowledge of the matching secret.
4. **`confidential-token`** orchestrates deposit (SAC.transfer + homomorphic
   add of client-encrypted EGCT), private transfer (Groth16 verify + sender
   EGCT sub + receiver EGCT add), and withdraw (Groth16 verify + EGCT sub +
   SAC.transfer out).
5. **TypeScript SDK + CLI + dApp** all run the full flow end to end. The
   browser dApp uses snarkjs in-page, signs via Freighter, and never reads
   private key material. The SDK is the shared core; the CLI is a Node
   front-end and the dApp is a React front-end over the same modules.

## Stellar-specific design choices

- **Single-SAC allowlist** at contract construction — no arbitrary token
  parameter to deposit/withdraw, removing a class of mis-deposit bugs.
- **Balance hash + nonce replay guard** uses SHA-256 (host primitive) for
  the on-chain part and Poseidon for the circuit-side hash. This works on
  current testnet without requiring CAP-0075 Poseidon-host adoption.
- **Cross-contract verifier calls** via `env.invoke_contract` instead of
  Rust crate dependencies — avoids duplicate `verify_proof` cdylib symbol
  collisions and keeps each verifier independently upgradeable.
- **Client-side encryption for deposit and withdraw** — on-chain BabyJubJub
  scalar multiplication exceeded the Soroban CPU budget, so the client
  computes `Enc(pk, amount)` and passes it as an argument. The public
  amount is enforced by SAC.transfer. See the security note below.

## Deliverables

| Deliverable                  | Location                                                   |
|------------------------------|------------------------------------------------------------|
| Soroban contracts (5 Wasm)   | `confidential-token/target/wasm32v1-none/release/*.wasm`   |
| BabyJubJub Rust crate        | `confidential-token/crates/baby-jubjub/`                   |
| TypeScript SDK               | `packages/sdk/` — `jub`, `poseidon`, `prover`, `stellar`, `balance`, `transfer`, `withdraw` |
| Working CLI                  | `packages/cli/` — `register`, `deposit`, `balance`, `transfer`, `withdraw` |
| Working web dApp             | `packages/dapp/` — full Freighter-signed flow for all 5 actions + self-serve onboarding (Friendbot, ChangeTrust) |
| Deployment scripts           | `scripts/` — `issue-test-asset`, `deploy-testnet`, `set-auditor`, `redeploy-token-only`, `fund-conf` |
| Architecture write-up        | `docs/architecture.md`                                     |
| Deployment guide             | `docs/deployment.md`                                       |
| Plan of record               | `.cursor/plans/confidential_token_option_a_c6aa55a1.plan.md` |
| README                       | `README.md`                                                |

## Live testnet contract IDs

The latest deployment is recorded in
[`packages/sdk/config/testnet.json`](../packages/sdk/config/testnet.json).
At submission time:

| Contract | ID |
|---|---|
| `verifierRegistration` | `CD62XDVYJHRWXWQGJJEQAZLMB2WIYHVV7VOXPOAHM24UVCCBHHCB4LCF` |
| `verifierTransfer`     | `CCPLIDOPXK2EFN3KIRYVIL2JWKWE4KGKWK4BGKX3FEYKG3N4QPHH5OUW` |
| `verifierWithdraw`     | `CBHPW3HK37XKBC3QUHHDR3GTI65GX47MUFEHYGCEFDBLUDMKND35XLSO` |
| `registrar`            | `CB6PFOCN4WTFFRHR6YUY7HQJTWSPZCLY6A3FSVQGA5MDKA6ONUPEJLBJ` |
| `confidentialToken`    | `CDLEUTP6QVNM2I7Z62LV3BUVZXE5Y444SMUA7QL2GFEB2VQD4MDASK45` |
| `sacToken` (CONF SAC)  | `CDXMY4RIFATOLSSIMOICSWVOSWFBJAEWP74DTX4CWIX5GMN4LON4SOZ5` |
| auditor account        | `GDC5RRQ6WMY4F7UHAP6447YFENVDG2VHOM5FFQ4TEGM5W2PFIAOWXESS` (= admin) |

These ids may rotate on subsequent `deploy-testnet.sh` runs — always trust
`packages/sdk/config/testnet.json` as the source of truth.

## Demo video script

The recommended demo is **dApp-driven** — it shows that the full
register/deposit/transfer/withdraw flow runs in a browser with nothing but
Freighter installed, and that brand-new accounts onboard themselves. Drop
back to the CLI only to script the operator-side "send CONF" step.

Setup before recording:

```bash
cd /Users/gautam/Desktop/stellar-hackathon
cd packages/dapp && npm run dev    # start the dApp on :5173
# In a separate browser profile, install Freighter and create a fresh
# testnet keypair (this is the "user" account for the demo)
ADMIN=$(stellar keys address admin)
CT=$(jq -r .confidentialToken packages/sdk/config/testnet.json)
SAC=$(jq -r .sacToken packages/sdk/config/testnet.json)
```

### Recording

1. **Layout:** dApp at `http://localhost:5173` on the left, StellarExpert
   pinned to the `confidentialToken` contract id on the right, a terminal
   docked at the bottom for the operator commands.
2. **Connect Freighter** — click *Connect Freighter*, select the fresh
   testnet account. Activity log shows the address.
3. The dApp prompts Freighter once to **sign the BJJ-seed message** —
   accept. Activity log: `BJJ pubkey: (…, …)`. Call out that the private
   key never left Freighter.
4. **Self-serve onboarding** (the slick part for new users):
   - Click **Fund XLM via Friendbot** → account is created on testnet.
   - Click **Setup CONF trustline** → Freighter pops up to sign a classic
     `ChangeTrust`; accept. Activity log: `✓ trustline set (tx …)`.
   - In the terminal: `./scripts/fund-conf.sh <user-G-address> 1000`.
     Operator sends 1000 CONF from the distributor.
5. **Register** tab → *Register*. Freighter signs the Soroban tx.
   Highlight the activity log line `proof generated in ~1 s`. After it
   settles, refresh StellarExpert to show the new tx on the contract.
6. **Deposit** tab → enter `100` stroops → *Deposit*. Activity log shows
   `encrypting amount client-side` → `requesting wallet signature` →
   `deposit confirmed`. In the terminal:
   ```bash
   stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "<user>" # → 900
   stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$CT"   # → +100
   ```
7. **Balance** tab → *Read & decrypt balance*. Activity log shows the BSGS
   time (~350 ms). UI displays `100 stroops (0.0000100 CONF)`.
8. Set up a **second** Freighter account (second browser profile or open
   Freighter's "switch account" menu, create a new testnet key). Connect
   it to the dApp in a second browser tab, do steps 3–5 to onboard it as
   the **recipient** (no need to send CONF — recipients only need the
   trustline + registration).
9. **The headline moment — private transfer.** Back in the sender's tab,
   open **Transfer**, paste the recipient's G-address, enter `30` →
   *Private transfer*. Activity log shows the 32-signal Groth16 proof
   generating, then submitted. **Refresh StellarExpert** on the contract
   call — show that the public inputs are `(sender, recipient, proof,
   balance_pct)` with **no plaintext amount**.
10. In the terminal, re-check the public SAC balances:
    ```bash
    stellar contract invoke … -- balance --id "<sender>"     # unchanged at 900
    stellar contract invoke … -- balance --id "<recipient>"  # unchanged at 0
    stellar contract invoke … -- balance --id "$CT"          # unchanged at 100
    ```
    **No public SAC moved.** Then read both encrypted balances in the dApp:
    sender BSGS-decrypts to `70`, recipient to `30`. **The encrypted
    ledger moved 30 stroops.**
11. **Withdraw** in the sender's tab — enter `20` → *Withdraw to public SAC*.
    Sender's public SAC jumps to 920, contract escrow drops to 80, encrypted
    balance drops to 50.
12. **Privacy check.** In the operator terminal, point at the encrypted
    balance EGCT stored on-chain (`balance.ts`-style read) and emphasise
    that it's structurally identical between sender and recipient — there
    is nothing in the EGCT a passive observer can compare against a known
    amount.
13. **Closing line:** "Same eERC circuits, same security model, native
    Stellar BN254 host crypto, no new trusted setup. Full converter
    round-trip — wallet-signed, browser-proven — live on testnet today."

### CLI fallback script

If you'd rather record the CLI variant (faster to script, no Freighter
prompts to wait on), the original sequence still works:

```bash
npx tsx packages/cli/src/commands/register.ts
npx tsx packages/cli/src/commands/deposit.ts 100
npx tsx packages/cli/src/commands/balance.ts
STELLAR_SECRET=$(stellar keys secret alice) \
  npx tsx packages/cli/src/commands/register.ts
npx tsx packages/cli/src/commands/transfer.ts "$(stellar keys address alice)" 30
npx tsx packages/cli/src/commands/balance.ts
npx tsx packages/cli/src/commands/withdraw.ts 20
```

Both demos exercise the exact same on-chain contracts.

## Threat & honesty notes

- Not audited. Reuses eERC's existing trusted setup which is dev-grade.
- Side-channel and timing assumptions inherit from the upstream Circom
  circuits.
- Public-signal layout enforced by both the verifier and the main contract
  policy checks (registration hash bounds, PK binding, auditor PK binding).
- Auditor cannot deanonymize addresses (they are public anyway) — they can
  only learn amounts via the Poseidon-encrypted PCT.

### Hackathon-scope security caveat

`deposit` and `withdraw` accept a client-encrypted EGCT as an argument
because on-chain BabyJubJub scalar multiplication exceeds the Soroban CPU
budget. On `deposit` a misencryption only corrupts the user's own future
balance reads — no protocol impact. On `withdraw` a malicious client could
encrypt zero and keep their encrypted balance unchanged while still
withdrawing public SAC; this is capped by the SAC escrow (a user can't
drain more than they deposited) but inflates the encrypted-balance ledger.

Production must extend `withdraw.circom` to emit `SenderVTTC1/C2` mirroring
`transfer.circom`, so the contract can verify the client-passed EGCT against
the circuit's emitted EGCT. The contract method `withdraw` has a
SECURITY NOTE comment documenting this clearly.

## Future work

- Withdraw circuit hardening (see caveat above).
- Replace SHA-256 nonce binding with Poseidon once CAP-0075 is live.
- Auditor decrypt CLI — uses the auditor's BabyJubJub secret to decode the
  Poseidon-encrypted amount PCTs from every transfer/withdraw. Primitives
  already exist in `packages/sdk/poseidon.ts`.
- Add a standalone mint/burn mode for non-wrapped issuance. The Circom
  artifacts (`mint.wasm`, `burn.wasm`) are already in
  `EncryptedERC/circom/build/`; would require two new verifier contracts
  and entry points on the main contract.
- ZK upgrade gating for the verifier contracts (admin-multisig).
- Production-grade trusted setup ceremony for new VKs.
- Sponsored trustlines (CAP-33) so the operator can pay the user's reserve
  cost and onboarding becomes a single Friendbot click instead of two.
- Better recipient discovery in the dApp transfer flow — currently the user
  pastes a G-address; ideally the dApp would query the registrar for
  registered accounts and show a picker.
