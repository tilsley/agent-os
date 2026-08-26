# doc-gardener

The platform's first **OpenCode-engine** agent: it finds documentation drift (code says
one thing, README says another) and fixes the docs — through the governed gateway, with
its blast radius bounded by a write allowlist.

```
inventory + deterministic detectors        discovery is mechanical — no LLM needed
        ↓
ONE OpenCode session                       judgement: read the code, fix the docs
  think → inference-gateway → Bedrock      identity + budget enforced per request
  do    → read/glob/edit only              bash, webfetch, subagents denied
        ↓
docs-only write allowlist                  whatever happened in the session,
        ↓                                  only *.md / docs/ edits survive
report (+ diff)
```

**Buy the engine, build the governance** — the same split as the LiteLLM pivot
(ADR-0024/0025), one layer up. OpenCode owns the agent loop, file tools, and prompt
plumbing; the platform owns identity (SA token or mesh), budget (worst-case admission +
settle at the gateway), tool denial, and the write allowlist.

## Run it

```bash
bash apps/doc-gardener/run.sh        # local: dev gateway + the drifted fixture
bun test                             # detectors + allowlist unit tests (pure)
```

In-cluster (k3s, gateway deployed — see `deploy/helm/inference-gateway`):

```bash
docker build -t doc-gardener:dev apps/doc-gardener
# grant the SA a claim (CLAIMS_STATIC or the DynamoDB claims table), then:
kubectl -n agentos-gw apply -f apps/doc-gardener/k8s-job.yaml
kubectl -n agentos-gw logs -f job/doc-gardener -c agent
```

The Job works in both authn modes: cheap mode forwards its projected SA token; full
(mesh) mode the token is ignored and Linkerd's `l5d-client-id` carries the identity.

## Pointing it at a real repo

The demo gardens a baked-in fixture (`FIXTURE_DIR=/fixture`). For a real repo set
`TARGET_REPO_URL` (it clones shallow) or `WORKSPACE` (an existing checkout) — and for a
sandboxed pod, open the egress door for the git host. Committing/PR-ing the result is the
next step, not built yet: today it prints the diff and exits.

## Env

| var | default | meaning |
|---|---|---|
| `INFERENCE_GATEWAY_URL` | `http://localhost:4000` | the LiteLLM gateway |
| `MODEL_ID` | `claude-haiku` | must match the tenant claim's model |
| `AGENT_TOKEN` / `AGENT_TOKEN_FILE` | — | identity (cheap mode); omit under the mesh |
| `TARGET_REPO_URL` / `WORKSPACE` / `FIXTURE_DIR` | — | what to garden (first match wins) |
| `SHOW_DIFF` | on | `0` to suppress the diff in the report |

## Gateway lessons this agent forced (fixed in services/inference-gateway/litellm)

- **Streaming budget settle** — OpenCode streams; LiteLLM never fires
  `async_post_call_success_hook` for streams, so every streamed call was billed at the
  full worst-case reserve. Settle now happens via a pop-once reservation stash keyed by
  `litellm_call_id` (`admission_hook.py`) — metadata threading does NOT survive the
  /v1/messages streaming logging path.
- **Wire-compat scrub** — OpenCode ≥1.16 sends `eager_input_streaming` in tool defs
  (an Anthropic API beta); Bedrock 400s it and OpenCode surfaces that as a silent stop
  ("the hang"). `compat_hook.py` strips it at the choke point for every client.
- **The Anthropic wire** (`/v1/messages` via `@ai-sdk/anthropic`) is the right wire for
  Claude behind LiteLLM: native tool_use deltas, `max_tokens` always present (the
  admission invariant), prompt caching that actually engages.
