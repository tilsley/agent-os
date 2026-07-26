/**
 * The dispatch seam (ADR-0031) — how a freshly-created, queued Run gets executed.
 * This is the ONE place the substrates diverge:
 *   - inprocess: the always-on service runs the worker itself, fire-and-forget
 *     (full-k8s); the run shares the front door's process.
 *   - runtask:   the front door (router) launches a Fargate task-per-run that
 *     executes this run and exits (serverless / scale-to-zero). The router holds
 *     no run — it created the queued record and handed off.
 *   - agentcore: the managed profile (ADR-0042) — InvokeAgentRuntime spins up a
 *     per-session microVM running OUR loop container (the agentcore.ts
 *     entrypoint). kind="claude-code" runs still go to Fargate: the foreign-L1
 *     lane cannot lean in (2vCPU/8GB, no sidecar seat — comparison §15).
 *   - agentengine: the front door invokes a GCP Vertex **Agent Runtime**
 *     (reasoningEngine :query) with the runId — the managed-runtime analog of
 *     runtask, and the GCP sibling of ADR-0042's DISPATCH=agentcore. The run
 *     executes inside the managed container (agent-engine.ts); state lives in the
 *     store; the poller watches it. Fire-and-forget, like the others.
 * Selected by DISPATCH (default inprocess), so server.ts is the front door in
 * every profile; only the env bundle changes (ADR-0027).
 */
import { type AgentRegistry, type DispatchMode, type Providers, type Run, type RunStore } from "@agent-os/core";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { processRun, type ProcessRunOpts } from "./process-run";
import { githubAppFromEnv } from "./github-app";

/** Per-run secrets minted by the control plane at dispatch (ADR-0046). Carried in
 *  the dispatch ENVELOPE — env override / invoke payload — never on the Run record,
 *  which every read route serves back. */
export interface DispatchContext {
  githubToken?: string;
}

export type Dispatch = (run: Run, ctx?: DispatchContext) => void;

/** full-k8s: execute the run in this process, fire-and-forget. processRun owns its
 *  own failures (it persists status=failed), so a rejection here is truly unexpected. */
export function inProcessDispatch(providers: Providers, opts: ProcessRunOpts = {}): Dispatch {
  return (run, ctx) => {
    void processRun(providers, run.id, { ...opts, githubToken: ctx?.githubToken }).catch((e) =>
      console.error(`in-process worker crashed for run ${run.id}: ${e?.message ?? e}`),
    );
  };
}

export interface RunTaskConfig {
  cluster: string;
  taskDefinition: string;
  /** The container in the task def to inject RUN_ID into (matches the CDK task def). */
  container: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: boolean;
  region?: string;
  /** The kind="claude-code" executor (ADR-0033): a different task def in the SAME
   *  cluster/subnets, same RUN_ID-override contract. Unset ⇒ claude-code runs fail
   *  at dispatch (terminal, visible to the poller) rather than mis-running on the loop.
   *  sidecarContainer (ADR-0034): the egress sidecar also receives RUN_ID so it can
   *  resolve its own per-run credential allowlist from the registry. */
  claudeCode?: { taskDefinition: string; container: string; sidecarContainer?: string };
}

/** Read the RunTask wiring the CDK stack publishes into the router's env. */
export function runTaskConfigFromEnv(env: Record<string, string | undefined> = process.env): RunTaskConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`DISPATCH=runtask requires ${k}`);
    return v;
  };
  const list = (k: string): string[] => req(k).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    cluster: req("ECS_CLUSTER"),
    taskDefinition: req("ECS_TASK_DEFINITION"),
    container: env.ECS_CONTAINER_NAME ?? "agent-runtime-task",
    subnets: list("ECS_SUBNETS"),
    securityGroups: list("ECS_SECURITY_GROUPS"),
    assignPublicIp: (env.ECS_ASSIGN_PUBLIC_IP ?? "false").toLowerCase() === "true",
    region: env.REGION,
    claudeCode: env.ECS_CC_TASK_DEFINITION
      ? {
          taskDefinition: env.ECS_CC_TASK_DEFINITION,
          container: env.ECS_CC_CONTAINER_NAME ?? "claude-code-runner",
          sidecarContainer: env.ECS_CC_SIDECAR_CONTAINER_NAME,
        }
      : undefined,
  };
}

