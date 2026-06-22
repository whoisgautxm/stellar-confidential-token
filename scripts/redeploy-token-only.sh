#!/usr/bin/env bash
# Rebuild + redeploy ONLY the confidential_token contract.
#
# Reuses the existing registrar / verifier / SAC IDs from
# packages/sdk/config/<network>.json — so user registrations on the registrar
# are preserved (no need to re-register admin/alice/etc).
#
# Auto-re-runs set-auditor.sh at the end because a freshly deployed contract
# has no auditor configured.
#
# Use this for iterative dev on confidential_token only. If you change the
# registrar or verifier source, run scripts/deploy-testnet.sh instead.
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$ROOT/confidential-token/target/wasm32v1-none/release"
CONFIG="$ROOT/packages/sdk/config/${NETWORK}.json"

if ! command -v stellar >/dev/null 2>&1; then echo "stellar CLI not found" >&2; exit 1; fi
if ! command -v jq >/dev/null 2>&1; then echo "jq required" >&2; exit 1; fi
if [[ ! -f "$CONFIG" ]]; then
  echo "missing $CONFIG — run scripts/deploy-testnet.sh first" >&2; exit 1
fi

stellar config migrate >/dev/null 2>&1 || true

REG=$(jq -r .registrar "$CONFIG")
SAC=$(jq -r .sacToken "$CONFIG")
V_XFER=$(jq -r .verifierTransfer "$CONFIG")
V_WDR=$(jq -r .verifierWithdraw "$CONFIG")
ADMIN=$(stellar keys address admin)

for var in REG SAC V_XFER V_WDR; do
  val="${!var}"
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "$var missing in $CONFIG — run scripts/deploy-testnet.sh first" >&2
    exit 1
  fi
done

echo "Reusing on $NETWORK:" >&2
echo "  registrar:        $REG" >&2
echo "  sacToken:         $SAC" >&2
echo "  verifierTransfer: $V_XFER" >&2
echo "  verifierWithdraw: $V_WDR" >&2

echo "Building confidential-token WASM..." >&2
cargo build --target wasm32v1-none --release \
  --manifest-path "$ROOT/confidential-token/Cargo.toml" \
  -p confidential-token >&2

if [[ ! -f "$WASM_DIR/confidential_token.wasm" ]]; then
  echo "missing $WASM_DIR/confidential_token.wasm after build" >&2; exit 1
fi

echo "Deploying new confidential_token..." >&2
CT=$(stellar contract deploy \
  --network "$NETWORK" \
  --source admin \
  --wasm "$WASM_DIR/confidential_token.wasm" \
  -- --admin "$ADMIN" --registrar "$REG" --sac_token "$SAC" \
     --transfer_verifier "$V_XFER" --withdraw_verifier "$V_WDR" \
  2> >(grep -v 'A local config was found' >&2))

if [[ -z "$CT" ]]; then echo "deploy returned empty contract id" >&2; exit 1; fi
echo "confidentialToken => $CT" >&2

tmp=$(mktemp)
jq --arg v "$CT" '.confidentialToken = $v' "$CONFIG" > "$tmp"
mv "$tmp" "$CONFIG"

echo "Re-running set-auditor on the new contract..." >&2
exec "$ROOT/scripts/set-auditor.sh"
