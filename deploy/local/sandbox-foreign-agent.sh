#!/usr/bin/env bash
# Model B, end to end, BEHIND THE EGRESS WALL (ADR-0020/0022) — a REAL foreign coding CLI
# (Claude Code) runs INSIDE the sandbox as an opaque delegated agent; the runtime only
# launches-and-watches (runSandboxedAgent). The Model-A wall, reused unchanged, one level up.
# One run proves both halves:
#   • think → Claude Code → the wall's governed gateway door → Bedrock   ✅
#   • do    → Claude Code's own HTTPS GET → refused by the wall          ❌ (NET_BLOCKED)
#
#   bash deploy/local/sandbox-foreign-agent.sh        (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2
CTX=colima; GW_NS=agentos-gw; SB_NS=agentos-sandbox
TENANT="system:serviceaccount:${SB_NS}:sandboxed-agent"
kubectl config use-context "$CTX" >/dev/null

echo "▶ 1/5  refresh Bedrock/DynamoDB creds in $GW_NS (short-lived; local only)"
kubectl create namespace "$GW_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
eval "$(aws configure export-credentials --format env-no-export)"
args="--from-literal=AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID --from-literal=AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
[ -n "${AWS_SESSION_TOKEN:-}" ] && args="$args --from-literal=AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
kubectl -n "$GW_NS" create secret generic aws-creds $args --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "▶ 2/5  gateway up in $GW_NS with a \$5 claim for the sandboxed-agent SA (CLAIMS_STATIC)"
# CLAIM_SOURCE=static is required: the chart defaults to dynamo, which would ignore CLAIMS_STATIC.
CLAIMS_FILE="$(mktemp -t mb-gw-values.XXXX.yaml)"
printf 'env:\n  CLAIM_SOURCE: static\n  CLAIMS_STATIC: '\''{"%s":{"model":"claude-haiku","monthlyBudgetUsd":5}}'\''\n' "$TENANT" > "$CLAIMS_FILE"
helm upgrade --install inference-gateway deploy/helm/inference-gateway -n "$GW_NS" --create-namespace \
  -f "$CLAIMS_FILE" >/dev/null
rm -f "$CLAIMS_FILE"
# the step-1 secret refresh doesn't restart the pod, and an unchanged helm spec won't roll it —
# force a restart so the gateway always loads the FRESH short-lived creds (else: stale-token 500s on re-runs).
kubectl -n "$GW_NS" rollout restart deploy/inference-gateway >/dev/null
kubectl -n "$GW_NS" rollout status deploy/inference-gateway --timeout=180s

echo "▶ 3/5  build the Model B image (node + bun + Claude Code; colima docker ⇒ k3s sees it)"
docker build -q -t sandboxed-agent:dev -f examples/sandboxed-agent/Dockerfile . >/dev/null \
  || { echo "❌ image build failed — aborting (a stale image would give a misleading verdict)"; exit 1; }

echo "▶ 4/5  lock down $SB_NS (the wall) + open ONLY the governed gateway door"
helm upgrade --install sandbox deploy/helm/sandbox -n "$SB_NS" --create-namespace \
  --set demo.enabled=false --set gateway.enabled=true --set gateway.namespace="$GW_NS" >/dev/null
kubectl -n "$SB_NS" delete pod sandboxed-agent --ignore-not-found >/dev/null 2>&1
kubectl apply -n "$SB_NS" -f examples/sandboxed-agent/k8s-pod.yaml >/dev/null

echo "▶ 5/5  run the foreign agent behind the wall, then assert both halves"
kubectl -n "$SB_NS" wait --for=condition=Ready pod/sandboxed-agent --timeout=120s 2>/dev/null
# stream until the pod terminates (Never-restart), then capture the full log
kubectl -n "$SB_NS" logs -f sandboxed-agent 2>/dev/null
kubectl -n "$SB_NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/sandboxed-agent --timeout=240s >/dev/null 2>&1
LOG="$(kubectl -n "$SB_NS" logs sandboxed-agent 2>/dev/null)"
# strip the task echo (it names both sentinels) so we assert on REAL agent output only
BODY="$(echo "$LOG" | grep -vE 'task: ')"

echo; echo "──────── verdict ────────"
pass=0
echo "$BODY" | grep -q "385"                       && echo "✅ compute works behind the wall (385 — Claude Code's think traversed the governed door)" || { echo "❌ expected 385 in the agent's output"; pass=1; }
echo "$BODY" | grep -q "NET_BLOCKED"               && echo "✅ foreign agent contained (NET_BLOCKED — its arbitrary egress denied by the wall)" || { echo "❌ expected NET_BLOCKED (egress not contained!)"; pass=1; }
echo "$BODY" | grep -Eq "NET_OK[[:space:]]+[0-9]"  && { echo "❌ NET_OK <status> — the agent reached the internet directly; the wall LEAKED"; pass=1; }
echo "$LOG"  | grep -q "status=completed"          && echo "✅ agent reported status=completed"
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "Model B proven end to end, behind the egress wall." || echo "FAILED — see the log above."
exit $pass
