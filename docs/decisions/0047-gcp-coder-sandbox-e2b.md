# ADR-0047: The GCP coder sandbox — E2B custom template (session-native Model B)

- **Status:** Proposed
- **Date:** 2026-07-26

## Context

[0044](0044-gcp-agent-runtime-profile.md) stood up the GCP profile and [0046](0046-coder-loop.md)
taught the loop to code, but the coder loop's **`do` surface on GCP is still
`SANDBOX_PROVIDER=local`** — model-generated code runs *inside the managed Runtime
session*, as the loop's own root identity, open egress, metadata-readable SA token. That is
[0020](0020-sandbox-execution-model.md)'s Model B with **none** of
[0022](0022-sandbox-backends-for-coding-agents.md)'s load-bearing egress lockdown: untrusted
code co-located with the loop's credentials. Fine for the phase-1 spike (the demo task calls
no tools); wrong the moment a coder run executes anything.

**Why not the obvious managed box.** Vertex Agent Engine Code Execution is a **Model A** box
(Python/JS interpreter, genuinely isolated — *no network, no metadata service*, no toolchain).
Clean for run-this-snippet, but it cannot compile or test Go/Java: no runtimes, and no-egress
means you can't install them. A coding agent on Model A is a **blind editor** — it edits
source but never sees a compiler error or a failing test, and the build/test feedback loop
*is* the coding agent's competence. So Model A is disqualified for `kind: "coder"`. (AWS
AgentCore Code Interpreter is the same Model-A class — this is the interpreter category, not a
GCP weakness.)

**The pivotal finding — the port is clean because our backends are session-native.** Both real
adapters get a durable, addressable session *for free from the substrate*:
`agentcore-sandbox.ts` calls `StartCodeInterpreterSession` → a `sessionId` that AWS routes to
the right Firecracker microVM server-side; `e2b-sandbox.ts` calls `Sandbox.create()` → a
`sandboxId` the SDK addresses directly. In both, `SandboxSession.id` *is* the service's
session handle and the provider just holds it — **the substrate owns persistence and routing.**
That is why the port has no notion of pinning, affinity, or reap-recovery: it never needed one.

This reframes the GCP choice. A GCP-native, scale-to-zero box (Cloud Run) is a *request
autoscaler*, not a session service — so making it fit the port means **re-implementing,
best-effort, the session semantics AgentCore and E2B provide natively** (instance pinning +
affinity + loud-fail on reap; see Alternatives). There is **no GCP-managed session-native
Model-B sandbox** to lean on. For a POC, inventing session machinery to stay GCP-native loses
to reusing the proven session-native adapter we already ship.

## Decision

**Run the GCP coder loop's `do` on E2B via a custom coder template** —
`SANDBOX_PROVIDER=e2b`, `E2B_TEMPLATE=agent-os-coder`. This reuses the session-native pattern
whole; no session machinery is invented.

**No adapter code.** `config.ts` already wires `case "e2b" → E2BSandboxProvider({ apiKey, template })`.
The build is three parts:

1. **The template — the genuinely new artifact.** An E2B **v2 SDK** template (`template.ts` +
   `build.ts`; E2B deprecated the v1 Dockerfile build mid-2026 and it now no-ops):
   Go, JDK + Gradle, Node, Python (from the base image), git baked in. Based on
   `e2bdev/code-interpreter` so the box keeps both surfaces the adapter drives — `runCode`
   (Jupyter kernel) and `commands.run`. Because E2B's `commands.run` is **real bash** (not a
   Python `subprocess` shim), `runCmd` is first-class — `go test` / `gradle test` / `npm test`
   run for real, and the agent reads real failures. The coder toolset ([0046]) and workspace
   lifecycle (`writeFile` clone-in, `listFiles`/`readFile` finalize) already map onto E2B
   natively — field-verify against the installed `@e2b/code-interpreter` on first live run
   (the adapter's own `defaultCreate` caveat).

2. **The credential — the one keyless-stance exception, bounded.** E2B auth is an **API key**
   (a scoped, revocable, E2B-side secret), which cuts against [prefer-keyless-auth]. Accepted
   plainly the way [0041] accepted secret-but-scoped M2M clients: store it in **GCP Secret
   Manager**, never in git, and have the loop's SA read it at runtime (keyless *to GCP* — the
   SA fetches; the key lives outside the Agent Engine config, not baked into the deployed
   resource where any `aiplatform` reader would see it). `SANDBOX_PROVIDER`/`E2B_TEMPLATE` stay
   plain env in `deploy.py`; only `E2B_API_KEY` is the secret leg.

