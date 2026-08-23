# agent-os-coder — E2B sandbox template (ADR-0047)

The Model-B **iterate-in-box** toolchain for the `coder` loop
([ADR-0046](../../docs/decisions/0046-coder-loop.md)) on the GCP profile
([ADR-0044](../../docs/decisions/0044-gcp-agent-runtime-profile.md)), reusable on any
profile via `SANDBOX_PROVIDER=e2b`. Go, JDK + Gradle, Node, Python (from the base) and
git are baked in, so `go test` / `gradle test` / `npm test` run **for real** inside the
E2B session — the compiler/test feedback loop a Model-A interpreter (Vertex Code
Execution / AgentCore Code Interpreter) can't give a compiled language.

Why E2B rather than a GCP-native box: our real sandbox adapters are **session-native**
(a durable, addressable microVM per session), so they fit the `SandboxProvider` port
with no pinning/affinity machinery. Cloud Run (a request autoscaler) would force us to
invent that; the GCP-native graduation is a GKE pod-per-session. See ADR-0047.

## Build & push (needs an E2B account)

The template is defined with the **E2B v2 SDK** (`template.ts`), not a Dockerfile — E2B
deprecated the v1 `template build --dockerfile` path and it now no-ops. This dir is its own
tiny package pinning `e2b@^2` (the repo's runtime `@e2b/code-interpreter` is a separate,
older package), so build it in place:

```sh
cd deploy/e2b-coder
bun install                              # first time — pulls e2b@^2
export E2B_API_KEY=...                   # or: bunx @e2b/cli@latest auth login
bun run build                            # runs build.ts → Template.build('agent-os-coder')
```

`build.ts` publishes the template to your E2B team under the name `agent-os-coder`
(cpu 2 / mem 4096, matching the old sizing). Rebuild after any `template.ts` change — the
name is stable, so no deploy change is needed on a rebuild.

The toolchain (`template.ts`): base `e2bdev/code-interpreter` (keeps both the `runCode`
Jupyter kernel and `commands.run` bash surfaces the adapter uses) + git, a JDK + Gradle,
Go (pinned tarball, symlinked onto the runtime PATH), and Node 20. A final `runCmd`
version-checks every toolchain so a missing one fails the build, not the first coder run.

## How the runtime uses it

`deploy/gcp-agent-engine/deploy.py` sets on the Agent Runtime:

- `SANDBOX_PROVIDER=e2b`
- `E2B_TEMPLATE=agent-os-coder`
- `E2B_API_KEY_SECRET=projects/<project>/secrets/e2b-api-key/versions/latest`

The E2B **API key** is never passed as plaintext. `E2B_API_KEY_SECRET` is a Secret
Manager *reference*; the loop's service account resolves it at startup via
`resolveSecretEnv` (packages/core `gcp-secrets.ts`), so the key stays out of the
reasoningEngine config. Provision the secret + accessor binding in `infra-gcp/`
(Pulumi) and add the value out-of-band:

```sh
printf '%s' "$E2B_API_KEY" | gcloud secrets versions add e2b-api-key \
  --project decent-decker-270921 --data-file=-
```
