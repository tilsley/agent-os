# LiteLLM inference gateway — the bought engine + our authn & budget hard-stop

> **Superseded by [ADR-0028](../../../docs/decisions/0028-own-the-gateway-engine.md) (executed 2026-06-13).**
> This is no longer on any serving path — the Bun gateway (`deploy/helm/inference-gateway`,
> `services/inference-gateway/server.ts`) is the single engine in both profiles. This directory is
> kept for two reasons only: it is the second gateway in `deploy/local/gate-conformance.sh` (the
> parity reference that proves the Bun gate didn't drift), and it is the documented record of the
> hook-seam findings that motivated 0028 (see "Validation caveats" below). Do not deploy it.

**Milestones 1–4 of the LiteLLM pivot (ADR-0024/0025/0026).** Proves the bet: *buy the
engine (LiteLLM → Bedrock), build the policy* — verified-identity authn + a worst-case
budget hard-stop, both in LiteLLM's **OSS hooks** (its native JWT auth is enterprise-only).
Validated live against Bedrock (Claude Haiku 4.5): reserve → call → settle-to-actual, and
our own runtime drives it through the `InferenceProvider` port (M4).

LiteLLM owns wire formats, model routing, and the Bedrock call. We own the ~10% nobody else
does:
- **M1 — `admission_hook.py`:** price each request's worst case (`input + max_tokens` of
  output) **pre-flight** and refuse (`402`) if it won't fit the cap, reserving against the
  **DynamoDB spend table** (`agent-os-budgets`) the TS runtime uses.
- **M2 — `auth_hook.py`:** verify the caller's token *ourselves* (`custom_auth`), derive a
  **non-forgeable** tenant, look up its claim (grant + budget + model), return
  `UserAPIKeyAuth`. The admission hook then reads the **verified** tenant + cap from that —
  the body's `user` field is ignored.

