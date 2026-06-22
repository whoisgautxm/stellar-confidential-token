#!/usr/bin/env bash
# Send a classic Stellar payment of CONF from the local `distributor` key to a
# dApp user's account. Requires the user to have already established a CONF
# trustline (use the "Setup CONF trustline" button in the dApp, or call
# `stellar tx new change-trust` directly).
#
# Usage:
#   ./scripts/fund-conf.sh <DESTINATION_G_ADDRESS> [AMOUNT]
#
# Defaults: AMOUNT=1000 CONF, NETWORK=testnet, ASSET_CODE=CONF
set -euo pipefail

DEST="${1:-}"
AMOUNT="${2:-1000}"
NETWORK="${STELLAR_NETWORK:-testnet}"
ASSET_CODE="${ASSET_CODE:-CONF}"

if [[ -z "$DEST" ]]; then
  echo "Usage: $0 <destination G... address> [amount]" >&2
  exit 1
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI not found. Install: cargo install --locked stellar-cli" >&2
  exit 1
fi

stellar config migrate >/dev/null 2>&1 || true

if ! stellar keys ls 2>/dev/null | grep -q "^issuer$"; then
  echo "missing 'issuer' key in stellar CLI keyring — run scripts/issue-test-asset.sh first" >&2
  exit 1
fi
if ! stellar keys ls 2>/dev/null | grep -q "^distributor$"; then
  echo "missing 'distributor' key in stellar CLI keyring — run scripts/issue-test-asset.sh first" >&2
  exit 1
fi

ISSUER=$(stellar keys address issuer)
DISTRIBUTOR=$(stellar keys address distributor)

echo "Sending ${AMOUNT} ${ASSET_CODE} from distributor (${DISTRIBUTOR:0:8}…) → ${DEST:0:8}…"

stellar tx new payment \
  --network "$NETWORK" \
  --source distributor \
  --destination "$DEST" \
  --asset "${ASSET_CODE}:${ISSUER}" \
  --amount "$AMOUNT" 2> >(grep -v 'A local config was found' >&2)

echo "✓ done. User can now deposit via the dApp."