/** serverless: launch a Fargate task-per-run that executes this run and exits
 *  (ADR-0031). The run id rides in as a RUN_ID container override, so one task
 *  def serves every run. kind="claude-code" agents (ADR-0033) route to their own
 *  task def — the registry lookup here is the ONLY fork; the launch contract is
 *  identical. On a dispatch failure the run can't silently rot in `queued` —
 *  mark it failed so the poller sees a terminal state. */
export function runTaskDispatch(
  config: RunTaskConfig,
  runStore: RunStore,
  agentRegistry?: AgentRegistry,
): Dispatch {
  const ecs = new ECSClient({ region: config.region ?? process.env.REGION ?? "eu-west-2" });
  return (run, ctx) => {
    void (async () => {
      let target: { taskDefinition: string; container: string; sidecarContainer?: string } = {
        taskDefinition: config.taskDefinition,
        container: config.container,
      };
      const spec = run.agent && agentRegistry ? await agentRegistry.get(run.agent) : undefined;
      if (spec?.kind === "claude-code") {
        if (!config.claudeCode)
          throw new Error(`agent '${run.agent}' is kind=claude-code but ECS_CC_TASK_DEFINITION is not configured`);
        target = config.claudeCode;
      }
      // RUN_ID reaches every listed container: the executor to run it, the egress
      // sidecar (ADR-0034) to resolve its per-run credential allowlist from the registry.
      // The coder workspace token (ADR-0046) reaches ONLY the executor container.
      const overrideContainers = [target.container, ...(target.sidecarContainer ? [target.sidecarContainer] : [])];
      const res = await ecs.send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: target.taskDefinition,
          launchType: "FARGATE",
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: config.subnets,
              securityGroups: config.securityGroups,
              assignPublicIp: config.assignPublicIp ? "ENABLED" : "DISABLED",
            },
          },
          overrides: {
            containerOverrides: overrideContainers.map((name) => ({
              name,
              environment: [
                { name: "RUN_ID", value: run.id },
                ...(name === target.container && ctx?.githubToken
                  ? [{ name: "GITHUB_TOKEN", value: ctx.githubToken }]
                  : []),
              ],
            })),
          },
        }),
      );
      const failures = res.failures ?? [];
      if (failures.length) throw new Error(`RunTask failures: ${JSON.stringify(failures)}`);
      console.log(`dispatched run ${run.id} -> ${res.tasks?.[0]?.taskArn ?? "(task)"}`);
    })().catch(async (e) => {
      console.error(`RunTask dispatch failed for run ${run.id}: ${e?.message ?? e}`);
      await runStore
        .update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` })
        .catch(() => {});
    });
  };
}

export interface AgentCoreDispatchConfig {
  /** The AgentCore Runtime hosting the loop container (the CDK stack's output). */
  runtimeArn: string;
  /** Runtime endpoint (alias) to invoke; AgentCore's default endpoint if unset. */
  qualifier?: string;
  region?: string;
}

/** Read the InvokeAgentRuntime wiring the AgentCore stack publishes into the router's env. */
export function agentCoreConfigFromEnv(env: Record<string, string | undefined> = process.env): AgentCoreDispatchConfig {
  const runtimeArn = env.AGENTCORE_RUNTIME_ARN;
  if (!runtimeArn) throw new Error("DISPATCH=agentcore requires AGENTCORE_RUNTIME_ARN");
  return { runtimeArn, qualifier: env.AGENTCORE_QUALIFIER, region: env.REGION };
}

/** managed profile (ADR-0042): InvokeAgentRuntime session-per-run — our loop container in
 *  a dedicated microVM. runtimeSessionId = run.id (a UUID, 36 chars — over Runtime's
 *  33-char floor), so a run IS a session and never shares a microVM. The entrypoint
 *  processes the run INSIDE the invocation (Runtime freezes the microVM once the
 *  response is sent, so background work stalls); this send resolves when the run
 *  ends and we don't wait on it — watchers poll the run store as everywhere else.
 *  kind="claude-code" runs route to the Fargate fallback when configured — the one lane
 *  that stays on ECS in this profile; without a fallback they fail terminally at
 *  dispatch, visible to the poller, same stance as runTaskDispatch's missing cc config. */
export function agentCoreDispatch(
  config: AgentCoreDispatchConfig,
  runStore: RunStore,
  agentRegistry?: AgentRegistry,
  claudeCodeFallback?: Dispatch,
  client?: BedrockAgentCoreClient,
): Dispatch {
  const agentcore =
    client ?? new BedrockAgentCoreClient({ region: config.region ?? process.env.REGION ?? "eu-west-2" });
  return (run, ctx) => {
    void (async () => {
      const spec = run.agent && agentRegistry ? await agentRegistry.get(run.agent) : undefined;
      if (spec?.kind === "claude-code") {
        if (!claudeCodeFallback)
          throw new Error(`agent '${run.agent}' is kind=claude-code but no Fargate fallback is configured (ECS_CC_TASK_DEFINITION)`);
        claudeCodeFallback(run, ctx);
        return;
      }
      const res = await agentcore.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: config.runtimeArn,
          ...(config.qualifier ? { qualifier: config.qualifier } : {}),
          runtimeSessionId: run.id,
          contentType: "application/json",
          accept: "application/json",
          // the coder token (ADR-0046) rides the invoke payload — the microVM has no env-override seam
          payload: new TextEncoder().encode(
            JSON.stringify({ runId: run.id, ...(ctx?.githubToken ? { githubToken: ctx.githubToken } : {}) }),
          ),
        }),
      );
      console.log(`dispatched run ${run.id} -> agentcore session ${run.id} (status ${res.statusCode ?? "?"})`);
    })().catch(async (e) => {
      // The invocation now spans the whole run, so a client-side drop (timeout,
      // frozen caller) can outlive a HEALTHY run — only mark failed if the run
      // never got claimed (i.e. delivery itself failed).
      const current = await runStore.get(run.id).catch(() => undefined);
      if (current && current.status !== "queued") {
        console.warn(`InvokeAgentRuntime response lost for run ${run.id} (status=${current.status}) — run proceeds: ${e?.message ?? e}`);
        return;
      }
      console.error(`InvokeAgentRuntime dispatch failed for run ${run.id}: ${e?.message ?? e}`);
      await runStore
        .update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` })
        .catch(() => {});
    });
  };
}