| File | What it is |
|---|---|
| `auth_hook.py` | M2 — `custom_auth`: offline JWT verify (RS256/JWKS prod, HS256 dev) → tenant; TTL-cached claim lookup (Dynamo or static); `401` bad/no token, `403` no claim. |
| `admission_hook.py` | M1 — `AdmissionInferenceProvider` port: `async_pre_call_hook` (price → reserve → 402), `async_post_call_success_hook` (settle), `async_post_call_failure_hook` (refund). Reads the verified tenant/cap from `user_api_key_dict`. |
| `config.yaml` | LiteLLM proxy — Bedrock Claude Haiku (keyless), loads `custom_auth` + the admission callback. |
| `pyproject.toml` | `litellm[proxy]` + `boto3` + `pyjwt`, managed by [uv](https://docs.astral.sh/uv/). |

## Auth (M2) env

| Env | Purpose |
|---|---|
| `JWT_JWKS_URL` | prod: verify RS256/ES256 against this JWKS (the cluster's OIDC keys) |
| `JWT_HS256_SECRET` | dev/test: verify HS256 with a shared secret (no network) |
| `JWT_TENANT_CLAIM` | which claim is the tenant (default `sub`) |
| `MESH_IDENTITY_HEADER` | **full-mode authn**: trust a service-mesh-forwarded identity header (e.g. `l5d-client-id` for Linkerd) → tenant, *instead* of verifying a token. The agent then carries no credential at all (mTLS authenticates it). See [`deploy/local/linkerd.md`](../../../deploy/local/linkerd.md). |
| `JWT_AUDIENCE` | if set, the token's `aud` must match |
| `CLAIMS_STATIC` | dev/test claim map, e.g. `{"bob":{"model":"claude-haiku","monthlyBudgetUsd":50}}` |
| `CLAIMS_TABLE` / `CLAIMS_TABLE_ENDPOINT` | prod: DynamoDB claims table (default `agent-os-claims`) |
| `CLAIM_CACHE_TTL` | grant-cache TTL seconds (default 5) — keeps the lookup off the hot path |

## Budget store env (ADR-0023/0026/0027)

| Env | Purpose |
|---|---|
| `SPEND_STORE` | `dynamo` (default — cheap mode, ~$0 idle) or `postgres` (full mode) |
| `SPEND_DATABASE_URL` | Postgres connection (password auth) for `SPEND_STORE=postgres`. **Not `DATABASE_URL`** — LiteLLM claims that for its own Prisma DB and mutates it (appends `connection_limit`, which psycopg rejects). |
| `SPEND_DB_IAM=true` | **keyless** Aurora IAM auth instead of a URL/password: mint a fresh 15-min RDS token per connection. Needs `SPEND_DB_HOST` (+ optional `SPEND_DB_USER=agentos_app` / `SPEND_DB_NAME=agentos`); the caller's IAM identity needs `rds-db:connect` (laptop: admin; EKS: pod role via IRSA). |
| `SPEND_TABLE` / `SPEND_TABLE_ENDPOINT` | the DynamoDB table (dynamo mode) |

Postgres reserve = one conditional upsert (`spent+delta ≤ ceiling … RETURNING`) — atomic **and**
ACID-durable in a single statement. Prod target: **Aurora Serverless v2** (PostgreSQL engine,
scale-to-zero ⇒ ~$0 idle; IAM-auth token refresh is a documented follow-up). Dev:

```bash
docker run -d --name agentos-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16-alpine
export SPEND_STORE=postgres SPEND_DATABASE_URL='postgresql://postgres:test@localhost:5432/postgres'
```

## Run it locally

> Not run in this repo's CI — it needs a Python env, live AWS creds, and Bedrock access.
> This is the recipe to validate it yourself.

**Prereqs**
- Python 3.11+
- AWS creds with Bedrock + DynamoDB access. Per the project convention, pass the profile
  explicitly (creds are short-lived, ~1h): `export AWS_PROFILE=nathan-tilsley-developer`
- Bedrock Claude Haiku enabled on the account (Marketplace subscription **and** an IAM
  invoke grant — both required) — or point at DynamoDB Local + skip the real model call.
- The `agent-os-budgets` table (the StateStack budgets table), **or** DynamoDB Local with
  a table `agent-os-budgets` (PK `tenant` S, SK `period` S).

```bash
cd services/inference-gateway/litellm
uv sync                                          # .venv + deps from uv.lock

export AWS_PROFILE=nathan-tilsley-developer      # short-lived; refresh on ExpiredToken
export REGION=eu-west-2
export SPEND_TABLE=agent-os-budgets
# export SPEND_TABLE_ENDPOINT=http://localhost:8000   # only for DynamoDB Local
# --- auth is mandatory (M2): the proxy verifies a token + looks up a claim ---
export JWT_HS256_SECRET=testsecret               # dev verifier (prod: JWT_JWKS_URL)
export CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}'  # dev claim
# export SESSION_BUDGET_USD=0.0005               # optional per-session runaway cap

uv run litellm --config config.yaml --port 4000
```

Every request now needs a Bearer token (M2). Mint a dev one:

```bash
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
```

## See it work (402 hard-stop, then a live call that settles)

**402 before Bedrock** — set the claim budget tiny (`monthlyBudgetUsd: 0.0001`, restart):

```bash
curl -s localhost:4000/v1/chat/completions -H "Authorization: Bearer $BOB" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200,"user":"acme"}'
# → 402  budget exceeded for tenant 'bob'   (the body's user=acme is ignored — verified identity wins)
```

**A live completion** (budget `$5`) returns a real answer and settles to actual cost:

```bash
curl -s localhost:4000/v1/chat/completions -H "Authorization: Bearer $BOB" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","messages":[{"role":"user","content":"Reply with one word: ok"}],"max_tokens":500}'
# → 200  ...{"content":"ok"}...      (omit max_tokens → 400)
```

Watch the counter settle to **actual**, not the worst-case reserve:

```bash
aws dynamodb get-item --table-name agent-os-budgets \
  --key '{"tenant":{"S":"bob"},"period":{"S":"2026-06"}}' --query 'Item.spentUsd.N' --output text
```

## Where the tenant comes from

**M2 makes it verified.** `auth_hook.py` verifies the caller's token and sets the tenant
from the signed claim (`sub`); the body's `user` is ignored. A caller cannot spend against
another tenant by asserting one. The grant (budget + model) comes from the tenant's claim,
TTL-cached. (The verifier is offline JWT today — RS256/JWKS in prod, HS256 in dev; an
IAM-SigV4 verifier for non-k8s callers is the documented second adapter.)

## Point the runtime at it (M4)

Our own TS runtime calls LiteLLM through the `InferenceProvider` port via the new
**`OpenAIGatewayInferenceProvider`** (`packages/core/src/adapters/`), which translates our
neutral types ↔ OpenAI `/v1/chat/completions` and maps 401/402 to the same errors as the
in-process path. Selected by env, **alongside** the bespoke Bun-gateway client (not instead
of it — cheap-mode/fallback stays):

```bash
export INFERENCE_GATEWAY_URL=http://localhost:4000
export INFERENCE_GATEWAY_WIRE=openai     # default "bespoke" = the Bun /v1/generate gateway
export MODEL_ID=claude-haiku             # the alias LiteLLM routes (and the claim allows)
```

## In k8s — gateway as a pod, real SA-token identity (validated)

`Dockerfile` (uv-based image) + the `deploy/helm/litellm-gateway` chart **(both removed by ADR-0028)** ran
this gateway as a pod in k3s, verifying **real Kubernetes ServiceAccount tokens** against the cluster
JWKS (`JWT_JWKS_URL`, default mode). Proven at the time: a real projected SA token (`kubectl create
token … --audience=agent-os-gateway`) → the in-cluster gateway → `402 budget exceeded for tenant
'system:serviceaccount:default:default'` — JWKS-verified identity + claim + budget, no hand-minted JWT.
That pod path is now served by `deploy/helm/inference-gateway` (the Bun engine, via TokenReview).

**k8s gotchas found:** the cluster's `/openid/v1/jwks` needs **auth** (anonymous access off), so the
hook authenticates the JWKS fetch with the gateway pod's **own SA token**; and `SSL_CERT_FILE` =
the auto-mounted cluster CA so the TLS fetch verifies. (See `auth_hook.py:_verify`.)

## Next milestones (not in this slice)

1. ✅ **Aurora + IAM auth — done & validated.** `AgentOsPostgres` CDK stack (Serverless v2
   PostgreSQL, Min 0 ACU / auto-pause 300 s ⇒ ~$0 idle) + `rds-db:connect` policy artifact;
   the `agentos_app` rds_iam user via a tracked migration (`deploy/aurora/iam-bootstrap.sql`,
   `make aurora-bootstrap`); `SPEND_DB_IAM=true` connects keyless (fresh token per connection),
   reserve/settle proven live against the cluster. `make deploy-postgres` / `aurora-bootstrap`
   / `postgres-url` / `destroy-postgres`.
2. **Valkey/Redis shared grant cache** — only at multi-replica (in-process TTL cache covers
   single-replica); a standalone in-cluster pod, ephemeral by design (the losable tier).
3. **Mesh-trust authn (ADR-0026)** — in-cluster, Istio mTLS/SPIFFE forwarded identity.
4. **Shared conformance suite (ADR-0027)** — assert the gate contract (identity → claim →
   reserve → 402 / admit / settle) against *both* gateways so they don't drift.

*Done since M1–M4: multi-format Anthropic `/v1/messages`; the **Postgres budget reserve**
(ADR-0026's conditional `UPDATE`, validated vs a local container); two-profiles decision
recorded in [ADR-0027](../../../docs/decisions/0027-two-deployment-profiles.md).*

## Validated locally (litellm 1.87.0)

Run with `GATE_BUDGET_USD=0.0001`, **no AWS creds needed** — the 402/400 paths refuse
*before* any Bedrock call:

- worst-case > cap → `402 budget exceeded: worst-case $0.0008 > cap $0.0001` ✓
- missing `max_tokens` → `400 max_tokens is required` ✓
- neither request reached Bedrock (the hook intercepts pre-flight) ✓

**Gotcha found & fixed:** the proxy calls `async_pre_call_hook` with
`call_type="acompletion"` (the *async* form), not `"completion"` — the guard must accept
both or the hook silently passes every request through to the model. (This is the kind of
cross-version drift the pin guards against.)

### M2 — verified identity (no AWS, static claim + HS256 dev tokens)

```bash
export JWT_HS256_SECRET=testsecret
export CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}'
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
uv run litellm --config config.yaml --port 4000
```

- no token → `401 missing bearer token` ✓
- garbage token → `401 invalid token …` ✓
- **token=bob, body `"user":"acme"` → `402 budget exceeded for tenant 'bob'`** ✓ — the body's
  `acme` is ignored; the verified identity wins, and the cap `$0.0001` came from bob's claim.
- token=carol (no claim) → `403 no inference claim for 'carol'` ✓
- none reached Bedrock ✓

### M3 — live reserve → Bedrock → settle (Claude Haiku 4.5, real AWS)

`CLAIMS_STATIC` budget `$5`, `AWS_PROFILE` loaded, `max_tokens=500`:

- request as `bob` → **`200`**, real completion `{"content":"ok"}` (14 in / 4 out) ✓
- counter before: absent (0); counter after: **`0.000034`** ✓
- worst-case reserved `(14×$1 + 500×$5)/1M = $0.002514` → **settled down to actual
  `(14×$1 + 4×$5)/1M = $0.000034`** — exactly the counter value, proving the
  metadata-threaded reserve→settle reconciliation (the one path the no-AWS tests can't cover).

**Two findings:** (1) the `aws login` credential provider needs **`awscrt`** in the venv
(the AWS CLI bundles it; boto3 didn't) — added to deps. (2) on-demand Claude in eu-west-2
requires the **`eu.` cross-region inference profile** id (`eu.anthropic.claude-haiku-4-5-…`);
the raw model id is rejected as "invalid model identifier".

### M4 — runtime → LiteLLM through the port (OpenAI-wire adapter)

`OpenAIGatewayInferenceProvider` against the running gateway (token=bob, claim $5):

```
AssistantTurn: {"text":"ok","toolCalls":[],"usage":{"inputTokens":14,"outputTokens":4}}
```

- the OpenAI response translated back into our neutral `AssistantTurn` ✓
- through verified identity + budget; bob's counter moved `0.000034 → 0.000068` ✓
- 6 unit tests cover the type translation + 401/402 mapping (no network).

### Multi-format — Anthropic `/v1/messages` (Claude Code / Anthropic SDK)

LiteLLM exposes `/v1/messages` natively and routes it through the **same** hooks. Validated:

- `/v1/messages`, tiny budget → `402 budget exceeded for tenant 'bob'` ✓ (admission fires)
- `/v1/messages`, $5 budget → `200` Anthropic message; counter `0.000068 → 0.000101` ✓

**Bug found & fixed — without it, `/v1/messages` was a budget bypass + under-bill:**
1. LiteLLM tags this route `call_type="anthropic_messages"` — the admission guard must accept
   it, or admission is skipped entirely (no 402).
2. the success hook receives a **dict** response (not a ModelResponse object), so usage must be
   read from `response["usage"]`, and as `input/output_tokens` (not `prompt/completion_tokens`)
   — else `actual=0` silently refunds the whole reserve and spend never accumulates.

So a coding agent (Claude Code) can point at `…/v1/messages` and a generic app at
`…/v1/chat/completions` — one gateway, one set of hooks, both governed.

### Postgres budget store (full mode, ADR-0023/0026)

Against a local `postgres:16-alpine` container (`SPEND_STORE=postgres`):

- store semantics direct: reserve / **deny-on-breach (atomic, nothing written)** / settle /
  session scope ✓
- gateway integrated: tiny budget → `402` ✓; $5 budget → `200` live Haiku completion and the
  `budgets` table settled to the actual: `bob | 2026-06 | 0.000033` ✓

**Gotcha found:** `DATABASE_URL` collides with LiteLLM's own Prisma DB env — LiteLLM *mutates*
it (appends `connection_limit`), which psycopg rejects; hence `SPEND_DATABASE_URL`.

## Validation caveats (read before trusting it)

- **Hook signatures** are pinned to `litellm>=1.55,<2` (validated on 1.87.0; see
  `pyproject.toml`). They have drifted across versions — if the proxy errors loading the
  callback, check the installed version's `CustomLogger` signatures against this file.
- **Reservation carry** (pre → post) is threaded via `data["metadata"]["_admission"]` —
  **verified working on 1.87.0** (M3: counter settled to actual). It fails *closed* if a
  future version stops threading the same `data` dict (over-charges rather than under-charges);
  re-check the counter-settles-to-actual behaviour after a LiteLLM bump.
