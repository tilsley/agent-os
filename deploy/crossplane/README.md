# platform/ — Crossplane control plane (self-service APIs)

Crossplane turns the cluster into a **provisioning control plane**: teams apply a
CRD and get fully-provisioned, guard-railed AWS resources — no code change, no
CDK PR. See [ADR-0005](../docs/decisions/0005-crossplane-control-plane.md).

## Layering

- **CDK (`infra/`)** bootstraps day-0: VPC, EKS, and installs Crossplane + AWS
  providers + provider IAM.
- **Crossplane (`platform/`)** provisions day-2 per-tenant resources from claims.

The same XRDs apply to local (k3s) and prod (EKS); both provision *real* AWS.

## Layout

```text
platform/
└── apis/
    ├── inference-profile/     # self-serve Bedrock inference + cost cap
    │   ├── xrd.yaml           # CompositeResourceDefinition — the API schema
    │   ├── composition.yaml   # how the API maps to AWS managed resources
    │   └── claim-example.yaml # what a team applies (the paved road)
    └── sandbox/               # self-serve AgentCore Code Interpreter config
        ├── xrd.yaml
        ├── composition.yaml
        └── claim-example.yaml
```

## Providers (keep lean on 16GB)

Install only the granular providers needed, not the monolith:
`provider-aws-bedrock`, `provider-aws-bedrockagentcore`, `provider-aws-iam`,
`provider-aws-budgets`, `provider-aws-eks`.

## Provision vs. enforce

Crossplane provisions/reconciles infra and gives **attribution + delayed Budget
alerts**. It does **not** enforce real-time cost caps — the inference-gateway
does, reading the same `maxDailyCostUSD`. See
[ADR-0004](../docs/decisions/0004-cost-governance.md).

> Status: skeleton. `xrd.yaml`/`claim-example.yaml` use our own schema and are
> concrete; `composition.yaml` is a commented stub — provider resource kinds/
> fields must be verified against `provider-family-aws` coverage.
