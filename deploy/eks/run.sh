#!/usr/bin/env bash
# One entry point for the EKS deploy of the CURRENT platform (the chart), superseding the stale
# hand-written deploy/eks/agent-runtime.yaml field-trip manifest. Two profiles:
#
#   cheap  — eks-values.yaml: ONE pod, runtime calls Bedrock via the keyless per-tenant chain,
#            DynamoDB stores, TenantInferenceProfile claim. Closest to the proven field trip.
#   full   — eks-full-values.yaml: local-full on EKS — both gateways + memory + claims, keyless
#            (runtime holds nothing; the inference-gateway is the sole Bedrock holder).
#
# COST: `cluster-up` starts the meter (~$0.10/hr control plane + 2×t3.medium + NAT ≈ $0.25–0.30/hr).
# It is GATED — set CONFIRM=yes to actually create. Everything else (images/manifests) is $0.
#
#   bash deploy/eks/run.sh                       # this help
#   bash deploy/eks/run.sh images full           # build + push the 3 images to ECR ($0)
#   CONFIRM=yes bash deploy/eks/run.sh cluster-up# create the cluster (COSTS $)
#   bash deploy/eks/run.sh install full          # helm install + claim objects onto a live cluster
#   bash deploy/eks/run.sh drive full            # mint a token + drive one governed run
#   bash deploy/eks/run.sh down                  # uninstall + DELETE the cluster (stops the meter)
#
# Typical session:  images → cluster-up → install → drive → down.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
PROFILE="${AWS_PROFILE:-nathan-tilsley-developer}"
ACCOUNT=233965347831; REGION=eu-west-2; ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
NS=agent-os; REL=agent-os; CTX=agent-os-eks
CLUSTER_CFG=deploy/eks/cluster.yaml
aws() { command aws --profile "$PROFILE" "$@"; }
k() { kubectl --context "$CTX" "$@"; }
die() { echo "❌ $*" >&2; exit 1; }

# images per profile: cheap needs only the runtime; full adds both gateways.
imgs_for() { case "$1" in full) echo agent-runtime inference-gateway tool-gateway;; *) echo agent-runtime;; esac; }

cmd_images() { # build (linux/amd64 — the nodes are x86) + push to ECR
  local profile="${1:-cheap}"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR" >/dev/null \
    || die "ECR login failed (check AWS_PROFILE=$PROFILE creds)"
  for repo in $(imgs_for "$profile"); do
    aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1 \
      || { echo "▶ create ECR repo $repo"; aws ecr create-repository --repository-name "$repo" --region "$REGION" >/dev/null; }
    echo "▶ build + push $ECR/$repo:dev (linux/amd64)"
    docker build --platform linux/amd64 -q -t "$ECR/$repo:dev" -f "services/$repo/Dockerfile" . >/dev/null || die "build $repo"
    docker push -q "$ECR/$repo:dev" >/dev/null || die "push $repo"
  done
  echo "✅ images pushed: $(imgs_for "$profile")"
}

cmd_cluster_up() {
  [ "${CONFIRM:-}" = "yes" ] || die "cluster-up COSTS money. Re-run with: CONFIRM=yes bash deploy/eks/run.sh cluster-up"
  echo "▶ eksctl create cluster -f $CLUSTER_CFG  (~15 min; meter starts now)"
  eksctl create cluster -f "$CLUSTER_CFG" --profile "$PROFILE" || die "eksctl create"
  aws eks update-kubeconfig --name agent-os --region "$REGION" --alias "$CTX" >/dev/null
  echo "✅ cluster up. context: $CTX  (remember: bash deploy/eks/run.sh down — to stop the meter)"
}

cmd_cluster_down() {
  echo "▶ eksctl delete cluster -f $CLUSTER_CFG  (stops the meter)"
  eksctl delete cluster -f "$CLUSTER_CFG" --profile "$PROFILE" || die "eksctl delete"
  echo "✅ cluster deleted"
}

# a gp3 StorageClass (default) for the memory PVC — the EBS CSI addon ships no default SC.
ensure_gp3() {
  k apply -f - >/dev/null <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
parameters: { type: gp3 }
YAML
}

