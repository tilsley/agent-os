/**
 * agent-runtime agent-engine — the L1 loop hosted on GCP Vertex **Agent Runtime**
 * (Gemini Enterprise Agent Platform), the fourth deployment profile and the GCP
 * sibling of the AWS AgentCore profile (ADR-0042). This is the "fourth entrypoint,
 * same image" (cf. lambda.ts / task.ts): the managed runtime invokes our container
 * over HTTP instead of launching a Fargate task, but the run body (process-run.ts)
 * and provider wiring are byte-identical.
 *
 * The custom-container contract (Vertex Agent Runtime BYOC) — VERIFIED LIVE 2026-07-14:
 *   - Listen on 0.0.0.0:${AIP_HTTP_PORT}  (default 8080). ✓ confirmed injected.
 *   - Health check: respond 200 on ${AIP_HEALTH_ROUTE} (we also answer /, /ping).
 *   - Query: Agent Runtime POSTs the reasoningEngine :query body to
 *     **`POST /api/reasoning_engine`** as `{"input": {...}}` (observed in logs).
 *   - Response: the platform relays the container's body as the REST `:query`
 *     response, whose schema is `{"output": <value>}` — so the CONTAINER must return
 *     `{"output": <result>}`. Returning a bare object (no `output` key) makes the
 *     platform's wrapper 500. Hence responseFor() below wraps every query result.
 *   THIS entrypoint still LOGS every request (method/path/body) so any future contract
 *   drift is visible.
 *
 * PROBE MODE (default when input has no `task`): return a runtime envelope proving
 * Agent Runtime ↔ our container works, WITHOUT a model call — so phase-1 ("prove
 * the invoke path, the authorizer, the envelope") is green before inference on GCP
 * is wired. A real `task` triggers an actual run via the shared app handler.
 *
 *   AIP_HTTP_PORT=8080 DISPATCH=inprocess bun run services/agent-runtime/agent-engine.ts
 */
import { providersFromEnv, resolveSecretEnv } from "@agent-os/core";
import { createApp } from "./app";

// Resolve secret ENV references before providers read them (ADR-0047): the E2B coder
// sandbox key arrives as E2B_API_KEY_SECRET (a Secret Manager reference), never as
// plaintext in the Agent Runtime config — the loop's own SA fetches the value here.
await resolveSecretEnv("E2B_API_KEY");

const providers = providersFromEnv(); // once per process (OTel registers globally)
const { runStore: store } = providers;
const port = Number(process.env.AIP_HTTP_PORT ?? process.env.PORT ?? 8080);
const healthRoute = process.env.AIP_HEALTH_ROUTE ?? "/healthz";
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

// The runtime hosts the loop, so runs execute in THIS process — force inprocess
// dispatch regardless of the ambient env (a stray DISPATCH=runtask here would try
// to launch Fargate from inside GCP). This mirrors task.ts owning its own run.
process.env.DISPATCH = "inprocess";
const app = createApp(providers, { maxOutputTokens, a2aAgent: process.env.A2A_AGENT });

/** Redacted, bounded log of an incoming invocation — the empirical contract probe.
 *  The coder workspace credential (ADR-0046) rides `input.githubToken`: strip it. */
function logInvocation(method: string, path: string, body: unknown): void {
  const redacted =
    body && typeof body === "object" && (body as any).input?.githubToken
      ? { ...(body as any), input: { ...(body as any).input, githubToken: "[redacted]" } }
      : body;
  const preview = JSON.stringify(redacted ?? null).slice(0, 800);
  console.log(`agent-engine invoke: ${method} ${path} body=${preview}`);
}

/** Poll the run store until the run reaches a terminal state (query is synchronous).
 *  Bounded so a stuck run can't hold the invocation open forever. Terminal = every
 *  RunStatus that won't advance on its own (completed/failed/blocked/stuck). */