export interface AgentEngineConfig {
  project: string;
  location: string;
  /** The deployed reasoningEngine's numeric id (Agent Runtime resource). */
  reasoningEngineId: string;
  /** Override the aiplatform base (defaults to the regional endpoint). */
  endpoint?: string;
}

/** Read the Agent Runtime wiring the deploy publishes into the front door's env. */
export function agentEngineConfigFromEnv(env: Record<string, string | undefined> = process.env): AgentEngineConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`DISPATCH=agentengine requires ${k}`);
    return v;
  };
  return {
    project: req("GCP_PROJECT"),
    location: env.GCP_LOCATION ?? "europe-west2",
    reasoningEngineId: req("AGENT_ENGINE_ID"),
    endpoint: env.AGENT_ENGINE_ENDPOINT,
  };
}

/** A GCP access token for the reasoningEngines call. Prefers an explicit
 *  GCP_ACCESS_TOKEN (local/testing); otherwise the instance metadata server (works
 *  when the front door runs on GCP — Cloud Run/GCE). Dependency-free on purpose:
 *  no google-cloud SDK in the shared runtime image. Cross-cloud (front door on AWS
 *  Lambda) will graduate to WIF here. */
async function gcpAccessToken(): Promise<string> {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`GCP metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** managed GCP: invoke a Vertex Agent Runtime (reasoningEngine :query) with the
 *  runId (ADR-0042's GCP sibling). The run executes in the managed container; on a
 *  dispatch failure mark the run failed so it can't rot in `queued`. */
export function agentEngineDispatch(config: AgentEngineConfig, runStore: RunStore): Dispatch {
  const base = config.endpoint ?? `https://${config.location}-aiplatform.googleapis.com/v1`;
  const url = `${base}/projects/${config.project}/locations/${config.location}/reasoningEngines/${config.reasoningEngineId}:query`;
  return (run, ctx) => {
    void (async () => {
      const token = await gcpAccessToken();
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          input: { runId: run.id, ...(ctx?.githubToken ? { githubToken: ctx.githubToken } : {}) },
        }),
      });
      if (!res.ok) throw new Error(`reasoningEngine :query ${res.status}: ${await res.text()}`);
      console.log(`dispatched run ${run.id} -> reasoningEngine ${config.reasoningEngineId}`);
    })().catch(async (e) => {
      console.error(`agentengine dispatch failed for run ${run.id}: ${e?.message ?? e}`);
      await runStore.update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` }).catch(() => {});
    });
  };
}

/** The dispatch seam, per-run aware: `dispatch` routes each run by its stamped
 *  `run.dispatch` (falling back to the profile default), and `modes` names every
 *  substrate this deployment can execute — what the front door validates a
 *  caller's per-run choice against, and what /info advertises to the console. */
export interface Dispatcher {
  defaultMode: DispatchMode;
  modes: DispatchMode[];
  dispatch: Dispatch;
}

/** Build the dispatcher from env. DISPATCH (inprocess|runtask|agentcore|agentengine;
 *  default inprocess) picks the DEFAULT substrate and must be fully wired (missing
 *  env is an init error, as before). Any OTHER substrate whose wiring happens to be
 *  present (ECS_TASK_DEFINITION / AGENTCORE_RUNTIME_ARN / AGENT_ENGINE_ID+GCP_PROJECT)
 *  is offered as a per-run override — except inprocess, which is never an override: a
 *  scale-to-zero front door dies with the request, taking the run with it. */
export function dispatchFromEnv(providers: Providers, opts: ProcessRunOpts = {}): Dispatcher {
  const defaultMode = (process.env.DISPATCH ?? "inprocess") as DispatchMode;
  if (!["inprocess", "runtask", "agentcore", "agentengine"].includes(defaultMode)) {
    throw new Error(`unknown DISPATCH: ${defaultMode} (expected inprocess|runtask|agentcore|agentengine)`);
  }
  // one RunTask dispatch serves both the runtask substrate and agentcore's cc lane
  let runTask: Dispatch | undefined;
  const getRunTask = () => (runTask ??= runTaskDispatch(runTaskConfigFromEnv(), providers.runStore, providers.agentRegistry));
  const getAgentCore = () => {
    // The cc lane rides the SAME RunTask wiring as the serverless profile when the
    // stack provides it (ADR-0042: claude-code stays Fargate in every profile).
    const ccFallback = process.env.ECS_CC_TASK_DEFINITION ? getRunTask() : undefined;
    return agentCoreDispatch(agentCoreConfigFromEnv(), providers.runStore, providers.agentRegistry, ccFallback);
  };

  const table = new Map<DispatchMode, Dispatch>();
  if (defaultMode === "inprocess") table.set("inprocess", inProcessDispatch(providers, opts));
  if (defaultMode === "runtask" || process.env.ECS_TASK_DEFINITION) table.set("runtask", getRunTask());
  if (defaultMode === "agentcore" || process.env.AGENTCORE_RUNTIME_ARN) table.set("agentcore", getAgentCore());
  if (defaultMode === "agentengine" || (process.env.AGENT_ENGINE_ID && process.env.GCP_PROJECT))
    table.set("agentengine", agentEngineDispatch(agentEngineConfigFromEnv(), providers.runStore));

  // ADR-0046: the control plane is the ONLY place that can mint the coder's
  // workspace credential for every substrate (the microVM and Vertex can't reach
  // the App key) — so minting happens here, at dispatch, per run.
  const github = githubAppFromEnv();

  return {
    defaultMode,
    modes: [defaultMode, ...[...table.keys()].filter((m) => m !== defaultMode)],
    dispatch: (run) => {
      // admission validated run.dispatch against `modes`, so a miss here is a bug —
      // surface it as a terminal dispatch failure, never a silent substrate swap.
      const impl = table.get(run.dispatch ?? defaultMode);
      if (!impl) {
        console.error(`no dispatch impl for '${run.dispatch}' (run ${run.id})`);
        void providers.runStore
          .update(run.id, { status: "failed", error: `dispatch failed: substrate '${run.dispatch}' not available` })
          .catch(() => {});
        return;
      }
      void (async () => {
        let ctx: DispatchContext | undefined;
        const spec = run.agent ? await providers.agentRegistry.get(run.agent) : undefined;
        if (spec?.kind === "coder" && run.repo) {
          if (!github) {
            throw new Error(`coder run targets ${run.repo} but the GitHub App is not wired (GITHUB_APP_ID/_INSTALLATION_ID/_PRIVATE_KEY[_PARAM])`);
          }
          ctx = { githubToken: await github.mintInstallationToken(run.repo) };
        }
        impl(run, ctx);
      })().catch(async (e) => {
        console.error(`dispatch failed for run ${run.id}: ${e?.message ?? e}`);
        await providers.runStore
          .update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` })
          .catch(() => {});
      });
    },
  };
}
