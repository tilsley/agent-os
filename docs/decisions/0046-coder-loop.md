# ADR-0046: The coder loop — coding as a trade of the loop-executor, not a new lane

- **Status:** Accepted (amended 2026-07-26 — see Amendment below: the workspace
  lifecycle went executor-side and the credential step down never happened)
- **Date:** 2026-07-19

## Context

Today only the foreign-L1 lane codes: `kind: "claude-code"` runs ride a Fargate task (or
Cloud Run on GCP) with the egress sidecar ([0033](0033-claude-code-hosted-runner.md)/
[0034](0034-egress-sidecar-credential-injection.md)), and that lane is welded to those
substrates — the AgentCore microVM can't host it (2 vCPU/8 GB, no sidecar seat, one image
per Runtime — [0042](0042-agentcore-managed-profile.md)). Meanwhile [0042] just made the
substrate a per-run choice (`dispatch` stamped at admission, console selector), and
[0045](0045-agent-workspace-separation-three-rings.md) established that "coding agent" is a
property of ring 2 (the loop/harness) + ring 3 (the workspace) — neither of which is
substrate-bound in our architecture. The gap is plain: our OWN harness (`loop.ts`) doesn't
know the coding trade, so the substrate freedom we just built applies to everything except
the workload the user most wants (coding).

[0022](0022-sandbox-backends-for-coding-agents.md) already named the sandbox side of this;
[0037](0037-hosted-claude-code-landscape.md) already named the credential upgrade (GitHub
App per-run tokens). This ADR composes them.

## Decision

Teach the loop-executor the coding trade. In [0036](0036-foreign-l1-boundary-governance.md)'s
taxonomy this is NOT a fourth execution model — it is the loop-executor specialized, the
same harness engine with a new composition around it. Three layers:

