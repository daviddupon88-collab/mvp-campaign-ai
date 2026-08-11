#!/usr/bin/env bash
# Fumée (smoke test) post-déploiement — point 8 de la checklist de mise en production
# (README, section "Déploiement en production"). Vérifie qu'un déploiement fraîchement
# sorti répond réellement, pas seulement que les conteneurs sont "up" : health checks,
# puis un aller-retour d'inscription/connexion complet contre l'API réelle.
#
# Usage : BASE_URL=https://votre-domaine.com ./scripts/smoke-test.sh
# Par défaut : http://localhost:3001 (déploiement local / mono-VM sans Caddy en frontal).
#
# Ce que ce script NE vérifie PAS (nécessite une action manuelle, cf. README point 8) :
# qu'un événement webhook Stripe réel est bien reçu — déclencher un événement test depuis
# le Dashboard Stripe (ou `stripe trigger checkout.session.completed` avec la Stripe CLI)
# et vérifier dans les logs applicatifs qu'il est traité, une fois les clés live en place.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
FAILED=0

pass() { echo "  OK  - $1"; }
fail() { echo "ÉCHEC - $1"; FAILED=1; }

check_status() {
  local method="$1" path="$2" expected="$3" data="${4:-}" auth="${5:-}"
  local args=(-sS -o /tmp/smoke-test-body.json -w "%{http_code}" -X "$method" "${BASE_URL}${path}")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  local code
  code=$(curl "${args[@]}") || { fail "$method $path — requête impossible (serveur injoignable ?)"; return 1; }
  if [ "$code" != "$expected" ]; then
    fail "$method $path — attendu $expected, reçu $code ($(cat /tmp/smoke-test-body.json 2>/dev/null | head -c 200))"
    return 1
  fi
  pass "$method $path → $code"
  return 0
}

extract_token() {
  grep -o '"accessToken":"[^"]*"' /tmp/smoke-test-body.json | head -1 | cut -d'"' -f4
}

echo "Fumée post-déploiement contre ${BASE_URL}"
echo "---"

check_status GET /health/live 200 || true
check_status GET /health/ready 200 || true

EMAIL="smoke-test-$(date +%s)@example.com"
PASSWORD="motdepasse-solide-123"

if check_status POST /api/auth/register 201 \
  "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"fullName\":\"Smoke Test\",\"organizationName\":\"Smoke Test Org\"}"; then
  TOKEN=$(extract_token)
  [ -n "$TOKEN" ] && pass "accessToken reçu à l'inscription" || fail "accessToken absent de la réponse d'inscription"
fi

if check_status POST /api/auth/login 201 \
  "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}"; then
  TOKEN=$(extract_token)
  if [ -n "$TOKEN" ]; then
    pass "accessToken reçu à la connexion"
    check_status GET /api/auth/me 200 "" "$TOKEN" || true
  else
    fail "accessToken absent de la réponse de connexion"
  fi
fi

echo "---"
if [ "$FAILED" -eq 0 ]; then
  echo "Fumée OK. Reste à vérifier manuellement : réception d'un webhook Stripe réel (cf. en-tête de ce script)."
  exit 0
else
  echo "Fumée EN ÉCHEC — voir le détail ci-dessus avant de considérer ce déploiement sain."
  exit 1
fi
