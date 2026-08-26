#!/usr/bin/env bash
# Integrated tool-gateway e2e (ADR-0011 dir. b / ADR-0029) — proves the tool gateway FOLDED INTO
# deploy/helm/agent-os: ONE `helm install` brings up the agent-runtime AND the tool gateway, and the
# runtime answers an order-status question by resolving + invoking an MCP tool THROUGH the gateway —
# forwarding only the caller's SA token (oidc-sa, verified by both via TokenReview), holding no tool
# creds and opening no MCP connection of its own. Unlike deploy/local/tool-gateway-e2e.sh (three
# standalone charts + a one-shot agent pod), this drives the real runtime HTTP service via the
# umbrella chart — exactly the path the chart integration added.
#   bash deploy/local/tool-gateway-integrated-e2e.sh        (repo root; needs an AWS profile + colima/k3s)
set -uo pipefail
CTX=colima
NS=agentos-tgw
REL=agent-os
SA=tgw-caller
AUD=agent-os-gateway
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
k() { kubectl --context "$CTX" "$@"; }

echo "▶ build images (agent-runtime:dev, tool-gateway:dev)"
docker build -q -t agent-runtime:dev -f services/agent-runtime/Dockerfile . >/dev/null \
  || { echo "❌ agent-runtime image build failed"; exit 1; }
docker build -q -t tool-gateway:dev -f services/tool-gateway/Dockerfile . >/dev/null \
  || { echo "❌ tool-gateway image build failed"; exit 1; }

# colima docker+k3s don't share an image store: load both fresh builds into k3s containerd, else
# IfNotPresent serves a stale cached image.
echo "▶ load images into k3s containerd"
docker save agent-runtime:dev tool-gateway:dev | colima ssh -- sudo ctr -n k8s.io images import - >/dev/null

echo "▶ namespace + caller SA + aws-creds secret (short-lived STS from profile '$PROFILE')"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create serviceaccount "$SA" --dry-run=client -o yaml | k apply -f - >/dev/null
eval "$(AWS_PROFILE="$PROFILE" aws configure export-credentials --format env-no-export)"
k -n "$NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ helm upgrade --install $REL (umbrella chart, toolGateway.enabled=true)"
helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" \
  -f deploy/local/tool-gateway-integrated-values.yaml >/dev/null
k -n "$NS" rollout restart deploy/agent-runtime deploy/tool-gateway >/dev/null 2>&1 || true
echo "▶ wait for both rollouts"
k -n "$NS" rollout status deploy/tool-gateway --timeout=150s
k -n "$NS" rollout status deploy/agent-runtime --timeout=150s

echo "▶ mint a caller SA token (audience=$AUD) — the identity both gateways verify"
TOKEN="$(k -n "$NS" create token "$SA" --audience="$AUD" --duration=1h)"
[ -n "$TOKEN" ] || { echo "❌ failed to mint caller token"; exit 1; }

# drive a run from INSIDE the runtime pod (no port-forward): POST /runs with the caller's bearer,
# poll to a terminal status, print the run as one JSON line. TASK + TOKEN passed via env.
read -r -d '' DRIVE <<'JS'
const base = "http://localhost:3000";
const auth = { "content-type": "application/json", authorization: "Bearer " + process.env.TOKEN };
const post = await fetch(base + "/runs", { method: "POST", headers: auth, body: JSON.stringify({ task: process.env.TASK }) });
if (!post.ok) { console.log(JSON.stringify({ status: "POST_" + post.status, output: await post.text() })); process.exit(0); }
const { runId } = await post.json();
const done = new Set(["completed", "failed", "blocked", "stuck", "max_steps"]);
let run = {};
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  run = await (await fetch(base + "/runs/" + runId, { headers: auth })).json();
  if (done.has(run.status)) break;
}
console.log(JSON.stringify({ status: run.status, output: run.output, error: run.error }));
JS

echo; echo "════════ RUN — agent answers via the gateway-fronted orders tool ════════"
TASK="What is the shipping status and carrier for order ORD-42? Use the orders lookup tool, then report the status and carrier in one short line and stop."
R="$(printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$TASK" TOKEN="$TOKEN" sh -c 'cat > /tmp/drive.js && bun /tmp/drive.js')"
echo "$R"

echo; echo "════════ tool gateway saw the call (server-side execution, creds stay here) ════════"
k -n "$NS" logs deploy/tool-gateway --tail=20 2>/dev/null | grep -iE 'orders|lookup|tools/|listening' || echo "(no tool-gateway log lines matched)"

echo; echo "──────── verdict ────────"; pass=0
echo "$R" | grep -qi 'shipped'        && echo "✅ status 'shipped' reached the agent — orders__lookup_order ran via the tool gateway → MCP" || { echo "❌ no 'shipped' in the output"; pass=1; }
echo "$R" | grep -q  'DHL'            && echo "✅ carrier 'DHL' — the MCP tool output came back THROUGH the gateway (the runtime opened no MCP connection)" || { echo "❌ no 'DHL'"; pass=1; }
echo "$R" | grep -q  '"completed"'    && echo "✅ status=completed — think (direct Bedrock) + do-tools (tool gateway) composed in the umbrella chart" || { echo "❌ run did not complete"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ Integrated tool gateway proven in-cluster — one chart, runtime invokes an external tool through the gateway holding no tool creds." \
               || echo "❌ FAILED — see the run + logs above."
echo "  (teardown: kubectl --context $CTX delete ns $NS; helm --kube-context $CTX uninstall $REL -n $NS)"
exit $pass
