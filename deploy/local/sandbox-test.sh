#!/usr/bin/env bash
# Egress lockdown (ADR-0020/0022) — deployed by the Helm chart (deploy/helm/sandbox), asserted
# end to end: the wall (only the gateway door open) + the named-domain allowlist proxy.
# Ephemeral: helm-uninstalls + deletes the namespace on exit (KEEP=1 to inspect).
#   bash deploy/local/sandbox-test.sh        (or: make sandbox-test)
set -uo pipefail
CTX=colima; NS=agentos-sandbox
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
trap '[ -n "${KEEP:-}" ] || { helm --kube-context "$CTX" uninstall sandbox -n "$NS" >/dev/null 2>&1; kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1; }' EXIT

echo "▶ helm install deploy/helm/sandbox"
kubectl --context "$CTX" wait --for=delete "ns/$NS" --timeout=60s >/dev/null 2>&1 || true  # clear a prior terminating ns
helm --kube-context "$CTX" upgrade --install sandbox deploy/helm/sandbox -n "$NS" --create-namespace >/dev/null
kubectl --context "$CTX" -n "$NS" rollout status deploy/egress-proxy --timeout=90s >/dev/null
kubectl --context "$CTX" -n "$NS" rollout status deploy/gateway --timeout=60s >/dev/null
kubectl --context "$CTX" -n "$NS" wait --for=condition=ready pod/sandbox --timeout=60s >/dev/null

px() { kubectl --context "$CTX" -n "$NS" exec sandbox -- curl -s -m 10 --proxy http://egress-proxy:3128 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
dr() { kubectl --context "$CTX" -n "$NS" exec sandbox -- curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
fail() { echo "❌ $1"; exit 1; }

echo "▶ the wall — only the gateway door is open"
[ "$(dr http://gateway)" = "200" ] && echo "  ✅ sandbox → gateway = 200 (allowed door)" || fail "gateway door should be 200"
[ "$(dr https://1.1.1.1)" = "200" ] && fail "internet should be blocked" || echo "  ✅ sandbox → 1.1.1.1 = blocked (wall)"

echo "▶ the proxy — named-domain allowlist"
for d in registry.npmjs.org pypi.org; do
  [ "$(px https://$d/)" = "200" ] && echo "  ✅ $d = 200" || fail "$d should be allowed"
done
for d in github.com evil.example; do
  [ "$(px https://$d/)" = "200" ] && fail "$d should be DENIED" || echo "  ✅ $d = blocked"
done
kubectl --context "$CTX" -n "$NS" exec deploy/egress-proxy -- sh -c 'grep "CONNECT github.com:443" /var/log/squid/access.log | grep -q TCP_DENIED' \
  && echo "  ✅ github.com denial is a recorded policy decision (TCP_DENIED)" || fail "expected TCP_DENIED for github.com"

echo "▶ PASS — egress lockdown via deploy/helm/sandbox (wall + allowlist). (KEEP=1 to inspect)"
