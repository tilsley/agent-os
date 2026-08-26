# deploy/local — run agent-os on a local cluster

> **Namespace convention (read this first).** Local namespaces had sprawled (three
> `agentos*` namespaces) because each test script picked its own and none tore down.
> The rule now: a persistent dev deploy lives in **`agentos`**; every *scenario*
> (run via [`run.sh`](run.sh)) uses its **own** namespace and prints a teardown line on exit (older
> harnesses `trap`-clean with `KEEP=1` to inspect). Our resources are **Helm charts**
> ([`deploy/helm/`](../../charts)) — `deploy/helm/sandbox`
> for the egress harness, `deploy/helm/agent-os` for the apps — not ad-hoc `kubectl apply`.
> (Crossplane and LiteLLM are deployed separately, their own thing.)

Runs `agent-runtime` in-cluster on **colima + k3s** (lean, 16 GB-friendly), deployed by the
**[`deploy/helm/agent-os`](../../deploy/helm/agent-os)** Helm chart (same chart on EKS — only `values`
differ: image pull policy, adapter env, IRSA-vs-secret creds). The chart bundles the
**isolation set** (namespace ResourceQuota/LimitRange/NetworkPolicy — the k8s side of `gate`),
the **workload** (agent-runtime SA/ConfigMap/Deployment+OPA sidecar/Service/HPA), the
**agent-controller**, the control-plane **CRDs** (Agent, InferenceClaim/Allowance) and the
onboarding **VAP**.

## Scenarios — one entry point

The e2e scripts here are reached through a single dispatcher, with **`local-full`** as the anchor
(the *whole* platform in one governed run) and the rest as focused slices that isolate one contract
— a slice fails unambiguously; the anchor proves they compose. List them, then run one:

```bash
bash deploy/local/run.sh                 # list every scenario (id + what it proves)
bash deploy/local/run.sh local-full      # the anchor: everything on, one governed run
make local-full                          # same, via Make
make local                               # same as `run.sh` with no args
```

| id | proves |
|----|--------|
| **`local-full`** | **everything on** + one governed run: `think`(gateway) + `do`-tools(gateway) + `remember`, under oidc-sa + OPA + claim budget + quota — the anchor |
| `inference-claims` | inference gateway + claims CRDs/VAP/aggregate-controller (AWS-free) |
| `gate-conformance` | the gate contract (R1 identity + R2 budget) holds identically across profiles |
| `gateway-pod` / `gateway-mesh` | `think` chokepoint: SA-token TokenReview → claim → 402 / mesh-trust authn |
| `memory` | durable per-tenant memory survives a pod restart |
| `tool-gateway` / `-umbrella` / `-github` / `dual-gateway` | `do`-tools through the gateway (both choke points, umbrella-folded, real GitHub MCP, credential-less agent) |
| `sandbox` / `sandbox-coding` / `sandbox-foreign` | `do`-exec egress lockdown; Model A / Model B behind the wall |
| `a2a` | two real agents collaborate over A2A, governed at every hop |

Each scenario builds its image(s), deploys into an ephemeral namespace, runs its checks, and prints a
teardown line; most need an AWS profile (Bedrock) — pass `AWS_PROFILE=…`. The sections below are the
manual setup the scripts automate (build → creds → deploy → drive).

## 1. Cluster (colima ships k3s — no k3d needed)
```bash
colima start --kubernetes --cpu 2 --memory 4 --disk 20
kubectl get nodes
```

## 2. Build the image
colima wires k3s to the **docker** runtime (`kubectl get nodes -o wide` shows
`CONTAINER-RUNTIME: docker://…`), so an image built with `docker build` is already
visible to k3s — **no import, no sudo** (the Deployment uses
`imagePullPolicy: Never` so it won't reach for a registry):
```bash
docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile .
```
> On a containerd-runtime cluster (e.g. EKS, or `colima --runtime containerd`)
> you'd push to a registry / `ctr images import` instead.

## 3. AWS creds (local only) — `make k8s-creds`
The pod calls Bedrock (+ DynamoDB if `RUN_STORE=dynamodb`), so give it creds via a
Secret. On EKS this is **Pod Identity** binding the ServiceAccount to the
`agent-os-runtime` IAM role — no secret (ADR-0001/0006). That keyless binding is the
**one genuinely EKS-only piece**.
```bash
kubectl -n agent-os create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)"
```
> **DynamoDB note:** the ConfigMap defaults `RUN_STORE=dynamodb`, which needs (a)
> the `agent-os-runs` table (deploy `AgentOsState` first) and (b) creds with access
> to it. If your IAM user lacks DynamoDB perms, either grant them, have the runtime
> assume the `agent-os-runtime` role, or set `RUN_STORE=memory` for a creds-light
> smoke test. `GUARDRAIL_ID` (the `AgentOsBedrock` output) enables `guard`.

The ConfigMap also sets `GATE=local` (Bearer-token auth + per-tenant budget). Provide
the tokens via a Secret (`token:tenant:subject` pairs); then calls need
`Authorization: Bearer <token>`:
```bash
kubectl -n agent-os create secret generic gate-tokens \
  --from-literal=GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob"
```

## 4. Deploy + test
```bash
make k8s-deploy   # helm upgrade --install agent-os deploy/helm/agent-os -n agent-os --create-namespace
kubectl -n agent-os port-forward svc/agent-runtime 3000:80 &

curl localhost:3000/healthz
ID=$(curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"task":"Use run_code to print 2+2."}' | bun -e 'console.log((await Bun.stdin.json()).runId)')
curl -s localhost:3000/runs/$ID            # poll until terminal
```

## Notes
- **Object set (what you're learning):** the chart's `templates/namespace-primitives.yaml` =
  isolation (ResourceQuota + LimitRange + NetworkPolicy); `templates/agent-runtime.yaml` =
  workload (ServiceAccount + ConfigMap + Deployment + Service + HPA). Maps to the
  "secured by" + "scales via" columns of [resource-model.md](../../docs/resource-model.md).
- **Caveats on this cluster:** the **NetworkPolicy** isn't enforced by k3s' default
  flannel CNI (install Calico to make it bite); the **HPA** needs metrics-server
  (k3s ships it). Both are included to learn the objects.
- **Fully local (no AWS)** alternative: `INFERENCE_PROVIDER=ollama` +
  `SANDBOX_PROVIDER=local` + `RUN_STORE=memory` in the ConfigMap (drop `aws-creds`).
  Ollama must be reachable from the pod (`host.docker.internal`).
- **Logs / traces:** `kubectl -n agent-os logs deploy/agent-runtime` shows the step
  trace (`record`). Set `TELEMETRY=otel` + `OTEL_EXPORTER_OTLP_ENDPOINT` to ship.
- **Prod (EKS):** same manifests; replace `imagePullPolicy: Never` + image ref with
  an ECR image, and the `aws-creds` Secret with a **Pod Identity association**
  binding the `agent-runtime` SA → `agent-os-runtime` role (CDK StateStack).
