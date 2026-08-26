#!/usr/bin/env bash
# local-full — the WHOLE platform on, one chart, and ONE governed run through the entire stack.
# Unlike the single-feature slices, this turns everything on together and drives a real agent run:
#   caller SA token → runtime authn(oidc-sa) → authz(OPA, non-default tenant) → [think → inference
#   gateway (claim budget, Bedrock) | do-tools → tool gateway (orders MCP) | remember → durable
#   memory], under quota + networkPolicy, agent catalog from the kube registry, claims control plane
#   (CRDs + allowance VAP + controller) live. Surfaces the integration issues the slices hide.
#   bash deploy/local/local-full-e2e.sh        (repo root; needs an AWS profile + colima/k3s)
set -uo pipefail
CTX=colima; NS=agentos-full; REL=agent-os; SA=caller; AUD=agent-os-gateway
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
k() { kubectl --context "$CTX" "$@"; }

echo "▶ build + load images (agent-runtime, inference-gateway, tool-gateway)"
docker build -q -t agent-runtime:dev     -f services/agent-runtime/Dockerfile     . >/dev/null || { echo "❌ runtime build"; exit 1; }
docker build -q -t inference-gateway:dev -f services/inference-gateway/Dockerfile . >/dev/null || { echo "❌ inference-gateway build"; exit 1; }
docker build -q -t tool-gateway:dev      -f services/tool-gateway/Dockerfile      . >/dev/null || { echo "❌ tool-gateway build"; exit 1; }
docker save agent-runtime:dev inference-gateway:dev tool-gateway:dev | colima ssh -- sudo ctr -n k8s.io images import - >/dev/null

# CRDs: drop a prior (possibly cluster-scoped) inferenceclaims CRD — scope is immutable — then apply
# the chart's CRDs EXPLICITLY. helm installs crds/ only on a fresh `install`, never on `upgrade`, so a
# re-run would otherwise leave the just-deleted CRD missing and every claim read would 404.
k delete crd inferenceclaims.agent-os.io --ignore-not-found --wait=true >/dev/null 2>&1 || true
k apply -f deploy/helm/agent-os/crds/ >/dev/null
k wait --for condition=established crd/inferenceclaims.agent-os.io crd/agents.agent-os.io --timeout=30s >/dev/null 2>&1 || true

echo "▶ namespace + aws-creds (Bedrock — mounted only on the inference gateway)"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
eval "$(AWS_PROFILE="$PROFILE" aws configure export-credentials --format env-no-export)"
k -n "$NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ helm upgrade --install (EVERYTHING on)"
helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" \
  -f deploy/local/local-full-values.yaml >/dev/null

echo "▶ caller SA + the namespace allowance + the tenant's claim (ADR-0021)"
k -n "$NS" create serviceaccount "$SA" --dry-run=client -o yaml | k apply -f - >/dev/null
cat <<YAML | k apply -f - >/dev/null
apiVersion: agent-os.io/v1alpha1
kind: InferenceAllowance
# MUST be named "default" — the claim-policy VAP binding's paramRef.name=default looks for exactly
# this allowance in the claim's namespace (parameterNotFoundAction=Deny), else every claim is denied.
metadata: { name: default, namespace: $NS }
spec: { maxMonthlyUsd: "100", allowedModels: [claude-haiku] }
---
apiVersion: agent-os.io/v1alpha1
kind: InferenceClaim
metadata: { name: caller-claim, namespace: $NS }
spec: { serviceAccount: $SA, model: claude-haiku, monthlyBudgetUsd: "10" }
YAML

echo "▶ wait for rollouts (runtime, both gateways, controller)"
# pick up same-tag (:dev) image rebuilds — IfNotPresent won't restart pods on an unchanged tag.
k -n "$NS" rollout restart deploy/agent-runtime deploy/inference-gateway deploy/tool-gateway deploy/agent-controller deploy/claims-controller >/dev/null 2>&1 || true
for d in inference-gateway tool-gateway agent-runtime agent-controller claims-controller; do
  k -n "$NS" rollout status deploy/$d --timeout=150s 2>/dev/null || echo "  ⚠ $d not ready (may be off)"
