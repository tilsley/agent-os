---
name: deploy-console
description: Deploy the creance/agent-os web console (hosted UI) and, when the agent-runtime backend changed, the serverless front door. Use when the user asks to deploy, redeploy, ship, or push live the console / hosted UI / creance UI, or to make a frontend or agent-runtime change visible in the hosted app.
metadata:
  author: tilsley
  version: "1.0.0"
---

# Deploy the console (and front door)

The hosted UI is the **`AgentOsConsole`** CDK stack — the built SPA (`apps/console/dist`) on S3 behind CloudFront, live at **https://console.creance.nathantilsley.com/**. The agent-runtime API it calls is a separate stack, **`AgentOsServerless`** (Lambda front door, ADR-0031).

Both deploys go through the **Makefile**, which already pins `AWS_PROFILE=nathan-tilsley-developer` (account `233965347831`) and `AWS_REGION=eu-west-2` — so never pass `AWS_PROFILE`/`-c` flags by hand (config lives in `deploy/aws/cdk.json`; CLI `-c` overrides silently revert on the next deploy).

## Step 1 — pre-flight: confirm the account

Always run first (the deploy targets do this too, via the `whoami` prerequisite):

```bash
make whoami
```

- **Expect** `Account: 233965347831`. If it's a different account, stop and ask the user.
- **On `ExpiredToken` / `SSO session has expired`:** creds are ~1h and refresh isn't something you can do — ask the user to run their SSO login in the prompt, e.g. `! aws sso login --profile nathan-tilsley-developer`, then retry.

## Step 2 — pick the stack(s)

Deploy only what changed:

| What changed | Deploy |
|---|---|
| Anything under `apps/console/` (the UI) | `make deploy-console` |
| `services/agent-runtime/` or `packages/core` (API behavior, e.g. authored agent `description`) | `make deploy-serverless` |
| Both | run both targets |

Frontend and backend are independent stacks — a UI change does **not** need `deploy-serverless`, and vice-versa.

## Step 3 — deploy

```bash
make deploy-console      # builds apps/console/dist FIRST, then cdk deploy AgentOsConsole
make deploy-serverless   # cdk deploy AgentOsServerless (only if the backend changed)
```

Notes:
- `deploy-console` **builds before synth** — CDK reads `apps/console/dist`, so a stale/missing build ships the wrong bundle. The Makefile target handles this; don't `cdk deploy` the console by hand without building.
- The console's `BucketDeployment` **auto-invalidates CloudFront** (`/*`), so the new bundle is live immediately — no manual invalidation.
- Console **config** (`apiUrl`, Cognito ids) is written as a deployed `/config.json`, not baked at build time. A config-only change is a redeploy of the stack, never an app rebuild.
- If CDK prompts for approval on security-relevant changes, surface it to the user rather than auto-approving.

## Step 4 — verify

- The `AgentOsConsole` deploy prints a `ConsoleUrl` output — report it.
- Confirm the change is live at https://console.creance.nathantilsley.com/ (hard-refresh; the CDN was invalidated).

## Related

- Deploy recipe origin: `deploy/aws/bin/agent-os.ts`; hosting details: `deploy/aws/lib/console-stack.ts`.
- Other stacks (`AgentOsState`, `AgentOsBedrock`, `AgentOsPostgres`, etc.) have their own `make` targets — see `make help`.
