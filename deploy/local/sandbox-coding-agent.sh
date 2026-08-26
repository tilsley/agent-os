#!/usr/bin/env bash
# Model A, end to end, BEHIND THE EGRESS WALL (ADR-0020/0022) — the convergence of the three
# islands: the coding agent (examples/coding-agent), the egress lockdown (deploy/helm/sandbox), and
# the in-cluster gateway (deploy/helm/inference-gateway — the Bun engine, ADR-0028). The agent runs as a pod in a locked-down
# namespace; one task proves BOTH halves:
#   • think  → reaches the gateway through the wall's governed door  ✅
#   • do     → its own python's arbitrary egress is denied by the wall ❌ (NET_BLOCKED)
#
#   bash deploy/local/sandbox-coding-agent.sh        (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2
CTX=colima; GW_NS=agentos-gw; SB_NS=agentos-sandbox
TENANT="system:serviceaccount:${SB_NS}:coding-agent"
kubectl config use-context "$CTX" >/dev/null

echo "▶ 1/5  refresh Bedrock/DynamoDB creds in $GW_NS (short-lived; local only)"
kubectl create namespace "$GW_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
eval "$(aws configure export-credentials --format env-no-export)"
args="--from-literal=AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID --from-literal=AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
[ -n "${AWS_SESSION_TOKEN:-}" ] && args="$args --from-literal=AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
kubectl -n "$GW_NS" create secret generic aws-creds $args --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "▶ 2/5  gateway up in $GW_NS with a \$5 claim for the coding-agent SA (CLAIMS_STATIC)"
# a values file, NOT --set: the claim is JSON ({,:} are helm --set metacharacters). Helm
# deep-merges this env over the chart's default env, so AUTHN/REGION/etc. are preserved.
# CLAIM_SOURCE=static is required: the chart defaults to dynamo, which would ignore CLAIMS_STATIC.
CLAIMS_FILE="$(mktemp -t ca-gw-values.XXXX.yaml)"
printf 'env:\n  CLAIM_SOURCE: static\n  CLAIMS_STATIC: '\''{"%s":{"model":"claude-haiku","monthlyBudgetUsd":5}}'\''\n' "$TENANT" > "$CLAIMS_FILE"
helm upgrade --install inference-gateway deploy/helm/inference-gateway -n "$GW_NS" --create-namespace \
  -f "$CLAIMS_FILE" >/dev/null
rm -f "$CLAIMS_FILE"
# the step-1 secret refresh doesn't restart the pod, and an unchanged helm spec won't roll it —
# force a restart so the gateway always loads the FRESH short-lived creds (else: stale-token 500s on re-runs).
kubectl -n "$GW_NS" rollout restart deploy/inference-gateway >/dev/null
kubectl -n "$GW_NS" rollout status deploy/inference-gateway --timeout=180s

echo "▶ 3/5  build the python-capable coding-agent image (colima docker runtime ⇒ k3s sees it)"
docker build -q -t coding-agent:dev -f examples/coding-agent/Dockerfile . >/dev/null \
  || { echo "❌ image build failed — aborting (a stale image would give a misleading verdict)"; exit 1; }

echo "▶ 4/5  lock down $SB_NS (the wall) + open ONLY the governed gateway door"
helm upgrade --install sandbox deploy/helm/sandbox -n "$SB_NS" --create-namespace \
  --set demo.enabled=false --set gateway.enabled=true --set gateway.namespace="$GW_NS" >/dev/null
kubectl -n "$SB_NS" delete pod coding-agent --ignore-not-found >/dev/null 2>&1
kubectl apply -n "$SB_NS" -f examples/coding-agent/k8s-pod.yaml >/dev/null

echo "▶ 5/5  run the coding agent behind the wall, then assert both halves"
kubectl -n "$SB_NS" wait --for=condition=Ready pod/coding-agent --timeout=120s 2>/dev/null
# stream until the pod terminates (Never-restart), then capture the full log
kubectl -n "$SB_NS" logs -f coding-agent 2>/dev/null
kubectl -n "$SB_NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/coding-agent --timeout=180s >/dev/null 2>&1
LOG="$(kubectl -n "$SB_NS" logs coding-agent 2>/dev/null)"
# strip the prompt echo (the task text contains the sentinels) so we assert on REAL output only
BODY="$(echo "$LOG" | grep -vE '"agent.task"|task: ')"

echo; echo "──────── verdict ────────"
pass=0
echo "$BODY" | grep -q "385"          && { echo "✅ compute works behind the wall (385 — think traversed the governed door)"; } || { echo "❌ expected 385 in the agent's output"; pass=1; }
echo "$BODY" | grep -q "NET_BLOCKED"  && { echo "✅ untrusted code contained (NET_BLOCKED — arbitrary egress denied by the wall)"; } || { echo "❌ expected NET_BLOCKED (egress not contained!)"; pass=1; }
echo "$BODY" | grep -q "NET_OK"       && { echo "❌ NET_OK — the pod reached the internet directly; the wall LEAKED"; pass=1; }
echo "$LOG"  | grep -q "status=completed" && echo "✅ agent reported status=completed"
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "Model A proven end to end, behind the egress wall." || echo "FAILED — see the log above."
exit $pass
