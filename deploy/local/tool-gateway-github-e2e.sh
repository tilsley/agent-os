#!/usr/bin/env bash
# A REAL MCP server through the gateway, IN-CLUSTER (ADR-0010/0011/0029): the agent-runtime answers a
# question about a GitHub repo by invoking GitHub's REMOTE read-only MCP server THROUGH the tool
# gateway. The gateway's CredentialBroker injects a read-only PAT it reads from a k8s Secret — the PAT
# lives ONLY in the tool-gateway pod; the agent forwards only its identity and holds no tool cred.
#   - think  → direct Bedrock (Haiku)
#   - tools  → tool gateway → broker injects PAT → GitHub remote MCP (real issues come back)
# Needs a read-only PAT at scratchpad/gh-pat (provided out of band; never printed by this script).
#   PAT_FILE=/path/to/gh-pat bash deploy/local/tool-gateway-github-e2e.sh
set -uo pipefail
CTX=colima; NS=agentos-ghub; REL=agent-os; SA=tgw-caller; AUD=agent-os-gateway
OWNER=modelcontextprotocol; REPO=servers
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
PAT_FILE="${PAT_FILE:-/private/tmp/claude-501/-Users-nathantilsley-repos-tilsley-agent-os/043079fe-0db8-4c65-9669-4bb74831113c/scratchpad/gh-pat}"
k() { kubectl --context "$CTX" "$@"; }
[ -s "$PAT_FILE" ] || { echo "❌ no PAT at $PAT_FILE"; exit 1; }

echo "▶ build + load images (agent-runtime:dev, tool-gateway:dev)"
docker build -q -t agent-runtime:dev -f services/agent-runtime/Dockerfile . >/dev/null || { echo "❌ runtime build"; exit 1; }
docker build -q -t tool-gateway:dev  -f services/tool-gateway/Dockerfile  . >/dev/null || { echo "❌ gateway build"; exit 1; }
docker save agent-runtime:dev tool-gateway:dev | colima ssh -- sudo ctr -n k8s.io images import - >/dev/null

echo "▶ namespace + caller SA"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" create serviceaccount "$SA" --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ aws-creds secret (Bedrock, DIRECT)"
eval "$(AWS_PROFILE="$PROFILE" aws configure export-credentials --format env-no-export)"
k -n "$NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ github-cred secret (the PAT in CRED_BROKER_CONFIG — built from the file, never printed)"
# tenant key = the caller SA string (oidc-sa: tenant == verified SA). Value carries the PAT; we do
# NOT dry-run|apply (that would emit the base64 secret) — delete + create, output suppressed.
CFG="$(printf '{"system:serviceaccount:%s:%s":{"github":{"scheme":"bearer","token":"%s","ttlSeconds":300}}}' "$NS" "$SA" "$(cat "$PAT_FILE")")"
k -n "$NS" delete secret github-cred --ignore-not-found >/dev/null 2>&1
k -n "$NS" create secret generic github-cred --from-literal=CRED_BROKER_CONFIG="$CFG" >/dev/null
unset CFG

echo "▶ helm upgrade --install (umbrella, tool gateway → GitHub remote MCP via the broker)"
helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" \
  -f deploy/local/tool-gateway-github-values.yaml >/dev/null
k -n "$NS" rollout restart deploy/agent-runtime deploy/tool-gateway >/dev/null 2>&1 || true
k -n "$NS" rollout status deploy/tool-gateway --timeout=150s
k -n "$NS" rollout status deploy/agent-runtime --timeout=150s

echo "▶ mint caller token (audience=$AUD)"
TOKEN="$(k -n "$NS" create token "$SA" --audience="$AUD" --duration=1h)"
[ -n "$TOKEN" ] || { echo "❌ token mint failed"; exit 1; }

read -r -d '' DRIVE <<'JS'
const base = "http://localhost:3000";
const auth = { "content-type": "application/json", authorization: "Bearer " + process.env.TOKEN };
const post = await fetch(base + "/runs", { method: "POST", headers: auth, body: JSON.stringify({ task: process.env.TASK }) });
if (!post.ok) { console.log(JSON.stringify({ status: "POST_" + post.status, output: await post.text() })); process.exit(0); }
const { runId } = await post.json();
const done = new Set(["completed", "failed", "blocked", "stuck", "max_steps"]);
let run = {};
for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); run = await (await fetch(base + "/runs/" + runId, { headers: auth })).json(); if (done.has(run.status)) break; }
console.log(JSON.stringify({ status: run.status, output: run.output, error: run.error }));
JS

echo; echo "════════ RUN — agent answers from the live repo via the gateway-fronted GitHub MCP ════════"
TASK="How many OPEN issues does the GitHub repo ${OWNER}/${REPO} have right now, and what is the title of one of them? Use your github tools, then answer in two short lines and stop."
R="$(printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$TASK" TOKEN="$TOKEN" sh -c 'cat > /tmp/d.js && bun /tmp/d.js')"
echo "$R"

echo; echo "════════ runtime saw the real tool call (proof it ran, not hallucinated) ════════"
# plain-text greps only — the loop prints tool lines with emoji that carry a variation selector,
# so emoji-anchored patterns are unreliable. `tool.github__` is the execution telemetry span.
LOG="$(k -n "$NS" logs deploy/agent-runtime --tail=300 2>/dev/null)"
echo "$LOG" | grep -aiE 'tool\.github__|github__[a-z_]+ \{|"number"' | head -4

echo; echo "──────── verdict ────────"; pass=0
echo "$R"   | grep -qa '"completed"'                                  && echo "✅ run completed" || { echo "❌ not completed"; pass=1; }
echo "$LOG" | grep -qaiE 'tool\.github__|github__[a-z_]+ \{'          && echo "✅ agent called a github__ tool THROUGH the gateway (broker-injected PAT)" || { echo "❌ no github tool call in runtime log"; pass=1; }
echo "$LOG" | grep -qaiE '"number"|"title"'                           && echo "✅ live GitHub data came back through the gateway" || { echo "❌ no live tool data in runtime log"; pass=1; }
grep -qaF "$(cat "$PAT_FILE")" <<<"$R$LOG"                            && { echo "❌ PAT LEAKED into the run/logs"; pass=1; } || echo "✅ containment: the PAT never appears in the answer or runtime logs (it lives only in the tool-gateway Secret)"
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ Real MCP server proven in-cluster — agent reached live GitHub through the gateway; the PAT stayed in the tool-gateway pod." \
               || echo "❌ FAILED — see above."
echo "  (teardown: kubectl --context $CTX delete ns $NS; helm --kube-context $CTX uninstall $REL -n $NS)"
exit $pass