3. **The flip.** `deploy.py:73` `SANDBOX_PROVIDER: "local"` → `"e2b"`, add `E2B_TEMPLATE` and
   the `E2B_API_KEY` secret wiring, in the shared `ENV_VARS` both deploys reuse.

**Containment ([0022]) — E2B's firewall is the load-bearing control.** Egress lockdown, not
`guard`, is the safety boundary for a Model-B coder. Day one = default-allow egress (compiled
builds need package registries), with E2B's per-sandbox firewall allowlist (gateway + registries
+ github.com) named as the hardening graduation. The GitHub installation token stays
executor-side ([0046]) and never enters the box; E2B holds no model creds (inference is still
the gateway, [0019]).

## Consequences

- **+** Fastest path to **iterate-in-box** coding on GCP: `go test` / `gradle test` with a real
  compiler in the loop — and `runCmd` as first-class bash, exercised the same on every backend.
- **+** **Zero session machinery invented** — reuses the session-native pattern AgentCore/E2B
  already prove, so the correctness edge Cloud Run would have introduced (best-effort pinning,
  reap-mid-run) simply doesn't exist.
- **+** The `do` surface becomes backend-identical across all three managed profiles (AWS
  AgentCore, GCP, and — with a template — E2B everywhere), sharpening the [0046] comparison.
- **−** **Cross-cloud data path:** the `do` runs on E2B's infra, not our GCP project — an
  explicit residency/trust asterisk. Model-generated code and the materialized repo transit a
  third party. Bounded by: no model creds in the box, no GitHub token in the box, firewall
  egress.
- **−** **API key vs keyless** ([prefer-keyless-auth]): accepted as scoped + revocable +
  Secret-Manager-held, not platform-stored. The keyless graduation for a caller with GCP
  identity is a GCP-native session substrate (next point).
- **−** Does **not** advance the GCP-native resource-model learning goal as much as a
  first-party box would — a deliberate POC trade (velocity + a proven pattern over nativeness).
- **The GCP-native graduation, named not built:** a **GKE pod-per-session** sandbox (gVisor) is
  the session-native *and* GCP-native answer — a pod *is* a durable, addressable session, so it
  inherits the clean port with no pinning hack — at the cost of cluster idle spend the POC brief
  rules out today. That is the path if cross-cloud or the API key ever becomes unacceptable.

## Alternatives considered

- **Cloud Run + a per-session exec-agent** (a toolchain image running a small HTTP server,
  driven over authenticated internal-ingress calls). GCP-native, keyless, scale-to-zero (~$0
  idle) — attractive on the constraints. Rejected for the POC because Cloud Run is a *request
  autoscaler, not a session service* (App Runner / Lambda-shaped, per the [0044] Cloud Run
  lane): a stateful workspace spanning many calls has to be faked with `concurrency=1` +
  session affinity + **loud-fail on instance reap** (unknown-session → 409 → fail the run).
  That is real invented complexity and a genuine correctness edge, to re-create semantics E2B
  gives natively. Revisit if GCP-nativeness becomes the objective (then compare against the GKE
  graduation, which is session-native without the hack).
- **Vertex Agent Engine Code Execution** — Model A, session-native, and the clean port fit *is*
  why it was tempting; stays the documented **run-this-snippet** default. Disqualified for the
  coder loop only (blind editor for compiled languages).
- **Self-hosted GKE/gVisor pod-per-session** — the GCP-native, session-native ideal; deferred
  purely on cost-sensitive-POC idle spend. Named as the graduation above.

## Relationship

Instantiates [0022](0022-sandbox-backends-for-coding-agents.md)'s Model B on the GCP profile;
provides the `do` surface for [0046](0046-coder-loop.md) under
[0044](0044-gcp-agent-runtime-profile.md); realizes [0020](0020-sandbox-execution-model.md) and
selects a backend per [0042](0042-agentcore-managed-profile.md)'s per-run dispatch; reuses the
E2B Model-B adapter introduced in [0020](0020-sandbox-execution-model.md) and the
secret-but-scoped credential stance of [0041](0041-machine-identity-cognito-m2m.md). Vertex Code Execution stays the **Model A**
default; a GKE pod-per-session sandbox is the named GCP-native graduation.
