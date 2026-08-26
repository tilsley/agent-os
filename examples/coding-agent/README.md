# coding-agent — the platform's first use case, end to end

A real multi-turn **coding agent**: it writes code, **runs it in the sandbox**, reads the
output, and reports — with every `think` governed by the gateway (verified identity + budget)
and every `do` confined to the sandbox. The spine, plus `workspaceTools`.

```
runAgent ─┬─ think → OpenAI-wire gateway (identity + budget) → Bedrock
          └─ do    → write_file / run_cmd / run_code  in the sandbox
```

```bash
make coding-agent                                  # default task (sum of squares)
bash examples/coding-agent/run.sh "your coding task"
```

Validated live (Claude Haiku): the agent wrote `solve.py`, ran it, hit
`python: command not found`, **self-corrected to `python3`**, got `385`, and reported it —
`status=completed`, 4 governed `think`s, code executed in the sandbox. The agent code carries
**no auth and no model creds**: identity is forwarded by the platform adapter, verified at the
gateway; the model call leaves via the gateway; untrusted code runs in the sandbox.

## In k3s — Model A behind the egress wall (`k8s-pod.yaml`)

The same agent, **as a pod in a locked-down namespace** — the platform's security story proven end
to end. `deploy/local/sandbox-coding-agent.sh` (= `make coding-agent-pod`) deploys the agent into a
namespace walled by [`deploy/helm/sandbox`](../../deploy/helm/sandbox) (default-deny egress) with **one door
open**: a cross-namespace route to the in-cluster gateway. The pod plays Model A's dual role — the
trusted loop *and* the untrusted code — so a single task proves both halves:

```
think → gateway door → Bedrock            ✅ governed (verified SA-token identity + budget)
do    → python GET https://example.com    ❌ NET_BLOCKED (the wall refuses it)
```

Validated live (Claude Haiku): the agent wrote `solve.py`, self-corrected a wrong-cwd error, printed
`385`, and its own HTTPS GET came back `NET_BLOCKED <urlopen error [Errno 111] Connection refused>` —
`status=completed`. Identity is a projected ServiceAccount token (audience `agent-os-gateway`) the
gateway verifies against the cluster JWKS; the pod (`coding-agent:dev` = Bun + python3) carries no
auth and no model creds. This is the convergence of the three pieces: the agent, the egress lockdown,
and the gateway. See [ADR-0020](../../docs/decisions/0020-sandbox-execution-model.md#validation-2026-06-09--the-egress-non-negotiable-proven-live).

**Notes.** The host run above uses `SANDBOX_PROVIDER=local` (host `python3`). The k3s pod packages
`python3` in its own image; a real `SandboxProvider` (AgentCore/E2B/self-hosted gVisor — ADR-0022)
is the adapter swap for stronger runtime isolation than a shared pod.
