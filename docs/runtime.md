# The agent runtime (L1)

L0 is the [primitives](primitives.md); L2 is applications. **L1 is the agent** —
the orchestration loop that composes the primitives. This doc defines the L1
contract: what an agent is, how it's invoked, and what the loop does each step.

> ⚠️ **Status note (2026-08):** items this doc marks "deferred" have since shipped —
> the **State/Memory** primitive (ADR-0030) and **multi-agent / A2A** (ADR-0017/0018,
> see `examples/a2a-runtimes`). See the [README](../README.md) and ADRs for current state.

## What an agent is

The agent is **trusted code** (a `runc` pod in k8s) that runs a loop over the
primitives. It is **not** the sandbox — the sandbox is only where its untrusted
code executes ([ADR-0006](decisions/0006-agentcore-execution-environment.md)).
Packaging: a container, optionally built on a framework (Strands, LangGraph, …).
Each agent has a **workload identity** → EKS Pod Identity → scoped IAM +
credential broker.

## The loop (per step)

```
decide
  → guard(input)          # content safety in
  → inference             # think
  → guard(output)         # content safety out
  → act (optional):       # do
        sandbox run-code  OR  tool/MCP call
  → guard(untrusted out)  # screen tool/RAG output before it re-enters context
  → state read/write      # remember
```

Every action is **gated** (identity), **recorded** (observability), and content is
**guarded** (safety) — the three cross-cutting controls.

## Invocation (the front door)

How work enters the system (north-south):
- **Sync** request/response — short tasks.
- **Streaming** — token/event streaming for UX.
- **Async job** — long-running: submit → `run_id` → poll/subscribe → result.
- **Triggers** — API, events, schedules.

Agents are long-running and spiky, so async needs a **durable-execution substrate**
(survives restarts, retries, resumes). Options: Step Functions / Temporal / a
queue, or **AgentCore Runtime** sessions (session-isolated, up to 8h). *Not yet
decided — open thread.*

## State, three kinds (recap)

- **Working / conversation state** — the current task's context. Lives **here (L1)**, short-lived.
- **Execution-session state** — sandbox fs/vars. Lives in the **Sandbox** primitive, ephemeral.
- **Durable / shared memory** — the **State** primitive (deferred). See [primitives.md](primitives.md).

## Agent lifecycle

define → package (container) → deploy (k8s) → version → invoke → observe → retire.
Versioning + rollback are platform responsibilities.

## Multi-agent (deferred)

Agents may invoke other agents (supervisor → sub-agents; agent-to-agent / A2A).
Implications: identity **delegation** (agent acting as agent), **nested `run_id`s**
for tracing, and cost attribution across the call tree. Deferred — noted so the
contract leaves room for it.

## Backing options

- **Custom loop** — full control; likely for the POC.
- **Framework** — Strands (AWS, integrates with AgentCore), LangGraph, etc.
- **AgentCore Runtime** — host the agent itself in a session-isolated microVM.

Kept behind an invocation/runtime port so this stays swappable ([ADR-0003](decisions/0003-ports-and-adapters.md)).

## References

[primitives.md](primitives.md) · [architecture.md](architecture.md) ·
ADR-0006 (AgentCore split) · [ADR-0008](decisions/0008-guard-content-safety-primitive.md) (guard)