const TERMINAL = new Set(["completed", "failed", "blocked", "stuck"]);
async function awaitRun(runId: string, timeoutMs = 110_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.get(runId);
    if (run && TERMINAL.has(run.status)) return run;
    if (Date.now() > deadline) return run; // return whatever we have; caller sees non-terminal
    await new Promise((r) => setTimeout(r, 500));
  }
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 120, // long agent turns; the managed runtime allows long sessions
  async fetch(req) {
    const url = new URL(req.url);

    // Health — the runtime's liveness/readiness probe. Answer the configured route
    // and the usual suspects; body is ignored by the platform.
    if (req.method === "GET" && (url.pathname === healthRoute || url.pathname === "/" || url.pathname === "/ping")) {
      return Response.json({ status: "ok", runtime: "agent-engine" });
    }

    // Everything else that's a POST is treated as a query invocation (path logged so
    // we learn the real route). GET on an unknown path → 404.
    if (req.method !== "POST") return new Response("not found", { status: 404 });

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      /* leave body null; still logged */
    }
    logInvocation(req.method, url.pathname, body);

    const classMethod: string = body?.class_method ?? "query";
    const input: any = body?.input ?? body ?? {};
    // The REST :query response schema is {"output": <value>} and the platform relays
    // our body verbatim — so every query result MUST be wrapped in `output`.
    const queryResponse = (output: unknown) => Response.json({ output });
    const authz = req.headers.get("authorization");

    // FRONT-DOOR HANDOFF — a runId means the front door (DISPATCH=agentengine) already
    // created the run in the SHARED store and handed off; we execute it. This MUST be
    // checked BEFORE the probe guard: a handoff payload is `{runId}` with no `task`, so
    // the `typeof task !== "string"` probe test below would otherwise swallow it as a
    // probe and the run would rot in `queued` forever (the bug that stalled phase-3).
    if (typeof input?.runId === "string") {
      const runId = input.runId;
      // Wrap the WHOLE path (incl. the store read): a silent failure here would leave the
      // run rotting in `queued` forever with no signal, so turn any error into a visible
      // `failed` state. A missing run means the front door wrote to a DIFFERENT store than
      // this engine reads (a shared-store misconfig) — surface that explicitly.
      try {
        const before = await store.get(runId);
        if (!before) {
          console.error(`agent-engine: run ${runId} NOT FOUND in store=${store.name} (shared-store mismatch?)`);
          return queryResponse({ error: `run not found: ${runId}`, store: store.name });
        }
        const { processRun } = await import("./process-run");
        // coder workspace credential (ADR-0046) — the :query-input leg of the dispatch envelope
        const githubToken = typeof input?.githubToken === "string" ? input.githubToken : undefined;
        await processRun(providers, runId, { maxOutputTokens, githubToken });
        const done = await store.get(runId);
        // console visibility (ADR-0044 5b): mirror the finished run into a managed Vertex
        // Session, best-effort — a mirror failure must never fail an otherwise-good run.
        if (done && providers.sessionRecorder) {
          await providers.sessionRecorder
            .record(done)
            .catch((e) => console.error(`agent-engine: session mirror failed for ${runId}: ${e?.message ?? e}`));
        }
        return queryResponse(done);
      } catch (e: any) {
        console.error(`agent-engine: runId ${runId} path FAILED: ${e?.message ?? e}`);
        await store.update(runId, { status: "failed", error: `engine: ${e?.message ?? e}` }).catch(() => {});
        return queryResponse({ error: String(e?.message ?? e) });
      }
    }

    // PROBE MODE — prove the envelope without a model call (no runId, no task).
    const task: unknown = input?.task;
    if (input?.probe === true || typeof task !== "string" || !task.trim()) {
      return queryResponse({
        ok: true,
        mode: "probe",
        runtime: "agent-engine",
        class_method: classMethod,
        dispatch: process.env.DISPATCH,
        providers: {
          store: providers.runStore.name,
          gate: providers.gate.name,
          authn: providers.authenticator.name,
          authz: providers.authorizer.name,
          inference: providers.inference.name,
          sandbox: providers.sandbox.name,
          memory: providers.memory?.name ?? "off",
        },
        echo: input,
      });
    }

    // INLINE TASK — no pre-created run: create one via the shared gate (POST /runs) and
    // run it to completion in-process. Reuses app.ts so the gate/authz path is identical.
    const create = await app(
      new Request("https://agent-engine.local/runs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(authz ? { authorization: authz } : {}) },
        body: JSON.stringify({ task, agent: input?.agent, repo: input?.repo }),
      }),
    );
    if (create.status !== 202) return queryResponse({ error: await create.json() }); // gate refusal
    const { runId } = (await create.json()) as { runId: string };
    const run = await awaitRun(runId);
    return queryResponse(run ?? { runId, status: "unknown" });
  },
});

console.log(
  `agent-engine listening on 0.0.0.0:${server.port}  (Vertex Agent Runtime; health=${healthRoute}; ` +
    `dispatch=${process.env.DISPATCH}; store=${store.name}; gate=${providers.gate.name}; ` +
    `authn=${providers.authenticator.name} inference=${providers.inference.name} ` +
    `sandbox=${providers.sandbox.name} record=${providers.telemetry.name})`,
);
