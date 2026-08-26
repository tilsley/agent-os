#!/usr/bin/env bash
# Full-mode mesh-trust authn on the Bun gateway (ADR-0028): the caller carries NO
# credential — Linkerd mTLS authenticates the POD, the inbound proxy stamps
# l5d-client-id, the gateway maps it to system:serviceaccount:<ns>:<sa> and resolves
# the tenant from the claim binding. The Bun twin of linkerd.md's litellm proof; the
# Istio/XFCC dialect of the same adapter is proven in unit tests (no local Istio).
# Every case rejects pre-flight ⇒ $0, no AWS.
#   make gw-mesh-test     (KEEP=1 to leave it running)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
NS=agentos-gw
cleanup() {
  kubectl -n "$NS" delete pod mesh-caller mesh-stranger --ignore-not-found --force > /dev/null 2>&1
  kubectl -n default delete pod unmesh-caller --ignore-not-found --force > /dev/null 2>&1
  [ "${KEEP:-0}" = "1" ] || helm uninstall inference-gateway -n "$NS" > /dev/null 2>&1
}
trap cleanup EXIT

echo "▶ build + deploy the gateway in MESH-TRUST mode (AUTHN=mesh-id, claim for the caller's SA)"
docker build -q -t inference-gateway:dev -f services/inference-gateway/Dockerfile . > /dev/null || exit 1
VALUES=$(mktemp)
cat > "$VALUES" <<'EOF'
awsCredsSecret: ""
env:
  AUTHN: mesh-id
  MESH_IDENTITY_HEADER: l5d-client-id   # Istio would be x-forwarded-client-cert — same adapter
  CLAIM_SOURCE: static
  CLAIMS_STATIC: '{"system:serviceaccount:agentos-gw:default":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}'
  SPEND_STORE: memory
  GATE_BUDGET_USD: "0.0001"
EOF
helm upgrade --install inference-gateway deploy/helm/inference-gateway -n "$NS" --create-namespace -f "$VALUES" > /dev/null
rm -f "$VALUES"
kubectl -n "$NS" rollout status deploy/inference-gateway --timeout=180s || { kubectl -n "$NS" logs deploy/inference-gateway -c gateway 2>/dev/null | tail -20; exit 1; }

echo "▶ start callers: meshed (SA default), meshed-unclaimed (SA inference-gateway), unmeshed (default ns)"
kubectl -n "$NS" run mesh-caller --image=curlimages/curl --restart=Never --command -- sleep 1800 > /dev/null
kubectl -n "$NS" run mesh-stranger --image=curlimages/curl --restart=Never \
  --overrides='{"spec":{"serviceAccountName":"inference-gateway","containers":[{"name":"mesh-stranger","image":"curlimages/curl","command":["sleep","1800"]}]}}' > /dev/null
kubectl -n default run unmesh-caller --image=curlimages/curl --restart=Never --command -- sleep 1800 > /dev/null
kubectl -n "$NS" wait --for=condition=Ready pod/mesh-caller pod/mesh-stranger --timeout=120s > /dev/null || exit 1
kubectl -n default wait --for=condition=Ready pod/unmesh-caller --timeout=120s > /dev/null || exit 1

BODY='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200}'
URL_IN="http://inference-gateway:3100/v1/messages"
URL_X="http://inference-gateway.agentos-gw.svc.cluster.local:3100/v1/messages"
call() { # $1=ns $2=pod $3=url $4...=extra curl args → "code|body"
  local ns=$1 pod=$2 url=$3; shift 3
  kubectl -n "$ns" exec "$pod" -c "$pod" -- \
    curl -s -m 10 -w '|%{http_code}' -X POST "$url" -H 'content-type: application/json' "$@" -d "$BODY" 2>/dev/null \
    | awk -F'|' '{print $NF "|" $1}'
}

pass=0; fail=0
check() { # $1=desc $2=expected-code $3=got(code|body) [$4=must-contain] [$5=must-NOT-contain]
  local code=${3%%|*} body=${3#*|}
  if [ "$code" = "$2" ] && { [ -z "${4:-}" ] || grep -q "$4" <<<"$body"; } && { [ -z "${5:-}" ] || ! grep -q "$5" <<<"$body"; }; then
    printf "  ✅ %-56s → %s\n" "$1" "$2"; pass=$((pass+1))
  else
    printf "  ❌ %-56s expected %s, got %s  %s\n" "$1" "$2" "$code" "$body"; fail=$((fail+1))
  fi
}

echo "▶ THE PROOF — token-less callers, identity from the mesh:"
check "meshed + claimed, NO credential → 402 as the mTLS identity" 402 \
  "$(call "$NS" mesh-caller "$URL_IN")" "system:serviceaccount:agentos-gw:default"
check "FORGED l5d-client-id → proxy strips it; real identity wins" 402 \
  "$(call "$NS" mesh-caller "$URL_IN" -H 'l5d-client-id: bob.evil.serviceaccount.identity.linkerd.cluster.local')" \
  "system:serviceaccount:agentos-gw:default" "evil"
check "meshed but UN-CLAIMED SA → 401 (no tenant bound)" 401 \
  "$(call "$NS" mesh-stranger "$URL_IN")"
check "UNMESHED caller → 401 (no mesh identity stamped)" 401 \
  "$(call default unmesh-caller "$URL_X")"

echo "▶ gateway-mesh: $pass/$((pass+fail)) checks passed"
[ "$fail" -eq 0 ] && echo "✅ PASS — mesh-stamped workload identity + claim binding + budget hard-stop; the agent held no credential" || { echo "❌ FAIL"; exit 1; }
