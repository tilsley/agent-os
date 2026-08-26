# agent-os on EKS

The "secure + scales" capstone: the **current** platform (the `deploy/helm/agent-os` umbrella) on a
real EKS cluster, **keyless** end to end via EKS Pod Identity — no `aws-creds` Secret, nothing to
expire. One entry point: `deploy/eks/run.sh`.

## Why this exists / what changed

A May 2026 "field trip" already proved the hard, EKS-specific bits — keyless **Pod Identity**, the
per-tenant **assume-role chain** (`sts:TagSession`, ADR-0014), ECR images, cross-pod A2A + OBO — but
it deployed **hand-written manifests** (`agent-runtime.yaml`, `a2a-demo.yaml`, `mocks/`) that predate
everything since: the tool/inference **gateways**, durable **memory**, the **claims control plane**,
the whole `local-full` assembly. Those manifests are now **superseded** (kept for reference); this
setup deploys the **chart** instead, reusing the proven `cluster.yaml`.

## Two profiles

| | `cheap` | `full` |
|---|---|---|
| values | `eks-values.yaml` | `eks-full-values.yaml` |
| topology | one runtime pod | runtime + both gateways + claims control plane (≈ `local-full`) |
| Bedrock | runtime assumes `agentos-teama` (per-tenant chain) | inference-gateway is the **sole** holder (runtime holds nothing) |
| claim model | `TenantInferenceProfile` (`tenant-cr.yaml`, `status.roleArn`) | `InferenceClaim` + allowance VAP + aggregate-controller |
| stores | DynamoDB (`agent-os-runs`/`-budgets`) | in-memory |
| images | `agent-runtime` | + `inference-gateway`, `tool-gateway` |
| keyless via | runtime Pod Identity (assume + DynamoDB) | inference-gateway Pod Identity (direct Haiku invoke) |

Both install into namespace **`agent-os`** — that's what the `cluster.yaml` Pod Identity
associations bind.

## Cost

`cluster-up` starts the meter: ~$0.10/hr control plane + 2×t3.medium + a NAT gateway ≈ **$0.25–0.30/hr**.
It is **gated** behind `CONFIRM=yes`. Everything else (building/pushing images, rendering manifests)
is **$0**. Always `down` when finished — that deletes the cluster and stops the meter.

## Usage

```bash
# $0 — build + push the images the profile needs to ECR (amd64 for the x86 nodes)
bash deploy/eks/run.sh images full

# COSTS $ — create the cluster (~15 min). Gated.
CONFIRM=yes bash deploy/eks/run.sh cluster-up

# deploy the chart + claim objects + a gp3 StorageClass for the memory PVC, then wait
bash deploy/eks/run.sh install full

# mint a caller SA token and drive one governed run through the whole stack
bash deploy/eks/run.sh drive full

# stop the meter: uninstall + delete the cluster
bash deploy/eks/run.sh down
```

`up <profile>` chains images → cluster-up → install → drive (still gated on `CONFIRM=yes`).
Default profile is `cheap`. Override the AWS profile with `AWS_PROFILE=…` (default
`nathan-tilsley-developer`).

## Files

- `cluster.yaml` — eksctl `ClusterConfig`. Pod Identity associations (runtime + inference-gateway),
  the `aws-ebs-csi-driver` addon (memory PVC), managed node group.
- `eks-values.yaml` / `eks-full-values.yaml` — chart overrides per profile.
- `tenant-cr.yaml` — the `cheap` profile's `TenantInferenceProfile` (teama, `status.roleArn`) + RBAC.
- `run.sh` — the orchestrator (images / cluster-up / install / drive / down).
- `agent-runtime.yaml`, `a2a-demo.yaml`, `mocks.yaml`, `mocks/` — **superseded** May field-trip
  manifests, kept for reference.

## Retired

The CDK `EksClusterStack` / `CoreVpcStack` stubs are not the path — eksctl owns the cluster
(config-as-code, tear-down-friendly, native Pod Identity). Those stubs have since been
removed from `infra/`; eksctl (`cluster.yaml`) is the sole cluster path.
