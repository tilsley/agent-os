#!/usr/bin/env bash
# ADR-0019 local-k3s e2e (AWS-free). Builds the repo image, deploys the gateway +
# runtime + caller into colima/k3s, and runs the checks from inside the caller pod.
#   bun/Make: bash deploy/local/e2e/run.sh   (run from the repo root)
set -euo pipefail
CTX=colima
NS=agentos-e2e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "▶ build image (agent-runtime:dev — whole repo; gateway overrides the command)"
docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile . >/dev/null

# colima's docker+k3s does NOT auto-share images: docker build updates docker's store,
# but k3s containerd keeps its own copy. Load the fresh image into k3s explicitly, else
# IfNotPresent serves a stale cached image.
echo "▶ load image into k3s containerd (colima docker+k3s doesn't auto-share)"
docker save agent-runtime:dev | colima ssh -- sudo ctr -n k8s.io images import -

echo "▶ apply the claim CRDs (ADR-0021) + the allowance VAP (slice 6), then the stack"
# CRD scope is immutable — drop a prior cluster-scoped inferenceclaims CRD before (re)creating
# it Namespaced (slice 6). Deletes its CRs too; the stack recreates them.
kubectl --context "$CTX" delete crd inferenceclaims.agent-os.io --ignore-not-found --wait=true >/dev/null
kubectl --context "$CTX" apply -f deploy/helm/agent-os/crds/inferenceclaims.yaml >/dev/null # CRDs live in the chart now
for crd in inferenceclaims inferenceallowances; do
  for i in 1 2 3 4 5; do # the just-created CRD's Established condition can lag a beat
    kubectl --context "$CTX" wait --for condition=established crd/$crd.agent-os.io --timeout=10s >/dev/null 2>&1 && break || sleep 2
  done
done
helm template agent-os deploy/helm/agent-os --show-only templates/claim-policy.yaml | kubectl --context "$CTX" apply -f - >/dev/null # the VAP, from the chart
kubectl --context "$CTX" apply -f deploy/local/e2e/stack.yaml >/dev/null    # ns → allowance → claim (in order)

# recreate workloads so they pick up the freshly-loaded image (same tag => no auto-roll)
echo "▶ (re)start workloads on the fresh image"
kubectl --context "$CTX" -n "$NS" rollout restart deploy/e2e-gateway deploy/e2e-runtime deploy/e2e-claims-controller >/dev/null
kubectl --context "$CTX" -n "$NS" delete pod caller --ignore-not-found --wait=true >/dev/null
kubectl --context "$CTX" apply -f deploy/local/e2e/stack.yaml >/dev/null # recreate caller

echo "▶ wait for rollouts"
kubectl --context "$CTX" -n "$NS" rollout status deploy/e2e-gateway --timeout=120s
kubectl --context "$CTX" -n "$NS" rollout status deploy/e2e-runtime --timeout=120s
kubectl --context "$CTX" -n "$NS" rollout status deploy/e2e-claims-controller --timeout=120s
kubectl --context "$CTX" -n "$NS" wait --for=condition=ready pod/caller --timeout=120s

echo "▶ run e2e checks from inside the caller pod"
kubectl --context "$CTX" -n "$NS" exec -i caller -- sh -c 'cat > /tmp/check.js && bun /tmp/check.js' < deploy/local/e2e/check.js

# Claims are validated by the API server — no controller. Prove apply-time rejection three ways:
# CEL cross-field (CRD), and the namespace-allowance VAP (budget ceiling + allowed models).
claim() { # $1=name $2=monthlyUsd $3=model [$4=sessionUsd] → an InferenceClaim in agentos-e2e
  echo "apiVersion: agent-os.io/v1alpha1
kind: InferenceClaim
metadata: { name: $1, namespace: $NS }
spec: { serviceAccount: caller, model: $3, monthlyBudgetUsd: \"$2\"${4:+, sessionBudgetUsd: \"$4\"} }"
}
check_reject() { # $1=desc $2=manifest $3=expected-substring
  local out; out=$(printf '%s' "$2" | kubectl --context "$CTX" apply --dry-run=server -f - 2>&1 || true)
  echo "$out" | grep -qi "$3" && echo "✅ $1" || { echo "❌ $1 — got: $out"; exit 1; }
}
echo "▶ slice 6    invalid claims rejected at apply time (no controller):"
check_reject "VAP rejects budget over the namespace allowance (500 > 100)" "$(claim over 500 scripted)" "exceeds the namespace allowance"
check_reject "VAP rejects a model not in the allowance"                     "$(claim badmodel 10 gpt-9)"  "not in the namespace allowance"
check_reject "CEL rejects sessionBudget > monthlyBudget"                    "$(claim sess 1 scripted 5)"  "sessionBudgetUsd must not exceed"
printf '%s' "$(claim ok 50 scripted)" | kubectl --context "$CTX" apply --dry-run=server -f - >/dev/null 2>&1 \
  && echo "✅ an in-bounds claim (50 ≤ 100, allowed model) is accepted" || { echo "❌ in-bounds claim was rejected"; exit 1; }

# slice 7: the claims-controller enforces the AGGREGATE (sum) vs the allowance + writes status —
# the cross-object check the VAP can't do. caller-claim ($10) was created with the stack; add a
# second claim ($95) now (newer) so the namespace sum (105) exceeds the allowance (100). The VAP
# admits each ($≤100); the controller marks the newer one Rejected and the older one Ready.
echo "▶ slice 7    aggregate quota + status (claims-controller):"
printf '%s' "$(claim bot2-claim 95 scripted)" | sed 's/serviceAccount: caller/serviceAccount: bot2/' \
  | kubectl --context "$CTX" apply -f - >/dev/null
ready() { kubectl --context "$CTX" -n "$NS" get inferenceclaim "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null; }
for i in $(seq 1 20); do [ -n "$(ready bot2-claim)" ] && [ -n "$(ready caller-claim)" ] && break || sleep 2; done # await reconcile
[ "$(ready caller-claim)" = "True" ]  && echo "✅ caller-claim (\$10, fits) → Ready=True"  || { echo "❌ caller-claim Ready=$(ready caller-claim)"; exit 1; }
[ "$(ready bot2-claim)"   = "False" ] && echo "✅ bot2-claim (\$95, overflows \$100) → Ready=False (aggregate quota)" || { echo "❌ bot2-claim Ready=$(ready bot2-claim)"; exit 1; }
kubectl --context "$CTX" -n "$NS" delete inferenceclaim bot2-claim >/dev/null 2>&1 || true

echo "▶ (teardown: kubectl --context $CTX delete ns $NS; kubectl --context $CTX delete -f deploy/helm/agent-os/crds/inferenceclaims.yaml)"
