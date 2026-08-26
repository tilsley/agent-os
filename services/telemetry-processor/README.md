# telemetry-processor

**Primitive 5 — observability & tracing (the black box) · *record* (cross-cutting).** *No code yet — responsibility spec.*

Aggregates tracing and token-cost data from agent runs.

## Responsibilities
- Ingest OpenTelemetry spans (via ADOT) for every reason / tool-call / error,
  carrying `agent_id`, `run_id`, `tokens_spent`, `tool_calls`.
- Index traces into OpenSearch; archive raw prompt/completion payloads to S3.
- Aggregate token cost per agent / team / run.
- Enable step-by-step replay of non-deterministic agent loops.

## Notes
- See `deploy/aws/lib/data-log-stack.ts`.
- Open threads: span schema, retention, PII handling for raw payloads.
- **Language: TBD** (Python or Go).