cmd_install() {
  local profile="${1:-cheap}" values
  case "$profile" in
    cheap) values=deploy/eks/eks-values.yaml;;
    full)  values=deploy/eks/eks-full-values.yaml;;
    *) die "unknown profile '$profile' (cheap|full)";;
  esac
  k get ns "$NS" >/dev/null 2>&1 || k create namespace "$NS" >/dev/null
  ensure_gp3
  echo "▶ helm upgrade --install $REL ($profile profile)"
  helm --kube-context "$CTX" upgrade --install "$REL" deploy/helm/agent-os -n "$NS" -f "$values" >/dev/null || die "helm"

  if [ "$profile" = "cheap" ]; then
    echo "▶ TenantInferenceProfile claim + reader RBAC (status.roleArn → keyless Bedrock)"
    k apply -f deploy/eks/tenant-cr.yaml >/dev/null
  else
    echo "▶ chart CRDs + the caller SA + namespace allowance + the tenant's claim (ADR-0021)"
    k apply -f deploy/helm/agent-os/crds/ >/dev/null
    k wait --for condition=established crd/inferenceclaims.agent-os.io crd/agents.agent-os.io --timeout=30s >/dev/null 2>&1 || true
    k -n "$NS" create serviceaccount caller --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply -f - >/dev/null <<YAML
apiVersion: agent-os.io/v1alpha1
kind: InferenceAllowance
metadata: { name: default, namespace: $NS }
spec: { maxMonthlyUsd: "100", allowedModels: [claude-haiku] }
---
apiVersion: agent-os.io/v1alpha1
kind: InferenceClaim
metadata: { name: caller-claim, namespace: $NS }
spec: { serviceAccount: caller, model: claude-haiku, monthlyBudgetUsd: "10" }
YAML
  fi

  echo "▶ wait for rollouts"
  k -n "$NS" rollout restart deploy >/dev/null 2>&1 || true
  for d in $(k -n "$NS" get deploy -o name 2>/dev/null); do
    k -n "$NS" rollout status "$d" --timeout=180s 2>/dev/null || echo "  ⚠ $d not ready"
  done
  cmd_status
}

cmd_status() {
  echo; echo "════════ pods (ns $NS) ════════"
  k -n "$NS" get pods --no-headers 2>/dev/null | awk '{printf "  %-42s %s %s\n",$1,$2,$3}'
}

cmd_drive() { # mint a caller token, POST a run, poll, print the verdict
  local profile="${1:-cheap}" sa aud task
  case "$profile" in
    cheap) sa=agent-runtime; aud=agent-os;          task="What is 2+2? Answer in one short line.";;
    full)  sa=caller;        aud=agent-os-gateway;  task="What is the shipping status and carrier for order ORD-42? Use your tools to look it up, then save the result with the remember tool. One short line.";;
    *) die "unknown profile '$profile' (cheap|full)";;
  esac
  echo "▶ governed run ($profile): SA=$sa audience=$aud"
  local token; token="$(k -n "$NS" create token "$sa" --audience="$aud" --duration=1h)" || die "token"
  read -r -d '' DRIVE <<'JS'
const base="http://localhost:3000"; const auth={ "content-type":"application/json", authorization:"Bearer "+process.env.TOKEN };
const post=await fetch(base+"/runs",{method:"POST",headers:auth,body:JSON.stringify({task:process.env.TASK})});
if(!post.ok){console.log(JSON.stringify({status:"POST_"+post.status,output:await post.text()}));process.exit(0);}
const {runId}=await post.json(); const done=new Set(["completed","failed","blocked","stuck","max_steps"]); let run={};
for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,2000)); run=await (await fetch(base+"/runs/"+runId,{headers:auth})).json(); if(done.has(run.status))break;}
console.log(JSON.stringify({status:run.status,output:run.output,error:run.error}));
JS
  local R; R="$(printf '%s' "$DRIVE" | k -n "$NS" exec -i deploy/agent-runtime -- env TASK="$task" TOKEN="$token" sh -c 'cat > /tmp/d.js && bun /tmp/d.js')"
  echo "  $R"
  echo "$R" | grep -qa '"completed"' && echo "✅ run completed — keyless, fully gated on EKS" || echo "❌ run did not complete (see above)"
}

cmd_up() { local p="${1:-cheap}"; cmd_images "$p"; cmd_cluster_up; cmd_install "$p"; cmd_drive "$p"; }
cmd_down() { helm --kube-context "$CTX" uninstall "$REL" -n "$NS" >/dev/null 2>&1 || true; cmd_cluster_down; }

case "${1:-help}" in
  images)      cmd_images "${2:-cheap}";;
  cluster-up)  cmd_cluster_up;;
  cluster-down)cmd_cluster_down;;
  install)     cmd_install "${2:-cheap}";;
  drive)       cmd_drive "${2:-cheap}";;
  status)      cmd_status;;
  up)          cmd_up "${2:-cheap}";;        # images + cluster-up + install + drive (gated)
  down)        cmd_down;;                    # uninstall + delete cluster
  *) sed -n '2,28p' "$0";;
esac
