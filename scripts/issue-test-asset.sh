#!/usr/bin/env bash
# Issue a custom test asset (CONF) and deploy its Stellar Asset Contract.
# Requires the Stellar CLI: https://developers.stellar.org/docs/tools/developer-tools/cli
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ASSET_CODE="${ASSET_CODE:-CONF}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SAC_FILE="$ROOT/.sac-id"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI not found. Install: cargo install --locked stellar-cli --features opt"
  exit 1
fi

stellar config migrate >/dev/null 2>&1 || true

if ! stellar keys ls 2>/dev/null | grep -q "^issuer$"; then
  stellar keys generate issuer --network "$NETWORK" --fund
fi
if ! stellar keys ls 2>/dev/null | grep -q "^distributor$"; then
  stellar keys generate distributor --network "$NETWORK" --fund
fi

ISSUER=$(stellar keys address issuer)
DISTRIBUTOR=$(stellar keys address distributor)

echo "Issuer:      $ISSUER"
echo "Distributor: $DISTRIBUTOR"
echo "Asset:       $ASSET_CODE"

# Trustline (idempotent — succeeds even if it already exists)
stellar tx new change-trust \
  --network "$NETWORK" \
  --source distributor \
  --line "${ASSET_CODE}:${ISSUER}" 2> >(grep -v 'A local config was found' >&2) || true

# Payment from issuer to distributor (1M units)
stellar tx new payment \
  --network "$NETWORK" \
  --source issuer \
  --destination "$DISTRIBUTOR" \
  --asset "${ASSET_CODE}:${ISSUER}" \
  --amount 1000000 2> >(grep -v 'A local config was found' >&2) || true

# Deploy / fetch SAC. `stellar contract asset deploy` is idempotent on the
# resulting SAC id; if it already exists you can derive it via `stellar contract id asset`.
SAC_ID=$(stellar contract asset deploy \
  --network "$NETWORK" \
  --source issuer \
  --asset "${ASSET_CODE}:${ISSUER}" 2> >(grep -v 'A local config was found' >&2) \
  || stellar contract id asset \
    --network "$NETWORK" \
    --asset "${ASSET_CODE}:${ISSUER}")

echo "SAC contract id: $SAC_ID"
echo "$SAC_ID" > "$SAC_FILE"
echo "Saved to $SAC_FILE"
