#!/usr/bin/env bash
# ADR-0030 in-cluster proof: durable, per-tenant memory survives a POD RESTART, and a fresh
# session RECALLS what an earlier one remembered — through the real agent-runtime, off a PVC.
#   RUN 1 (pod A): the agent saves durable facts via the `remember` tool → MEMORY.md on the PVC.
#   restart:       the runtime pod is replaced (the PVC, not the pod, holds the memory).
#   RUN 2 (pod B): a fresh pod recalls them — the task does NOT restate the facts.
# Real Bedrock (Haiku, DIRECT via the pod's aws-creds); local sandbox, open gate (AWS-light).
#   bash deploy/local/memory-k3s.sh        (from the repo root; needs an AWS profile + colima/k3s)
set -uo pipefail
CTX=colima
NS=agentos-mem
REL=agent-os
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
k() { kubectl --context "$CTX" "$@"; }

echo "▶ build image (agent-runtime:dev)"
docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile . >/dev/null

# colima docker+k3s do NOT share an image store: load the fresh build into k3s containerd, else
# IfNotPresent serves a stale cached image (ADR notes / the e2e harness do the same).
echo "▶ load image into k3s containerd"
docker save agent-runtime:dev | colima ssh -- sudo ctr -n k8s.io images import - >/dev/null

echo "▶ namespace + aws-creds secret (short-lived STS from profile '$PROFILE')"
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
# DIRECT Bedrock uses the pod's creds; locally that's the developer profile's STS creds as a
# secret (EKS would use IRSA — no static secret). envFrom maps these to AWS_* the SDK reads.
eval "$(AWS_PROFILE="$PROFILE" aws configure export-credentials --format env-no-export)"
k -n "$NS" create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

echo "▶ helm upgrade --install $REL (AWS-light memory profile)"
helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" \
  -f deploy/local/memory-k3s-values.yaml >/dev/null
k -n "$NS" rollout restart deploy/agent-runtime >/dev/null 2>&1 || true  # pick up a same-tag rebuild
echo "▶ wait for rollout"
k -n "$NS" rollout status deploy/agent-runtime --timeout=150s

MEMFILE=/var/lib/agent-os/memory/default/MEMORY.md  # tenant=default (open gate ⇒ noop authn)

# drive a run from INSIDE the pod (no port-forward): POST /runs, poll to a terminal status, print
# the run's output as one JSON line. TASK is passed via env to dodge shell-quoting the prompt.
read -r -d '' DRIVE <<'JS'
const base = "http://localhost:3000";
const post = await fetch(base + "/runs", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ task: process.env.TASK }) });
if (!post.ok) { console.log(JSON.stringify({ status: "POST_" + post.status, output: await post.text() })); process.exit(0); }
const { runId } = await post.json();
const done = new Set(["completed", "failed", "blocked", "stuck", "max_steps"]);
let run = {};
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  run = await (await fetch(base + "/runs/" + runId)).json();
  if (done.has(run.status)) break;
}
console.log(JSON.stringify({ status: run.status, output: run.output, error: run.error }));
JS
drive() { # $1 = task ; echoes the run's JSON result
  printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$1" sh -c 'cat > /tmp/drive.js && bun /tmp/drive.js'
}

echo; echo "════════ RUN 1 — learn + remember (pod A) ════════"
R1="$(drive "Remember these durable facts about this project for future sessions, saving EACH with the remember tool: (1) the test command is 'bun test'; (2) the architecture is the ports-and-adapters pattern. Then confirm what you saved.")"
echo "$R1"

echo; echo "════════ MEMORY.md on the PVC (the durable source of truth) ════════"
k -n "$NS" exec deploy/agent-runtime -- cat "$MEMFILE" 2>/dev/null || echo "(no MEMORY.md on the PVC!)"

echo; echo "════════ RESTART the runtime pod — memory must outlive it ════════"
OLD_POD="$(k -n "$NS" get pod -l app=agent-runtime -o jsonpath='{.items[0].metadata.name}')"
echo "  old pod: $OLD_POD"
# delete the NAMED pod and wait for it to be gone (not `rollout restart` — with a RWO PVC the
# surge pod can't co-mount, and reading items[0] mid-roll races the terminating old pod). Delete
# first ⇒ the PVC is released, the Deployment recreates a fresh pod, and the name check is honest.
k -n "$NS" delete pod "$OLD_POD" --wait=true >/dev/null
k -n "$NS" rollout status deploy/agent-runtime --timeout=150s
NEW_POD="$(k -n "$NS" get pod -l app=agent-runtime --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
echo "  new pod: $NEW_POD"
[ "$OLD_POD" != "$NEW_POD" ] && echo "  ✅ pod was replaced (proves the PVC, not the pod, holds memory)" \
                            || { echo "  ❌ pod was NOT replaced — restart proof invalid"; exit 1; }

echo; echo "════════ RUN 2 — FRESH pod, recall (the task does NOT restate the facts) ════════"
R2="$(drive "A new contributor asks two things: what command runs the tests, and what architecture pattern does this project use? Answer from your memory.")"
echo "$R2"

echo; echo "──────── verdict ────────"; pass=0
echo "$R2" | grep -qiE 'bun test'                                  && echo "✅ recalled the test command (bun test) — across a pod restart" || { echo "❌ did not recall 'bun test'"; pass=1; }
echo "$R2" | grep -qiE 'ports.?and.?adapters'                      && echo "✅ recalled the architecture (ports-and-adapters)" || { echo "❌ did not recall the architecture"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ ADR-0030 proven in-cluster — durable per-tenant memory recalled by a fresh pod off the PVC." \
               || echo "❌ FAILED — see the runs above."
echo "  (teardown: kubectl --context $CTX delete ns $NS; helm --kube-context $CTX uninstall $REL -n $NS)"
exit $pass
