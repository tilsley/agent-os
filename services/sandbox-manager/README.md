# sandbox-manager

**Primitive 2 — sandbox (the hands) · *do* (acting).** *No code yet — responsibility spec.*

**AgentCore session client** (see [ADR-0006](../../docs/decisions/0006-agentcore-execution-environment.md)).
The **sandbox is the execution environment for untrusted code only — not the
agent**. The agent orchestration loop is a separate, trusted service. This service
does **not** spawn pods; it manages **AWS Bedrock AgentCore Code Interpreter**
sessions.

## Responsibilities
- Start / keep-alive / stop AgentCore Code Interpreter sessions on demand.
- Map session ↔ `run_id`; reconnect after a control-plane restart; recreate +
  re-hydrate on session expiry (idle timeout / max lifetime ~8h).
- Configure network mode (sandboxed vs allowlisted egress).
- Enforce compute budget (cpu/mem/time) per team (ADR-0004); emit usage to
  telemetry-processor.
- `SandboxProvider` port (ADR-0003): **AgentCore adapter** now; an EKS+gVisor
  adapter remains possible behind the same port if execution is ever in-sourced.

## Session state & persistence
- Execution state (filesystem + variables) persists **within** a session and is
  destroyed on session end — managing that lifecycle is ours.
- Crossplane provisions the named CodeInterpreter **config** (the sandbox
  template, see `deploy/crossplane/sandbox/`); **sessions** against it are runtime.
- Durable cross-run memory is **out of scope** (separate/future primitive; could
  use AgentCore Memory or S3).

## Notes
- AgentCore is an AWS API — callable from anywhere with creds (laptop, k3s, EKS),
  which is what enables the ~$0-idle local POC.
- Trusted service → runs `runc`.
- **Language: TBD** (Python or Go).