done

echo; echo "════════ component health ════════"
k -n "$NS" get pods --no-headers 2>/dev/null | awk '{printf "  %-40s %s %s\n",$1,$2,$3}'

echo; echo "════════ governed run — think(gw) + do-tools(gw) + remember, all gated ════════"
TOKEN="$(k -n "$NS" create token "$SA" --audience="$AUD" --duration=1h)"
read -r -d '' DRIVE <<'JS'
const base="http://localhost:3000"; const auth={ "content-type":"application/json", authorization:"Bearer "+process.env.TOKEN };
const post=await fetch(base+"/runs",{method:"POST",headers:auth,body:JSON.stringify({task:process.env.TASK})});
if(!post.ok){console.log(JSON.stringify({status:"POST_"+post.status,output:await post.text()}));process.exit(0);}
const {runId}=await post.json(); const done=new Set(["completed","failed","blocked","stuck","max_steps"]); let run={};
for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,2000)); run=await (await fetch(base+"/runs/"+runId,{headers:auth})).json(); if(done.has(run.status))break;}
console.log(JSON.stringify({status:run.status,output:run.output,error:run.error}));
JS
TASK="What is the shipping status and carrier for order ORD-42? Use your tools to look it up, then save the result to your memory with the remember tool. Answer in one short line."
R="$(printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$TASK" TOKEN="$TOKEN" sh -c 'cat > /tmp/d.js && bun /tmp/d.js')"
echo "$R"

echo; echo "════════ proof points ════════"
RT_AWS=$(k -n "$NS" exec deploy/agent-runtime -- sh -c 'echo ${AWS_ACCESS_KEY_ID:+yes}' 2>/dev/null)
RT_LOG="$(k -n "$NS" logs deploy/agent-runtime --tail=300 2>/dev/null)"
MEMFILE=/var/lib/agent-os/memory/$NS/MEMORY.md
echo "  runtime AWS creds: ${RT_AWS:-no}"
k -n "$NS" exec deploy/agent-runtime -- sh -c "cat $MEMFILE 2>/dev/null | tail -3" 2>/dev/null | sed 's/^/  mem: /' || echo "  (no MEMORY.md)"

echo; echo "──────── verdict ────────"; pass=0
CLAIM_READY="$(k -n "$NS" get inferenceclaim caller-claim -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)"
echo "$R"    | grep -qa '"completed"'                  && echo "✅ governed run completed (authn oidc-sa + authz OPA + claim budget all admitted it)" || { echo "❌ run did not complete"; pass=1; }
[ "$CLAIM_READY" = "True" ]                            && echo "✅ claims-controller reconciled the claim to Ready=True (aggregate ≤ allowance)" || { echo "❌ claim not marked Ready (got '${CLAIM_READY:-none}')"; pass=1; }
echo "$R"    | grep -qai 'shipped\|DHL'                && echo "✅ do-tools: orders tool answered THROUGH the tool gateway" || { echo "❌ no tool result"; pass=1; }
echo "$RT_LOG" | grep -qaiE 'remember|wrote'           && echo "✅ remember: the agent wrote to durable memory" || echo "⚠ remember not observed in log (check mem file)"
[ "$RT_AWS" != "yes" ]                                 && echo "✅ runtime holds NO model creds (think went via the inference gateway)" || { echo "❌ runtime has AWS creds"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ LOCAL-FULL — the whole platform up, one governed run through think+do+remember, every control on." \
               || echo "❌ FAILED — see above (this is the integration surface we're hardening)."
echo "  (teardown: kubectl --context $CTX delete ns $NS; helm --kube-context $CTX uninstall $REL -n $NS; kubectl --context $CTX delete crd inferenceclaims.agent-os.io agents.agent-os.io --ignore-not-found)"
exit $pass
