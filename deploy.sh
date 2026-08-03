#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RSG Agency Portal — one-command (re)deploy on the hermes-gretch box.
#
#   cd /opt/rsg-agency-portal && ./deploy.sh
#
# Builds the image (old container keeps serving during the build), joins the
# hermes-shared network so it can reach rsg-hermes-api, swaps the container,
# health-checks /healthz, and keeps a rollback image. Idempotent.
#
# Runtime config precedence:
#   1. .env.deploy  (this dir, gitignored, chmod 600) — source of truth
#   2. the currently-running container's env (fallback)
#   3. built-in defaults below
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

NAME=rsg-agency-portal
IMAGE=rsg-agency-portal:latest
PORT_MAP=3400:3000
NETWORK=hermes-shared

# ---- load config -----------------------------------------------------------
if [ -f .env.deploy ]; then echo "==> sourcing .env.deploy"; set -a; . ./.env.deploy; set +a; fi

: "${HERMES_API_URL:=http://rsg-hermes-api:8787}"
: "${UPSTREAM_TIMEOUT_MS:=8000}"
# Intake gateway, reached container-to-container over hermes-shared.
: "${INTAKE_GATEWAY_URL:=http://rsg-intake-gate:8787}"
: "${INTAKE_TIMEOUT_MS:=120000}"
: "${CARRIERHUB_URL:=http://172.17.0.1:3200}"
: "${SERVICE_HEALTH_TIMEOUT_MS:=2500}"

# The backend bearer powers /api/* (server-side, never sent to the browser).
# Fall back to the running container's value so a bare re-run keeps working.
if [ -z "${HERMES_API_TOKEN:-}" ]; then
  HERMES_API_TOKEN=$(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^HERMES_API_TOKEN=//p' || true)
fi
[ -n "${HERMES_API_TOKEN:-}" ] || echo "WARN: no HERMES_API_TOKEN — /api/* will return _error and the portal will show sample data"

if [ -z "${RSG_INTAKE_API_KEY:-}" ]; then
  RSG_INTAKE_API_KEY=$(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^RSG_INTAKE_API_KEY=//p' || true)
fi

# ---- build (old container still serving) -----------------------------------
echo "==> docker build"
docker tag "$IMAGE" "${NAME}:rollback" 2>/dev/null || true
docker build -t "$IMAGE" .

# ---- swap ------------------------------------------------------------------
echo "==> swapping container"
docker rm -f "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -p "$PORT_MAP" \
  -e PORT=3000 \
  -e HERMES_API_URL="$HERMES_API_URL" \
  -e HERMES_API_TOKEN="$HERMES_API_TOKEN" \
  -e RSG_INTAKE_API_KEY="${RSG_INTAKE_API_KEY:-}" \
  -e UPSTREAM_TIMEOUT_MS="$UPSTREAM_TIMEOUT_MS" \
  -e INTAKE_GATEWAY_URL="$INTAKE_GATEWAY_URL" \
  -e INTAKE_TIMEOUT_MS="$INTAKE_TIMEOUT_MS" \
  -e CARRIERHUB_URL="$CARRIERHUB_URL" \
  -e SERVICE_HEALTH_TIMEOUT_MS="$SERVICE_HEALTH_TIMEOUT_MS" \
  -e HERMES_FINANCE_URL="${HERMES_FINANCE_URL:-}" \
  -e HERMES_CASES_URL="${HERMES_CASES_URL:-}" \
  -e HERMES_INTAKE_URL="${HERMES_INTAKE_URL:-}" \
  -e HERMES_RENEWALS_URL="${HERMES_RENEWALS_URL:-}" \
  "$IMAGE"

# ---- health check ----------------------------------------------------------
echo "==> health check"
ok=""
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT_MAP%%:*}/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ -n "$ok" ]; then
  echo "==> healthy: http://127.0.0.1:${PORT_MAP%%:*}/  (tailnet: http://100.75.67.72:${PORT_MAP%%:*}/)"
  curl -fsS "http://127.0.0.1:${PORT_MAP%%:*}/healthz" || true; echo
else
  echo "!! health check FAILED — rolling back"
  docker rm -f "$NAME" 2>/dev/null || true
  docker tag "${NAME}:rollback" "$IMAGE" 2>/dev/null || true
  docker run -d --name "$NAME" --restart unless-stopped --network "$NETWORK" -p "$PORT_MAP" \
    -e PORT=3000 -e HERMES_API_URL="$HERMES_API_URL" -e HERMES_API_TOKEN="$HERMES_API_TOKEN" \
    -e RSG_INTAKE_API_KEY="${RSG_INTAKE_API_KEY:-}" -e UPSTREAM_TIMEOUT_MS="$UPSTREAM_TIMEOUT_MS" \
    -e INTAKE_GATEWAY_URL="$INTAKE_GATEWAY_URL" -e INTAKE_TIMEOUT_MS="$INTAKE_TIMEOUT_MS" \
    -e CARRIERHUB_URL="$CARRIERHUB_URL" -e SERVICE_HEALTH_TIMEOUT_MS="$SERVICE_HEALTH_TIMEOUT_MS" \
    -e HERMES_FINANCE_URL="${HERMES_FINANCE_URL:-}" -e HERMES_CASES_URL="${HERMES_CASES_URL:-}" \
    -e HERMES_INTAKE_URL="${HERMES_INTAKE_URL:-}" -e HERMES_RENEWALS_URL="${HERMES_RENEWALS_URL:-}" \
    "$IMAGE" 2>/dev/null || true
  exit 1
fi