**1. A `coder` agent kind — a registry entry, not a service.** `AgentSpec.kind: "coder"`
(beside `loop`/`sandboxed`/`claude-code`, [0038](0038-agent-onboarding-behind-the-gate.md)):
kind `loop`'s wiring plus the workspace lifecycle below. The console's repo field (today
keyed on `kind === "claude-code"`) applies to `coder` too — `Run.repo` stays the
caller-chosen, gate-authorized resource ([0034]'s attribute authz, unchanged).

**2. A coding toolset — curation, not invention.** The sandbox session already exposes
`readFile`/`writeFile`/`runCmd`/`listFiles` behind the `SandboxProvider` port; the coder
toolset curates those (plus search/diff conveniences as needed) and a prompt tuned for
edit–build–test discipline. No new ports.

**3. The workspace lifecycle — the genuinely new part.** A wrapper around the loop,
structurally the claude-code shim re-homed onto our own L1 and its sandbox session:
- after session claim: `git clone` `Run.repo` into the workspace (requires the session's
  PUBLIC/VPC egress mode and git in the sandbox image — [0022]'s note, verify per backend);
- the loop runs with cwd = the checkout;
- at terminal status (any, in a `finally` — crash included, same stance as the [0034]
  shim): commit whatever changed and push `refs/heads/run/<id>`. Never a default-branch
  write.

**Credentials — the one real design decision.** There is no sidecar seat inside a sandbox
session, so [0034]'s "secret never enters the agent" cannot hold verbatim. Phase 1 accepts
a *bounded* step down: the control plane mints a **per-run GitHub App installation token**
(fine-grained: contents+PR on the single gate-authorized repo, ~1 h expiry — the [0037]
upgrade) at dispatch and passes it into the workspace for the clone/push legs. Bounds:
one repo, short-lived, revocable, and the token's permissions replace the sidecar's
pkt-line push policy — so default-branch protection on the org side becomes load-bearing
and MUST be on. The graduation, if policy parity with [0034] ever matters, is a
**git-proxy service** (the sidecar pattern as a shared choke point the workspace pushes
through, run-token-authenticated); named here, not built.

**Governance — better than the lane we have.** Unlike foreign-L1 (boundary-only, run-quota
lane — [0036]), the coder loop is OUR L1: every think is metered through the gate on the
dollar lane, guard and telemetry see every turn, and budget enforcement is per-turn, not
admission-only. Coding stops being the least-governed workload on the platform and becomes
the most.

## Consequences

- Coding becomes substrate-orthogonal in one move: the same `coder` agent runs on Fargate,
  the AgentCore microVM, and Vertex Agent Runtime purely by the [0042] selector. First
  proof = one run per substrate through the console.
- The claude-code lane stays exactly as is — it remains the "full Claude Code experience"
  option; the coder loop is the governed, portable sibling, and honest comparison between
  them (quality vs governance vs cost) becomes possible for the first time.
- MicroVM coding inherits the field-tested bounds ([0042]): fine for script-scale changes
  on interpreted stacks; heavy builds pick Fargate in the selector. The per-run choice is
  the mitigation, not a promise the microVM can do everything.
- `AgentSpec.kind` gains a value; registry validation, console `isCodingAgent`, and the
  A2A surface need the small corresponding updates.
- Out of scope here: PR auto-opening, warm workspace caches (the [0045] sandbox-manager
  lifecycle backlog), and multi-repo runs.

## Amendment (2026-07-26): executor-side git — the step down never happened

Implementing the workspace lifecycle (commits 6545651…566b92f) falsified one premise and
strengthened the decision. Recorded here because the field findings are the value.

**The premise that broke.** The lifecycle assumed `git clone` *inside* the workspace
(§3's "requires the session's PUBLIC/VPC egress mode and git in the sandbox image").
Probed on the AgentCore Code Interpreter: **no git, and no network egress at all**
(api.github.com and pypi unreachable — no way to even install a pure-Python git). The
first prod proof runs failed cleanly on `git: command not found`. And the zero-egress
workspace is a security property worth keeping, not a gap to engineer around.

**The pivot.** The git legs moved to the EXECUTOR — ring 2 in [0045]'s model, the trusted
process that already holds the run's credentials (Fargate task / microVM entrypoint /
Vertex container, all with egress) — speaking GitHub's Trees + Git Data APIs directly:
materialize = tree → blobs → `session.writeFile`; push = changed blobs → tree (with
`base_tree`) → commit → `refs/heads/run/<id>`. Repo bytes cross the trust boundary only
through the `SandboxProvider` file surface; change detection recomputes git blob ids
executor-side, so nothing else is needed from the sandbox.

**The credential consequence — the headline.** The Decision priced in a *bounded step
down* from [0034]: the token would enter the workspace for the clone/push legs. That
price was never paid. **The installation token now never enters the workspace on any
substrate** — "the secret never enters the agent" holds verbatim, and the token cannot
leak via the artifact under the agent's control. The git-proxy graduation is largely
mooted: the executor IS the choke point (it only ever creates `run/<id>` refs — the
branch-namespace policy is code, not org configuration; default-branch protection drops
to defense in depth against a compromised executor rather than the sole guard).

**Substrate lessons banked while proving it** (each one commit, each found by a failing
proof run — details in the commit messages):

- The Code Interpreter's command channel is PTY-like: raw `cat` returns LF→CRLF with the
  trailing newline trimmed (every cloned file "changed"), and its filesystem ships the
  interpreter's own home files (`.ipython/…`). Reads go via base64; clone snapshots the
  preexisting files and finalize excludes them; finalize computes blob shas in ONE
  in-session shell pass instead of N API reads; a mass-deletion guard refuses to push a
  half-vanished baseline (a broken file surface, not agent intent).
- **AgentCore Runtime freezes the microVM the moment the invocation response is sent —
  `/ping HealthyBusy` does not hold it live.** The fire-and-forget 202 ([0042]'s
  async-job reading, now corrected) left runs frozen mid-push; one thawed and flushed a
  perfectly clean commit only when its session was explicitly stopped. The agentcore
  entrypoint now processes the run INSIDE the invocation (an in-flight invocation is the
  liveness guarantee); the dispatcher treats a dropped long-lived response as benign
  unless the run was never claimed.
- A throwing tool no longer kills the run — errors return to the model as tool results
  (a `read_file("/README.md")` guess used to be fatal), and adapters collapse
  absolute-looking paths into the workspace.

**Proof** (the Consequences' "one run per substrate"): `run/9615fa2a…` (Fargate) and
`run/7df7e008…` (AgentCore microVM) on tilsley/chart-val, each containing exactly the one
intended file. The Vertex leg needs only the key seam (GCP Secret Manager →
`GITHUB_APP_PRIVATE_KEY`; the code already reads the env var) and a real Model-B sandbox
— [0047](0047-gcp-coder-sandbox-e2b.md)'s subject.

**POC bounds** (logged, not silent): text files only, ≤200 files, ≤400 KB/file; big-repo
support stays on the [0045] sandbox-manager backlog.
