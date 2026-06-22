#!/usr/bin/env bash
# Set the auditor on the confidential_token contract and persist its
# BabyJubJub public key to packages/sdk/config/<network>.json so client
# witness builders (transfer / withdraw) can use it.
#
# For the hackathon demo we reuse the `admin` Stellar key as the auditor.
# In production, the auditor should be an independent account.
#
# Idempotent: re-running rotates the auditor pubkey on chain and rewrites the
# config entry to match.
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/packages/sdk/config/${NETWORK}.json"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI not found" >&2; exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required" >&2; exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "missing $CONFIG — run scripts/deploy-testnet.sh first" >&2; exit 1
fi

stellar config migrate >/dev/null 2>&1 || true

CT=$(jq -r .confidentialToken "$CONFIG")
if [[ -z "$CT" || "$CT" == "null" ]]; then
  echo "confidentialToken not in $CONFIG — deploy first" >&2; exit 1
fi

ADMIN_ADDR=$(stellar keys address admin)
ADMIN_SECRET=$(stellar keys secret admin)

echo "Admin / auditor: $ADMIN_ADDR" >&2
echo "Deriving BabyJubJub pubkey..." >&2

# Helper prints {"x":"...","y":"..."} on a single line.
PK_JSON=$(cd "$ROOT" && npx --yes tsx scripts/_derive-pubkey.ts "$ADMIN_SECRET")
PK_X=$(echo "$PK_JSON" | jq -r .x)
PK_Y=$(echo "$PK_JSON" | jq -r .y)
echo "pubkey.x = $PK_X" >&2
echo "pubkey.y = $PK_Y" >&2

echo "Calling confidential_token.set_auditor..." >&2
stellar contract invoke \
  --network "$NETWORK" \
  --source admin \
  --id "$CT" \
  -- set_auditor \
    --admin "$ADMIN_ADDR" \
    --auditor "$ADMIN_ADDR" \
    --public_key "{\"x\":\"$PK_X\",\"y\":\"$PK_Y\"}" \
  2> >(grep -v 'A local config was found' >&2)

echo "Persisting auditor pubkey to $CONFIG..." >&2
tmp=$(mktemp)
jq --arg addr "$ADMIN_ADDR" --arg x "$PK_X" --arg y "$PK_Y" \
   '.auditorAddress = $addr | .auditorPk = {x: $x, y: $y}' \
   "$CONFIG" > "$tmp"
mv "$tmp" "$CONFIG"

echo "Done." >&2
jq '{auditorAddress, auditorPk}' "$CONFIG"
