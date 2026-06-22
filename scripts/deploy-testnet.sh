#!/usr/bin/env bash
# Deploy all six Soroban contracts (verifiers + registrar + confidential token)
# to the configured network and persist contract IDs to
# packages/sdk/config/<network>.json.
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$ROOT/confidential-token/target/wasm32v1-none/release"
CONFIG="$ROOT/packages/sdk/config/${NETWORK}.json"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI not found"; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required to update $CONFIG"; exit 1
fi

# Silence the local .stellar config migration warning on every CLI call.
stellar config migrate >/dev/null 2>&1 || true

cd "$ROOT/confidential-token"
cargo build --target wasm32v1-none --release >&2

if ! stellar keys ls 2>/dev/null | grep -q "^admin$"; then
  stellar keys generate admin --network "$NETWORK" --fund >&2
fi
ADMIN=$(stellar keys address admin)
echo "Admin: $ADMIN" >&2

write_id() {
  local key="$1" value="$2"
  mkdir -p "$(dirname "$CONFIG")"
  if [[ ! -f "$CONFIG" ]]; then echo "{}" > "$CONFIG"; fi
  tmp=$(mktemp)
  jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$CONFIG" > "$tmp"
  mv "$tmp" "$CONFIG"
}

# Returns ONLY the deployed contract id on stdout. All progress text goes to
# stderr so the caller can do `id=$(deploy ...)` safely.
deploy() {
  local name="$1" wasm="$2"; shift 2
  local id
  id=$(stellar contract deploy \
    --network "$NETWORK" \
    --source admin \
    --wasm "$wasm" \
    -- "$@" 2> >(grep -v 'A local config was found' >&2))
  echo "${name} => ${id}" >&2
  write_id "$name" "$id"
  printf '%s' "$id"
}

V_REG=$(deploy verifierRegistration "$WASM_DIR/verifier_registration.wasm")
V_XFER=$(deploy verifierTransfer "$WASM_DIR/verifier_transfer.wasm")
V_WDR=$(deploy verifierWithdraw "$WASM_DIR/verifier_withdraw.wasm")

CHAIN_ID="${CHAIN_ID:-0}"

REG=$(deploy registrar "$WASM_DIR/registrar.wasm" \
  --verifier "$V_REG" --chain_id "$CHAIN_ID")

SAC_ID="${SAC_ID:-$(cat "$ROOT/.sac-id" 2>/dev/null || echo "")}"
if [[ -z "$SAC_ID" ]]; then
  echo "set SAC_ID env or run scripts/issue-test-asset.sh first" >&2
  exit 1
fi
write_id sacToken "$SAC_ID"

CT=$(deploy confidentialToken "$WASM_DIR/confidential_token.wasm" \
  --admin "$ADMIN" --registrar "$REG" --sac_token "$SAC_ID" \
  --transfer_verifier "$V_XFER" --withdraw_verifier "$V_WDR")

echo ""
echo "Done. Config written to $CONFIG" >&2
jq . "$CONFIG"
