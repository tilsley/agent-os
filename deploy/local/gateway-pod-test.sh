#!/usr/bin/env bash
# Bun gateway as a pod (ADR-0028) — the in-cluster identity proof that retires the
# LiteLLM chart from the deploy path. Replicates deploy/helm/litellm-gateway's validated
# scenario on the replacement: a REAL projected ServiceAccount token (minted with
# kubectl create token --audience=agent-os-gateway) → TokenReview-verified by the
# cluster API → claim → worst-case reserve → 402. Every case rejects pre-flight ⇒
# $0, no AWS creds anywhere (static claims, in-memory spend).
#   make gw-pod-test     (or: bash deploy/local/gateway-pod-test.sh; KEEP=1 to leave it running)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
NS=agentos-gw; PORT=3100
cleanup() {
  kill "${PF_PID:-}" 2>/dev/null
  [ "${KEEP:-0}" = "1" ] || helm uninstall inference-gateway -n "$NS" > /dev/null 2>&1
}
trap cleanup EXIT

echo "▶ build the gateway image (k3s docker runtime sees it directly — no import)"
docker build -q -t inference-gateway:dev -f services/inference-gateway/Dockerfile . > /dev/null || exit 1

echo "▶ deploy deploy/helm/inference-gateway (no-AWS test values: static claim for default/default, tiny cap)"
VALUES=$(mktemp)
cat > "$VALUES" <<'EOF'
awsCredsSecret: ""
# runs MESHED (the namespace's Linkerd injection applies): the pod gets mTLS like full
# mode, while the gate itself is exercised in TokenReview authn mode. If the mesh is
# broken (e.g. stale identity leaf certs after a laptop sleep — restart the linkerd
# deploys), add `podAnnotations: { linkerd.io/inject: disabled }` here to bypass it.
env:
  CLAIM_SOURCE: static
  CLAIMS_STATIC: '{"system:serviceaccount:default:default":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}'
  SPEND_STORE: memory
  GATE_BUDGET_USD: "0.0001"
EOF
helm upgrade --install inference-gateway deploy/helm/inference-gateway -n "$NS" --create-namespace -f "$VALUES" > /dev/null
rm -f "$VALUES"
kubectl -n "$NS" rollout status deploy/inference-gateway --timeout=120s || { kubectl -n "$NS" logs deploy/inference-gateway | tail -20; exit 1; }

kubectl -n "$NS" port-forward svc/inference-gateway $PORT:$PORT > /dev/null 2>&1 &
PF_PID=$!
sleep 1.5

echo "▶ mint real projected SA tokens (the cluster API will verify signature/audience/expiry)"
GOOD=$(kubectl -n default create token default --audience=agent-os-gateway)
BAD_AUD=$(kubectl -n default create token default --audience=someone-else)
UNCLAIMED=$(kubectl -n "$NS" create token inference-gateway --audience=agent-os-gateway)

BODY='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200}'
hit() { # $1=auth header value or empty
  if [ -n "$1" ]; then
    curl -s -m 8 -o /tmp/gwpod-body -w '%{http_code}' "localhost:$PORT/v1/messages" -H 'content-type: application/json' -H "authorization: Bearer $1" -d "$BODY" 2>/dev/null || echo 000
  else
    curl -s -m 8 -o /tmp/gwpod-body -w '%{http_code}' "localhost:$PORT/v1/messages" -H 'content-type: application/json' -d "$BODY" 2>/dev/null || echo 000
  fi
}

pass=0; fail=0
check() { # $1=desc $2=expected $3=got
  if [ "$3" = "$2" ]; then printf "  ✅ %-52s → %s\n" "$1" "$2"; pass=$((pass+1));
  else printf "  ❌ %-52s expected %s, got %s\n" "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo "▶ THE PROOF — real SA-token identity through the Bun gateway pod:"
check "healthz" 200 "$(curl -s -m 5 -o /dev/null -w '%{http_code}' localhost:$PORT/healthz)"
check "no token → 401" 401 "$(hit '')"
check "garbage token → 401" 401 "$(hit 'not-a-token')"
check "real token, WRONG audience → 401" 401 "$(hit "$BAD_AUD")"
check "real token, un-claimed SA → 401 (no tenant bound)" 401 "$(hit "$UNCLAIMED")"
code=$(hit "$GOOD")
check "real token, claimed SA, worst-case > cap → 402" 402 "$code"
if [ "$code" = "402" ] && grep -q "system:serviceaccount:default:default" /tmp/gwpod-body; then
  printf "  ✅ %-52s → %s\n" "402 names the VERIFIED tenant (not asserted)" "$(grep -o 'system:serviceaccount:default:default' /tmp/gwpod-body | head -1)"
  pass=$((pass+1))
else
  printf "  ❌ 402 body did not name the verified tenant: %s\n" "$(cat /tmp/gwpod-body)"; fail=$((fail+1))
fi

echo "▶ gateway-pod: $pass/$((pass+fail)) checks passed"
[ "$fail" -eq 0 ] && echo "✅ PASS — TokenReview-verified identity + claim + budget hard-stop, in-cluster, \$0" || { echo "❌ FAIL"; exit 1; }
