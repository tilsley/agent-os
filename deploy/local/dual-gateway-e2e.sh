#!/usr/bin/env bash
# Both chokepoints, symmetric (ADR-0019 + ADR-0029): the agent pod holds NEITHER model nor tool creds.
#   think → inference-gateway (the sole holder of Bedrock creds), do-tools → tool-gateway.
# One `helm install deploy/helm/agent-os` with inferenceGateway.enabled + toolGateway.enabled; the runtime
# has NO aws-creds, forwards only its oidc-sa identity to both gateways, and still completes a task
# that requires reasoning AND a tool call — which proves think went THROUGH the inference gateway
# (the runtime can't reach Bedrock — it has no creds).
#   bash deploy/local/dual-gateway-e2e.sh        (repo root; needs an AWS profile + colima/k3s)
set -uo pipefail
CTX=colima; NS=agentos-dual; REL=agent-os; SA=tgw-caller; AUD=agent-os-gateway
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
k() { kubectl --context "$CTX" "$@"; }

echo "▶ build + load images (agent-runtime, inference-gateway, tool-gateway)"
docker build -q -t agent-runtime:dev     -f services/agent-runtime/Dockerfile     . >/dev/null || { echo "❌ runtime build"; exit 1; }
docker build -q -t inference-gateway:dev -f services/inference-gateway/Dockerfile . >/dev/null || { echo "❌ inference-gateway build"; exit 1; }
docker build -q -t tool-gateway:dev      -f services/tool-gateway/Dockerfile      . >/dev/null || { echo "❌ tool-gateway build"; exit 1; }
docker save agent-runtime:dev inference-gateway:dev tool-gateway:dev | colima ssh -- sudo ctr -n k8s.io images import - >/dev/null

echo "▶ namespace + caller SA + aws-creds (mounted ONLY on the inference gateway)"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create serviceaccount "$SA" --dry-run=client -o yaml | k apply -f - >/dev/null
eval "$(AWS_PROFILE="$PROFILE" aws configure export-credentials --format env-no-export)"
k -n "$NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ helm upgrade --install (umbrella: BOTH gateways, runtime credential-less)"
helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" \
  -f deploy/local/dual-gateway-values.yaml >/dev/null
k -n "$NS" rollout restart deploy/agent-runtime deploy/inference-gateway deploy/tool-gateway >/dev/null 2>&1 || true
for d in inference-gateway tool-gateway agent-runtime; do k -n "$NS" rollout status deploy/$d --timeout=150s; done

echo; echo "════════ credential placement — the agent pod must hold NO model creds ════════"
RT_HAS=$(k -n "$NS" exec deploy/agent-runtime     -- sh -c 'echo ${AWS_ACCESS_KEY_ID:+yes}' 2>/dev/null)
IG_HAS=$(k -n "$NS" exec deploy/inference-gateway -- sh -c 'echo ${AWS_ACCESS_KEY_ID:+yes}' 2>/dev/null)
RT_TGW=$(k -n "$NS" exec deploy/agent-runtime     -- sh -c 'echo ${INFERENCE_GATEWAY_URL:-none}' 2>/dev/null)
echo "  agent-runtime    AWS creds: ${RT_HAS:-no}   INFERENCE_GATEWAY_URL: $RT_TGW"
echo "  inference-gateway AWS creds: ${IG_HAS:-no}"

echo; echo "════════ RUN — reasoning + a tool call, with the runtime holding no model creds ════════"
TOKEN="$(k -n "$NS" create token "$SA" --audience="$AUD" --duration=1h)"
read -r -d '' DRIVE <<'JS'
const base="http://localhost:3000"; const auth={ "content-type":"application/json", authorization:"Bearer "+process.env.TOKEN };
const post=await fetch(base+"/runs",{method:"POST",headers:auth,body:JSON.stringify({task:process.env.TASK})});
if(!post.ok){console.log(JSON.stringify({status:"POST_"+post.status,output:await post.text()}));process.exit(0);}
const {runId}=await post.json(); const done=new Set(["completed","failed","blocked","stuck","max_steps"]); let run={};
for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,2000)); run=await (await fetch(base+"/runs/"+runId,{headers:auth})).json(); if(done.has(run.status))break;}
console.log(JSON.stringify({status:run.status,output:run.output,error:run.error}));
JS
TASK="What is the shipping status and carrier for order ORD-42? Use the orders lookup tool, then answer in one short line and stop."
R="$(printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$TASK" TOKEN="$TOKEN" sh -c 'cat > /tmp/d.js && bun /tmp/d.js')"
echo "$R"

echo; echo "════════ inference gateway served the think (its log) ════════"
k -n "$NS" logs deploy/inference-gateway --tail=40 2>/dev/null | grep -aiE 'reserve|settle|generate|/v1/|messages|listening' | head -4

echo; echo "──────── verdict ────────"; pass=0
[ "$RT_HAS" != "yes" ]                         && echo "✅ agent-runtime holds NO model creds"                 || { echo "❌ runtime has AWS creds"; pass=1; }
[ "$IG_HAS" = "yes" ]                          && echo "✅ inference-gateway holds the model creds"            || { echo "❌ inference-gateway missing AWS creds"; pass=1; }
[ "$RT_TGW" != "none" ]                        && echo "✅ runtime is wired as an inference-gateway client"    || { echo "❌ INFERENCE_GATEWAY_URL not set"; pass=1; }
echo "$R" | grep -qa '"completed"'             && echo "✅ run COMPLETED → think MUST have gone via the gateway (runtime can't reach Bedrock)" || { echo "❌ run did not complete"; pass=1; }
echo "$R" | grep -qai 'shipped'                && echo "✅ tool result (shipped/DHL) reached the agent via the tool gateway" || { echo "❌ no tool result"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ SYMMETRY proven — one chart, both chokepoints; the agent pod holds neither model nor tool creds." \
               || echo "❌ FAILED — see above."
echo "  (teardown: kubectl --context $CTX delete ns $NS; helm --kube-context $CTX uninstall $REL -n $NS)"
exit $pass
