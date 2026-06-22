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
- The complete client + on-chain stack is exercised end-to-end on testnet:
  register, deposit, private transfer, withdraw. Every operation has been
  observed to land successfully and the encrypted-state transitions have
  been independently verified by BSGS-decrypting both sides.

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
5. **TypeScript SDK + CLI** run the full flow end to end. dApp scaffold
   handles wallet connection and shows contract ids; witness builders are
   factored into the SDK and are ready to wire through the dApp.

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
| Web dApp scaffold            | `packages/dapp/` — wallet connect + contract id display    |
| Deployment scripts           | `scripts/` — `issue-test-asset`, `deploy-testnet`, `set-auditor`, `redeploy-token-only` |
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

The demo is CLI-driven because the witness builders run cleanly in Node.
The dApp scaffold is included for wallet integration but the end-to-end
flow goes through `npx tsx packages/cli/src/commands/...`.

```bash
cd /Users/gautam/Desktop/stellar-hackathon
ADMIN=$(stellar keys address admin)
ALICE=$(stellar keys address alice)
CT=$(jq -r .confidentialToken packages/sdk/config/testnet.json)
SAC=$(jq -r .sacToken packages/sdk/config/testnet.json)
```

1. **Open StellarExpert in a browser tab** pinned to the
   `confidentialToken` contract id so viewers can see the on-chain side.
2. `./scripts/issue-test-asset.sh` (optional — show the CONF SAC contract id
   landing in `.sac-id`).
3. `./scripts/deploy-testnet.sh` (optional — show the five contract ids
   landing in `packages/sdk/config/testnet.json`).
4. `./scripts/set-auditor.sh` — auditor BabyJubJub pubkey gets persisted to
   config.
5. `npx tsx packages/cli/src/commands/register.ts` — show the Groth16 proof
   generating in ~1 s and `register result: null` on success.
6. `npx tsx packages/cli/src/commands/deposit.ts 100` — show
   `deposit result: null`. Then:
   - `stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$ADMIN"` → 900
   - `stellar contract invoke --network testnet --source admin --id "$SAC" -- balance --id "$CT"` → 100
7. `npx tsx packages/cli/src/commands/balance.ts` — show the EGCT struct
   (large opaque numbers) and the BSGS decode to `100 stroops` in under a
   second.
8. Register alice (if not already registered):
   `STELLAR_SECRET=$(stellar keys secret alice) npx tsx packages/cli/src/commands/register.ts`
9. **The headline moment**:
   `npx tsx packages/cli/src/commands/transfer.ts "$ALICE" 30`.
   - Highlight that the public input to the contract is `(admin, alice,
     proof, balance_pct)` with no plaintext amount.
   - Refresh the SAC balance reads — admin is still 900, alice is still 0,
     contract escrow is still 100. **No public SAC moved.**
   - Run `balance.ts` for admin (decrypts to 70) and for alice with her
     secret (decrypts to 30). **The encrypted ledger moved 30 stroops.**
10. `npx tsx packages/cli/src/commands/withdraw.ts 20` — show admin's SAC
    jump to 920, contract escrow drop to 80, encrypted balance drop to 50.
11. **Try to BSGS-decode alice's balance using the admin's secret** — show
    that it returns garbage (or `dlog not found in range`). Privacy holds.
12. **Closing line:** "Same eERC circuits, same security model, native
    Stellar BN254 host crypto — no new trusted setup needed. The full
    converter round-trip is live on testnet today."

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
- Wire the transfer/withdraw witness builders through the dApp via browser
  snarkjs + Freighter sign + submit. SDK is dApp-ready; only the UI glue is
  missing.
