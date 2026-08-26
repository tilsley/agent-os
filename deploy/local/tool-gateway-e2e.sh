#!/usr/bin/env bash
# Tool-gateway e2e, in-cluster (ADR-0011 dir. b / ADR-0029) — an agent runs through BOTH governed
# choke points in one task:
#   think → the inference gateway → Bedrock        (the agent decides to call a tool)
#   tools → the tool gateway → MCP (orders server)  (the agent never connects to the MCP server)
# The agent holds no model creds and no tool creds — only its projected SA token, which BOTH
# gateways verify via TokenReview. It answers an order-status question by calling the gateway-fronted
# MCP tool, proving the two egress planes compose.
#
#   bash deploy/local/tool-gateway-e2e.sh        (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2
CTX=colima; GW_NS=agentos-gw; AGENT_SA=tool-gateway-agent
TENANT="system:serviceaccount:${GW_NS}:${AGENT_SA}"
kubectl config use-context "$CTX" >/dev/null

echo "▶ 1/5  build + deploy the inference gateway (fresh image + creds + claim for the agent SA)"
# rebuild so the gateway carries current code (e.g. the alias-on-bespoke fix) — the e2e must not
# assume a stale inference-gateway:dev is lying around.
docker build -q -t inference-gateway:dev -f services/inference-gateway/Dockerfile . >/dev/null \
  || { echo "❌ inference-gateway image build failed — aborting"; exit 1; }
kubectl create namespace "$GW_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
eval "$(aws configure export-credentials --format env-no-export)"
kubectl -n "$GW_NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
IGW_VALUES="$(mktemp -t tg-igw.XXXX.yaml)"
printf 'env:\n  CLAIM_SOURCE: static\n  CLAIMS_STATIC: '\''{"%s":{"model":"claude-haiku","monthlyBudgetUsd":5}}'\''\n' "$TENANT" > "$IGW_VALUES"
helm upgrade --install inference-gateway deploy/helm/inference-gateway -n "$GW_NS" --create-namespace -f "$IGW_VALUES" >/dev/null
rm -f "$IGW_VALUES"
kubectl -n "$GW_NS" rollout restart deploy/inference-gateway >/dev/null # pick up the fresh creds
kubectl -n "$GW_NS" rollout status deploy/inference-gateway --timeout=180s

echo "▶ 2/5  build + deploy the tool gateway (orders MCP server granted to the agent's tenant)"
docker build -q -t tool-gateway:dev -f services/tool-gateway/Dockerfile . >/dev/null \
  || { echo "❌ tool-gateway image build failed — aborting"; exit 1; }
TGW_VALUES="$(mktemp -t tg-tgw.XXXX.yaml)"
# CLAIMS_STATIC binds the agent SA → tenant (oidc-sa authn, no budget needed here); MCP_SERVERS
# fronts the orders server, scoped to that tenant (so the run also demonstrates the allowlist).
printf 'env:\n  CLAIMS_STATIC: '\''{"%s":{}}'\''\n  MCP_SERVERS: '\''{"orders":{"transport":"stdio","command":"bun","args":["run","examples/mcp-gateway/mock-mcp-server.ts"],"tenants":["%s"]}}'\''\n' "$TENANT" "$TENANT" > "$TGW_VALUES"
helm upgrade --install tool-gateway deploy/helm/tool-gateway -n "$GW_NS" --create-namespace -f "$TGW_VALUES" >/dev/null
rm -f "$TGW_VALUES"
kubectl -n "$GW_NS" rollout status deploy/tool-gateway --timeout=120s

echo "▶ 3/5  build the agent image"
docker build -q -t tool-gateway-agent:dev -f examples/tool-gateway-agent/Dockerfile . >/dev/null \
  || { echo "❌ agent image build failed — aborting"; exit 1; }

echo "▶ 4/5  run the agent (think → inference gw; tools → tool gw)"
kubectl -n "$GW_NS" delete pod tool-gateway-agent --ignore-not-found >/dev/null 2>&1
kubectl apply -n "$GW_NS" -f examples/tool-gateway-agent/k8s-pod.yaml >/dev/null
kubectl -n "$GW_NS" wait --for=condition=Ready pod/tool-gateway-agent --timeout=120s 2>/dev/null
kubectl -n "$GW_NS" logs -f tool-gateway-agent 2>/dev/null
kubectl -n "$GW_NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/tool-gateway-agent --timeout=180s >/dev/null 2>&1

echo "▶ 5/5  verdict"
LOG="$(kubectl -n "$GW_NS" logs tool-gateway-agent 2>/dev/null)"
# strip the prompt + the toolset echo so we assert on REAL output (the tool result + the answer)
BODY="$(echo "$LOG" | grep -vE 'task: |toolset: ')"
echo; echo "──────── verdict ────────"; pass=0
echo "$BODY" | grep -qi "shipped"          && echo "✅ tool result reached the agent (shipped) — orders__lookup_order ran via the tool gateway → MCP" || { echo "❌ no 'shipped' in the output"; pass=1; }
echo "$BODY" | grep -q "DHL"               && echo "✅ carrier DHL — the MCP tool output came back through the gateway, not a direct connection" || { echo "❌ no 'DHL'"; pass=1; }
echo "$LOG"  | grep -q "status=completed"  && echo "✅ status=completed — think (inference gw) + tools (tool gw) composed" || { echo "❌ not completed"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ Tool gateway proven end to end, in-cluster — both choke points composed." || echo "❌ FAILED — see the log above."
exit $pass
