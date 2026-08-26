# inference-gateway

**Primitive 1 — inference (the brain) · *think* (acting).** *No code yet — responsibility spec.*

Internal API that abstracts the model provider so agents never call Bedrock /
Anthropic directly.

## Responsibilities
- Provider abstraction (`InferenceProvider` port; Bedrock adapter — see ADR-0003)
  with fallback switching.
- **Cost enforcement (the choke point — ADR-0004):** compute `tokens × price`
  per call, keep a real-time "spent today" counter (Redis/ElastiCache), and
  reject/throttle when a team hits `maxDailyCostUSD`. AWS Budgets only alerts
  (delayed) — the hard cap lives here.
- **Consume the provisioned profile:** read the team's `InferenceProfile`
  connection secret (which Bedrock **application inference profile** ARN to
  invoke) and its `maxDailyCostUSD`. The CRD is the declarative source; this is
  the runtime consumer (see `deploy/crossplane/inference-profile/`).
- Token-consumption metadata per `agent_id` / `run_id` (feeds telemetry-processor).
- **Native provider prompt caching** (not a bespoke semantic cache).
- **Guard (content safety):** screen prompts and completions via the
  `ContentGuard` port (default Bedrock Guardrails `ApplyGuardrail`, swappable) —
  block harmful/PII/injection, check grounding.
  See [ADR-0008](../../docs/decisions/0008-guard-content-safety-primitive.md).

## Notes
- Runs Tier 0 (`runc`) — trusted platform service.
- AWS access via EKS Pod Identity → scoped Bedrock policy (see `deploy/aws/lib/bedrock-stack.ts`).
- **Language: TBD** (Python or Go).
