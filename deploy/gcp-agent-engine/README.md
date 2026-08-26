# GCP Agent Runtime deploy — the fourth profile (phase 1)

The GCP sibling of the AWS AgentCore managed profile ([ADR-0042](../../docs/decisions/0042-agentcore-managed-profile.md)).
Hosts the L1 loop on **Vertex Agent Runtime** (Gemini Enterprise Agent Platform) instead of
Fargate/EKS/AgentCore — same contract, same invariant shell, selected by env bundle
([ADR-0027](../../docs/decisions/0027-two-deployment-profiles.md)). Resource-model map:
[`docs/agent-engine-service-comparison.md`](../../docs/agent-engine-service-comparison.md).

## Layout

| Piece | Where |
|---|---|
| Plumbing (Artifact Registry, loop SA, IAM) | `infra-gcp/` (Pulumi, GCS-backed state) |
| Container entrypoint (in-runtime executor) | `services/agent-runtime/agent-engine.ts` |
| Front-door dispatch branch | `services/agent-runtime/dispatch.ts` → `DISPATCH=agentengine` |
| Image build (amd64, → Artifact Registry) | `cloudbuild.yaml` |
| Deploy + smoke | `deploy.py` (uv) |

## Prereqs (one-time, already done 2026-07-14)

- Project `decent-decker-270921` (creance), billing on, region `europe-west2` (mirrors AWS eu-west-2).
- APIs: aiplatform, artifactregistry, cloudbuild, secretmanager, run, iam.
- `cd deploy/gcp && PULUMI_CONFIG_PASSPHRASE="" pulumi up` → Artifact Registry repo + `agent-runtime` SA.

## Deploy

```bash
# 1. build + push the image (linux/amd64, native on Cloud Build)
gcloud builds submit --config deploy/gcp-agent-engine/cloudbuild.yaml \
  --project=decent-decker-270921 .

# 2. create the managed runtime from that image (overrides command → agent-engine.ts)
uv run deploy/gcp-agent-engine/deploy.py deploy

# 3. smoke the invoke path — probe mode needs no model creds
uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --probe
```

## The empirical-contract note

The exact in-container HTTP contract for Agent Runtime BYOC (the route Agent Runtime POSTs
to, the request/response JSON, the port env) is under-documented. `agent-engine.ts` therefore:

- listens on `AIP_HTTP_PORT` (default 8080) on `0.0.0.0`,
- answers health on `AIP_HEALTH_ROUTE` (+ `/`, `/ping`),
- **logs every invocation** (`agent-engine invoke: <method> <path> body=…`),
- defaults to **probe mode** (returns a runtime envelope, no model call) when the input has no `task`.

So the first live deploy is self-verifying: read the runtime logs to learn the true route/body,
then tighten `agent-engine.ts` and `CONTAINER_SPEC` in `deploy.py`. This closes open-question #1
in the service-comparison ledger.

## Status (2026-07-14) — ✅ LIVE INVOKE PROVEN (phase 1 done)

`POST …/reasoningEngines/{id}:query` with `{"input":{"probe":true}}` → **HTTP 200** with our
`{"output": <envelope>}`. The loop container runs on Agent Runtime and the invoke path,
authorizer, and envelope are proven end-to-end.

**The full deploy + runtime contract, learned empirically:**

- **Deploy schema** — `container_spec` takes **only `image_uri`** (no command/env); there is **no
  command-override field**, so the container's own CMD must launch the entrypoint → the Dockerfile
  CMD is an `AGENT_ENTRYPOINT` env-indirection, set via `env_vars`. `env_vars`/`service_account`/
  `min_instances`/`max_instances` are top-level on `AgentEngineConfig`.
- **code-13 (INTERNAL) at deploy** = the **Reasoning Engine service agent**
  (`service-<PN>@gcp-sa-aiplatform-re…`) had **no Artifact Registry read** — its role carries zero
  `artifactregistry` perms, so the image pull failed *before* the container ran (hence no container
  logs). Fixed in Pulumi: repo-scoped `artifactregistry.reader` for that agent (`deploy/gcp/index.ts`).
- **Runtime request contract** — Agent Runtime POSTs the `:query` body to **`POST /api/reasoning_engine`**
  as `{"input": {...}}`, on port **`AIP_HTTP_PORT`=8080** (confirmed injected).
- **Runtime response contract** — the `:query` REST response schema is `{"output": <value>}` and the
  platform **relays the container's body verbatim**, so the container must itself return
  `{"output": …}`. A bare object → platform wrapper **500**. Fixed in `agent-engine.ts` (`queryResponse`).
- **Invoking a custom/BYOC engine** — `class_methods=None`, so the SDK has **no `.query()` helper**;
  call the `:query` REST method directly (see `deploy.py query`).

Closes ledger open-question #1.

## Phase 2 (2026-07-14) — ✅ REAL TASK RUNS END-TO-END

A real `:query` task now runs the full loop on Agent Runtime with **Gemini on Vertex**:

```
{"input":{"task":"…"}} → {"output":{"status":"completed","output":"…","usage":{…},"costUsd":…}}
```

- **Inference** — new `VertexGeminiInferenceProvider` (`packages/core/src/adapters/vertex-gemini-inference.ts`),
  `INFERENCE_PROVIDER=vertex`, model `gemini-2.5-flash`, europe-west2. Dependency-free REST +
  ADC token (runtime service account), thinking disabled so `maxTokens` bounds visible output
  (ADR-0013). Translates neutral messages/tools ↔ Gemini `generateContent` (incl. tool-call
  round-trips; results keyed to calls by function name).
- **Sandbox** — `SANDBOX_PROVIDER=local` (the default `agentcore` sandbox needs AWS creds,
  unavailable on GCP; the demo task calls no tools). A GCP sandbox adapter is a later phase.
- **Gotchas closed:** `GOOGLE_CLOUD_PROJECT` is a *reserved* env var (platform-injected — don't
  set it); the loop's terminal RunStatus is `completed` (not `succeeded`) — fixed `awaitRun`.

**NEXT (phase 3+):** front-door `DISPATCH=agentengine` path (set `GCP_PROJECT`/`AGENT_ENGINE_ID`);
per-tenant gate/identity (map GCP IAM caller → tenant, replace open authn); managed Sessions /
Memory Bank adapter so runs show in the Agent Engine console; a GCP sandbox (Code Execution / BYOC).
