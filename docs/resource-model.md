# Platform resource model

**What objects/resources is a self-hosted agentic platform actually made of?** This
is the inventory: every platform piece mapped to its **k8s object(s)** and **AWS
resource(s)**, plus **how it scales** and **how it's secured** — the two north
stars. Read alongside [primitives.md](primitives.md) (the conceptual model) and
[architecture.md](architecture.md) (diagrams + ports/adapters).

> ⚠️ **Status note (2026-08):** the 🟡/undeployed status markers below predate the
> live deploys (ADRs 0031–0047). Treat the resource *inventory* as current but the
> *deployment status* as historical — see the [README](../README.md) for what's live.

**Status:** ✅ built & run · 🟡 partial · ⬜ designed.
**Local vs EKS:** most of this runs on **local k3s + real AWS services** at ~$0
idle; the [delta section](#local-k3s--real-aws-vs-eks--what-actually-changes) lists
the few EKS-only objects. The agent loop is *trusted* code; only untrusted
execution leaves the cluster (AgentCore) — see [ADR-0006](decisions/0006-agentcore-execution-environment.md).

---

## Data plane — what runs to serve a run

| Platform piece | k8s object(s) | AWS resource(s) | Scales via | Secured by | Status |
|---|---|---|---|---|---|
| **`agent-runtime`** (L1 loop, the front door) | Deployment · Service · HPA · ServiceAccount · ConfigMap · NetworkPolicy · PodDisruptionBudget | ECR repo (image) · IAM role | HPA (pods) + Karpenter (nodes); async worker + queue | SA→scoped IAM (Pod Identity) · NetworkPolicy · non-root/read-only-rootfs · endpoint auth (`gate`) | 🟡 |
| **think** — inference (`InferenceProvider`) | — managed (`inference-gateway` Deploy + HPA if split out: cost-cap enforcement point) | Bedrock **model access** · **application inference profile** (per tenant) · attached Guardrail | Bedrock-managed (serverless) | scoped IAM to specific model/profile ARNs · Guardrails on I/O | ✅ |
| **do** — sandbox (`SandboxProvider`) | — managed (`sandbox-manager` Deploy if split). *Self-hosted alt:* Pod + gVisor `RuntimeClass` | AgentCore **CodeInterpreter** config · per-session Firecracker microVMs (runtime) | per-session microVM, zero idle (managed) | network mode (SANDBOX/VPC/PUBLIC) · microVM isolation · IAM to `bedrock-agentcore:*` | ✅ |
| **do** — tools/MCP (`ToolProvider`) | `tool-gateway` Deploy (hosts/aggregates MCP) · MCP servers as Deploy/sidecar · ConfigMap (`MCP_SERVERS`) | AgentCore **Gateway** (hosted MCP endpoint) · Lambda/API targets it fronts | per-server; gateway HPA | per-tenant allowlist · broker creds injected · `guard` screens output · vetted sources | ✅ (client) / ⬜ (hosted) |
| **remember** — run state (`RunStore`) | — managed (cache: Redis/ElastiCache if needed) | **DynamoDB** table (runs) · **S3** (artifacts/raw payloads) · *or* AgentCore Memory | DynamoDB on-demand capacity (auto) · S3 unbounded | scoped IAM to table/bucket ARN · encryption-at-rest · PITR | 🟡 (in-memory ✅; DynamoDB adapter + CDK `StateStack` ready, undeployed) |
| **gate** — identity·budget·creds (`Gate` + `CredentialBroker`) | Namespace-per-tenant · ResourceQuota · LimitRange · NetworkPolicy · RBAC (Role/RoleBinding) · `iam-authorizer` Deploy if split | IAM roles (per-tenant scoped) · STS (assume-role) · **Pod Identity** associations · Secrets Manager / AgentCore **Identity** (token vault) · **AWS Budgets** | per-tenant namespace + quota | least-priv IAM · human×agent token · scoped short-lived creds · budget caps | 🟡 (thin-local ✅) |
| **record** — observability (`TelemetrySink`) | **ADOT Collector** (DaemonSet) + gateway Deploy (tail-sampling) · `telemetry-processor` if split | **OpenSearch** (traces) · **S3** (raw payloads) · CloudWatch | collector gateway + tail-sampling (cost control) | scoped IAM to OpenSearch/S3 · PII handling on payloads | ✅ (sink) / ⬜ (collector→store) |
| **guard** — safety (`ContentGuard`) | — enforced inline (runtime + gateways) | Bedrock **Guardrail** config | managed (ApplyGuardrail per call) | content filters · PII · denied topics · prompt-attack (injection defense) | ✅ |

---

## Control plane — provisioning (how the above gets created)

| Piece | k8s object(s) | AWS resource(s) | Secured by | Status |
|---|---|---|---|---|
| **Crossplane** (day-2 self-service) | Crossplane core Deploy · `provider-aws-*` Deploys · `ProviderConfig` (CRD) · **XRDs + Compositions** (`apis/inference-profile`, `apis/sandbox`) · per-tenant **Claims** | *provisions:* inference profiles · scoped IAM · Budgets · DynamoDB · Guardrails | provider role scoped + **keyless** (IRSA/Pod Identity) | 🟡 (1 resource proven, keyless) |
| **CDK** (`infra/`) | — | `StateStack` (DynamoDB runs table + scoped runtime role) · `BedrockStack` (Guardrail + invoke policy) · *day-0:* VPC · EKS · OIDC · ECR · Crossplane | — | 🟡 (State + Bedrock synth clean, undeployed; EKS day-0 still skeleton) |

**Provision vs. enforce:** Crossplane *provisions* infra (cost attribution + delayed
Budget alerts); the `inference-gateway` *enforces* real-time caps. One CRD field
(`maxDailyCostUSD`) feeds both ([ADR-0004](decisions/0004-cost-governance.md)).

## Agent control plane — lifecycle of agents (#5)

| Piece | k8s object(s) | AWS resource(s) | Status |
|---|---|---|---|
| **`agent-registry`** (catalog: definitions, versions, config) | **`Agent` CRD** + CRs (`AgentRegistry` port: in-memory / `KubeAgentRegistry`) | (future: agent images in ECR) | ✅ runtime resolves agents from CRs |
| **`agent-controller`** (reconciler: validates, writes `.status`) | Deployment + SA + RBAC (agents + agents/status) | — | 🟡 operator (resync; no watch yet) |

Sibling of Crossplane (the *infra* control plane); governs L2, read by L1. See
[primitives.md](primitives.md#agent-control-plane-planned-5).

---

## Cross-cutting — scaling

| Lever | Object | What it scales |
|---|---|---|
| **Karpenter** | `NodePool` + `EC2NodeClass` | nodes (just-in-time, consolidation) — EKS-only |
| **HPA** | `HorizontalPodAutoscaler` | runtime/gateway pods (CPU / concurrency) |
| **Async + queue** | SQS + worker Deployment | run throughput (decouple submit from execute) |
| **Managed serverless** | — | think (Bedrock) · do (AgentCore microVMs) · remember (DynamoDB on-demand) scale themselves |

## Cross-cutting — security

| Concern | Object |
|---|---|
| Workload → cloud identity (keyless) | **Pod Identity** association (EKS) / IRSA / scoped STS (local) — [[prefer-keyless-aws-auth]] |
| Tenant isolation | Namespace + ResourceQuota + LimitRange + RBAC |
| Network containment | NetworkPolicy (default-deny + egress allowlist) · egress proxy (Squid/Envoy) |
| Pod hardening | PodSecurity `restricted` · non-root · read-only rootfs · drop caps |
| Least-privilege cloud | per-tenant/per-agent scoped IAM roles |
| Content safety | Bedrock Guardrails (`guard`) |
| Untrusted execution | AgentCore microVM (or gVisor `RuntimeClass`) — [isolation.md](isolation.md) |
| Secrets / third-party creds | token vault (AgentCore Identity / Auth0 / Secrets Manager) — never static, short-lived |

---

## Local (k3s + real AWS) vs EKS — what actually changes

You can learn ~80% of this model at ~$0 on local k3s talking to real AWS. Only
these change when you move to EKS:

| Concern | Local (k3s + real AWS) | EKS (prod) |
|---|---|---|
| Workload→IAM | scoped **STS assume-role** (creds via env) | **Pod Identity** association (SA→role) |
| Node scaling | single node (your laptop) | **Karpenter** NodePool/EC2NodeClass |
| Day-0 bootstrap | `helm`/`kubectl` apply by hand | **CDK** (VPC, EKS, OIDC, Crossplane) |
| Observability backend | console / OTLP→local collector | ADOT→**OpenSearch** + S3 |
| Untrusted exec isolation | local sandbox (none) or real AgentCore | real AgentCore (or in-cluster gVisor) |
| Everything else (Bedrock, AgentCore, DynamoDB, Guardrails, Crossplane CRDs, k8s objects) | **identical — real AWS** | identical |

**Implication:** reserve EKS for a one-off *field trip* to see **Pod Identity** +
**Karpenter** in the flesh; everything else is learnable locally against real AWS.

### Field-trip result (verified, then torn down)
Ran an ephemeral eksctl cluster ([deploy/eks](../deploy/eks)) and proved the one
EKS-only thing — **keyless Pod Identity**: the `agent-runtime` pod had **no
`aws-creds` Secret and no `AWS_ACCESS_KEY_ID`** (creds came from
`AWS_CONTAINER_CREDENTIALS_FULL_URI`, auto-rotating), yet a run completed via
Bedrock + AgentCore + DynamoDB — ending the expiring-creds treadmill. **Karpenter
turned out unnecessary:** the spiky/bursty scaling concern is *untrusted execution*,
and **AgentCore already auto-scales that** (a microVM per session, zero idle) — so
there's no sandbox node-fleet for Karpenter to manage; it would only scale the
*trusted* platform pods (steady-state, a managed nodegroup suffices). The genuinely
hard scaling problem is solved by ADR-0006, not deferred to Karpenter.

## Minimal stand-up checklist

**Local-now (≈$0 idle):** colima + k3s · Bedrock model access enabled · an IAM role
the SDK can assume (scoped to Bedrock/AgentCore/DynamoDB) · `agent-runtime`
Deployment + ConfigMap · a DynamoDB table (runs) · Crossplane (optional) for the
inference profile.

**EKS field-trip (ephemeral — up, look, down):** CDK day-0 (VPC, EKS, OIDC, ECR,
Crossplane) · Pod Identity association for the runtime SA · Karpenter NodePool ·
ADOT Collector → OpenSearch.
