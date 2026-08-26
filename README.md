# agent-os

A cloud-native, multi-tenant **agent operating system**. Agents need stateful,
isolated, spiky execution — closer to "serverless that runs untrusted code" than
to traditional microservices. `agent-os` is built on **three primitives** (capabilities
the agent acts with) and **three cross-cutting controls** (canonical model:
[`docs/primitives.md`](docs/primitives.md)). Every one sits behind a port, so
implementations are swappable adapters:

| # | Primitive / control | Role | Default adapter(s), behind a port |
|---|-----------|------|--------------|
| 1 | **Inference** (think) | act | Owned Bun/TS gateway (ADR-0028) → Bedrock; Vertex/OpenAI wires as adapters |
| 2 | **Sandbox** (do) | act | Adapter by profile — AgentCore Code Interpreter, E2B, or local (ADR-0020/0022) |
| 3 | **State / Memory** (remember) | act | Files-first + vector/graph tiers behind a Memory port (ADR-0030); Postgres/Redis backing (ADR-0023) |
| 4 | **Identity & governance** (gate) | cross-cutting | Cognito human + M2M identity, OPA/authz, budget ledger (ADR-0009/0015/0041) |
| 5 | **Observability** (record) | cross-cutting | OTel spans → Grafana Cloud (cheap) or ADOT→OpenSearch (full) (ADR-0035) |
| 6 | **Safety / Guardrails** (guard) | cross-cutting | Bedrock Guardrails behind a `ContentGuard` port (ADR-0008) |

The agent runtime (L1) composes these; see [`docs/runtime.md`](docs/runtime.md) and
[`docs/architecture.md`](docs/architecture.md). Decisions are recorded as ADRs —
**47 and counting** ([`docs/decisions/`](docs/decisions/)), immutable once Accepted.

> **Naming:** the platform is being renamed **agent-os → creance**. The rename is
> partial — live domains are `*.creance.nathantilsley.com` and SSM params are
> `/creance/*`, but stack names, DynamoDB tables, and task families remain `agent-os-*`.

## Status — live, not a skeleton

The control plane and multiple execution lanes are **deployed and verified live**
(AWS account `233965347831`, `eu-west-2`; GCP `europe-west2`). Highlights:

- **Serverless substrate** — the run loop as a Fargate task-per-run behind an
  API Gateway front door, DynamoDB state, scale-to-zero (ADR-0031, live).
- **Inference gateway** — the owned Bun gateway on `inference.creance.nathantilsley.com`,
  identity-bound with a real-time budget ledger (ADR-0019/0028/0039/0043, live).
- **Web console** — a static SPA behind Cognito driving the front door (ADR-0032, live).
- **Machine identity** — services authenticate via Cognito client-credentials;
  `@agent-os/client` SDK; `svc-failure-analyst` the first subject (ADR-0041, live).
- **Managed profiles** — the loop also runs on **AWS Bedrock AgentCore**
  (`DISPATCH=agentcore`, ADR-0042) and **GCP Vertex Agent Runtime**
  (`DISPATCH=agentengine`, ADR-0044), both verified live.
- **Coding lanes** — a governed `coder` loop (ADR-0046) and the foreign-L1
  `claude-code` hosted runner (ADR-0033/0036), both proven end-to-end.

### Deployment profiles (ADR-0027, extended by 0042/0044)

One contract (verified identity + real-time budget), selected by env bundle:

| Profile | Compute | Store | Selected by |
|---|---|---|---|
| **cheap AWS-native** | Fargate task-per-run + Lambda/API GW front door | DynamoDB, scale-to-zero | default |
| **full k8s** | EKS/k3s pods (Helm) | Redis + Postgres/Aurora, mesh + OPA | env bundle |
| **managed AWS** | AgentCore Runtime | DynamoDB | `DISPATCH=agentcore` |
| **managed GCP** | Vertex Agent Runtime | Firestore (shared ledger) | `DISPATCH=agentengine` |

## Repository layout

```text
agent-os/
├── docs/
│   ├── architecture.md · primitives.md · runtime.md · isolation.md · resource-model.md
│   ├── agentcore-*.md · agent-engine-*.md   # managed-platform analysis
│   └── decisions/                           # 47 ADRs (the source of truth)
├── packages/
│   ├── core/                    # @agent-os/core — ports, the L1 loop, ~55 adapters (wired in config.ts)
│   └── client/                  # @agent-os/client — typed SDK + login flows (browser/machine/gcp)
├── services/                    # deployables consuming core
│   ├── agent-runtime/           #   L1 runtime as the HTTP front door (dispatches runs)
│   ├── agent-controller/        #   k8s operator reconciling the Agent CRD
│   ├── inference-gateway/       #   the owned Bun think-gateway + budget ledger
│   ├── tool-gateway/            #   centralized tool/MCP execution
│   ├── claims-controller/       #   reconciles InferenceClaims vs Allowance
│   ├── claude-code-runner/      #   headless Claude Code as a Fargate executor
│   └── iam-authorizer · sandbox-manager · telemetry-processor/   # responsibility specs (logic lives as core adapters)
├── apps/
│   ├── console/                 # the web console SPA (ADR-0032)
│   ├── doc-gardener/            # agent that fixes doc drift
│   └── dep-migrator/            # early dependency-bump demo agent
├── examples/                    # 11 runnable POCs — a capability ladder (spine → coding → a2a → mcp → …)
├── charts/                      # Helm: agent-os, inference-gateway, sandbox, tool-gateway
└── deploy/                      # everything about HOW it deploys — one tree
    ├── aws/                     #   AWS CDK (TypeScript, via bun)
    ├── gcp/                     #   GCP infra (Pulumi) — the managed-GCP profile
    ├── crossplane/              #   Crossplane XRDs — day-2 provisioning plane (ADR-0005; narrowed by ADR-0021)
    ├── local/  eks/  aurora/    #   e2e scripts · EKS capstone · Aurora bootstrap
    └── e2b-coder/  gcp-agent-engine/
```

## Running it

`make help` lists everything. Common entry points:

```bash
make run              # agent-runtime locally, in-memory store
make local            # list local end-to-end scenarios (colima + k3s)
make local-full       # the whole-platform local e2e — one governed run
make spine-agent      # smallest real e2e: one governed think through the gateway
make coding-agent     # coding agent: think governed, code in the sandbox
```

Deploys are profile-scoped and always print the target account first
(`make whoami`). CDK stacks live in `infra/`; use `AWS_PROFILE=nathan-tilsley-developer`
(account `233965347831`), not the default profile.

## Tooling

This repo uses **bun** (not npm/node) for JS/TS, **uv** for Python, and CDK runs via
`bunx cdk`. GCP infra is Pulumi; k8s apps deploy via the Helm charts in `charts/`.
