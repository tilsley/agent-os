/**
 * createApp — the runtime's HTTP surface as a single `(Request) => Response`
 * handler, independent of what SERVES it (ADR-0031). This is the front-door
 * analogue of process-run.ts: one body, two substrates.
 *   - server.ts  serves it with Bun.serve      (always-on, full-k8s).
 *   - lambda.ts  serves it via the Lambda Runtime API loop (serverless front
 *     door — no HTTP server, no Lambda Web Adapter).
 * Routes, gate, and dispatch are identical across both; only the thing calling
 * this handler differs. The gate sequence (authn → authz → budget → create →
 * dispatch) lives in router.ts; the dispatch strategy is picked by env in
 * dispatch.ts (DISPATCH=inprocess|runtask).
 */
import { UnauthorizedError, currentPeriod, withCors, type AgentSpec, type Principal, type Providers } from "@agent-os/core";
import { handleA2A, buildAgentCard } from "./a2a";
import { makeAuthorizeAndCreate } from "./router";
import { dispatchFromEnv } from "./dispatch";

/** The handler-side schema for agent writes (ADR-0038) — the CRD's CEL, re-homed.
 *  Projects an ALLOWLIST of fields (unknown keys dropped) and bounds each one;
 *  returns the clean spec or a human-readable refusal. `tenant` is deliberately
 *  not accepted here — ownership is stamped from the verified identity. */
export function validateAgentSpec(body: any): { spec?: Omit<AgentSpec, "tenant">; error?: string } {
  if (typeof body !== "object" || body == null) return { error: "body must be an AgentSpec object" };
  const name = body.name;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return { error: "invalid 'name' (lowercase slug, max 63 chars)" };
  }
  const kind = body.kind ?? "loop";
  if (!["loop", "sandboxed", "claude-code", "coder"].includes(kind)) return { error: `unknown 'kind' '${kind}'` };
  if (body.description != null && (typeof body.description !== "string" || body.description.length > 280)) {
    return { error: "invalid 'description' (string, max 280 chars)" };
  }
  if (body.systemPrompt != null && (typeof body.systemPrompt !== "string" || body.systemPrompt.length > 8000)) {
    return { error: "invalid 'systemPrompt' (string, max 8000 chars)" };
  }
  if (body.model != null && (typeof body.model !== "string" || body.model.length > 128)) {
    return { error: "invalid 'model'" };
  }
  const maxSteps = body.maxSteps ?? undefined;
  if (maxSteps != null && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50)) {
    return { error: "invalid 'maxSteps' (integer 1-50)" };
  }
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every((t: any) => typeof t === "string"))) {
    return { error: "invalid 'tools' (array of strings)" };
  }
  if (body.command != null && (kind !== "sandboxed" || typeof body.command !== "string")) {
    return { error: "'command' is only valid for kind=sandboxed" };
  }
  return {
    spec: {
      name,
      kind,
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.model != null ? { model: body.model } : {}),
      ...(body.systemPrompt != null ? { systemPrompt: body.systemPrompt } : {}),
      ...(body.tools != null ? { tools: body.tools } : {}),
      ...(maxSteps != null ? { maxSteps } : {}),
      ...(body.command != null ? { command: body.command } : {}),
    },
  };
}

export interface AppOpts {
  /** per-turn output cap (ADR-0013); undefined → the loop's built-in default. */
  maxOutputTokens?: number;
  /** the agent this runtime advertises over A2A (and runs when none is named). */
  a2aAgent?: string;
}


/**
 * Build the runtime's request handler over a set of providers. Wires the dispatch
 * strategy (DISPATCH env) and the gate once, then returns the router. Call
 * providersFromEnv() ONCE per process and pass the result in (OTel registers a
 * global provider); this function does no such global registration, so it's safe
 * to call from either entrypoint.
 */
export function createApp(providers: Providers, opts: AppOpts = {}): (req: Request) => Promise<Response> {
  const { gate, authenticator, authorizer, runStore: store, agentRegistry } = providers;
  const a2aAgent = opts.a2aAgent;

  // The gate sequence (authn → authz → budget → create → dispatch), with the
  // dispatch strategy picked by env (ADR-0031): DISPATCH=inprocess runs the worker
  // in this process (full-k8s); DISPATCH=runtask makes this the serverless front
  // door, launching a Fargate task-per-run.
  const dispatcher = dispatchFromEnv(providers, { maxOutputTokens: opts.maxOutputTokens });
  const authorizeAndCreate = makeAuthorizeAndCreate(providers, dispatcher);

  const bearer = (req: Request): string | undefined =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // lowercased header map for the Authenticator (mesh/IAP edge forwards claims here)
  const headerMap = (req: Request): Record<string, string> => Object.fromEntries(req.headers);

  // READS are authenticated too (ADR-0032): run transcripts and budgets are tenant
  // data, and the console proved the gap — an open GET /runs/{id} would hand out
  // whatever the store holds. Same Authenticator as the create path; under noop
  // authn (dev default) this stays open, so local flows are unchanged.
  const authenticated = async (req: Request): Promise<boolean> => {
    try {
      await authenticator.authenticate({ credential: bearer(req), headers: headerMap(req) });
      return true;
    } catch {
      return false;
    }
  };
  const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
  // Never return the caller's raw bearer token (it's a live credential the run
  // carries for OBO exchange, ADR-0010) — strip it from every read response.
  const redact = <T extends { principal?: { token?: string } }>(run: T): T =>
    run.principal ? { ...run, principal: { ...run.principal, token: undefined } } : run;

  // CORS is app-owned (ADR-0043): the console preflights from its CloudFront
  // origin, and the edge (API Gateway or nothing) no longer answers for us.
  return withCors(async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // --- A2A protocol surface (ADR-0018): discovery + JSON-RPC ---
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      return Response.json(
        buildAgentCard({
          name: a2aAgent ?? "agent-os-runtime",
          description: `agent-os runtime hosting '${a2aAgent ?? "agents"}'`,
          url: `${url.protocol}//${url.host}/a2a`,
        }),
      );
    }
    if (req.method === "POST" && url.pathname === "/a2a") {
      return handleA2A(req, { createRun: authorizeAndCreate, getRun: (id) => store.get(id), defaultAgent: a2aAgent });
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    // The inline dashboard that used to live here is retired (ADR-0032): the web
    // console (apps/console) is the UI, and it couldn't work anyway now that the
    // read routes require a verified identity.
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "agent-os-runtime", ui: "apps/console (ADR-0032)", health: "/healthz" });
    }

    if (req.method === "GET" && url.pathname === "/info") {
      return Response.json({
        inference: providers.inference.name,
        model: providers.inference.model,
        sandbox: providers.sandbox.name,
        store: store.name,
        gate: gate.name,
        authn: authenticator.name,
        authz: authorizer.name,
        guard: providers.guard.name,
        agentRegistry: agentRegistry.name,
        memory: providers.memory?.name ?? "off",
        // the substrates this deployment can execute — the console's selector reads this
        dispatch: { default: dispatcher.defaultMode, modes: dispatcher.modes },
      });
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      if (!(await authenticated(req))) return unauthorized();
      const runs = await store.list(100);
      return Response.json(runs.map(({ messages, ...slim }) => redact(slim))); // list omits the conversation
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const task = body?.task;
      if (typeof task !== "string" || !task.trim()) {
        return Response.json({ error: "missing 'task' (string)" }, { status: 400 });
      }
      const agent = body?.agent != null ? String(body.agent) : undefined;
      // target repo for coding runs (ADR-0034): "owner/name" only — a resource the
      // gate authorizes, then the egress sidecar pins its allowlist to.
      const repo = body?.repo != null ? String(body.repo) : undefined;
      if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return Response.json({ error: "invalid 'repo' (expected owner/name)" }, { status: 400 });
      }
      // per-run substrate choice (ADR-0042) — validated in the gate against what's wired
      const dispatch = body?.dispatch != null ? String(body.dispatch) : undefined;
      // same gate as A2A: authn → authz(agent, repo) → budget → create (ADR-0015/0018)
      const r = await authorizeAndCreate(bearer(req), headerMap(req), agent, task, repo, dispatch);
      if (!r.ok) return Response.json({ error: r.error, reason: r.reason }, { status: r.status });
      return Response.json(
        { runId: r.run.id, status: r.run.status, agent, repo, dispatch: r.run.dispatch, tenant: r.run.principal!.tenant },
        { status: 202 },
      );
    }

    if (req.method === "GET" && url.pathname === "/agents") {
      if (!(await authenticated(req))) return unauthorized();
      return Response.json(await agentRegistry.list());
    }

    // Agent onboarding (ADR-0038): the registry's governed write path — the cheap
    // profile's API server. authn → authz(agent:register, {kind}) → validate →
    // STAMP tenant from the verified identity → upsert. 501 when the registry has
    // no write (kube: writes stay `kubectl apply` against the real API server).
    if (req.method === "POST" && url.pathname === "/agents") {
      let principal: Principal;
      try {
        principal = await authenticator.authenticate({ credential: bearer(req), headers: headerMap(req) });
      } catch (e) {
        if (e instanceof UnauthorizedError) return unauthorized();
        throw e;
      }
      if (!agentRegistry.put) return Response.json({ error: `registry '${agentRegistry.name}' is not writable here` }, { status: 501 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const { spec, error } = validateAgentSpec(body);
      if (!spec) return Response.json({ error }, { status: 400 });
      const decision = await authorizer.authorize(principal, "agent:register", spec.name, { kind: spec.kind! });
      if (!decision.allow) return Response.json({ error: "forbidden", reason: decision.reason }, { status: 403 });
      // ownership: an existing agent may only be overwritten by its owning tenant
      const existing = await agentRegistry.get(spec.name);
      if (existing?.tenant && existing.tenant !== principal.tenant) {
        return Response.json({ error: "forbidden", reason: "agent is owned by another tenant" }, { status: 403 });
      }
      const stamped: AgentSpec = { ...spec, tenant: principal.tenant };
      await agentRegistry.put(stamped);
      return Response.json(stamped, { status: existing ? 200 : 201 });
    }

    const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
    if (req.method === "DELETE" && agentMatch) {
      let principal: Principal;
      try {
        principal = await authenticator.authenticate({ credential: bearer(req), headers: headerMap(req) });
      } catch (e) {
        if (e instanceof UnauthorizedError) return unauthorized();
        throw e;
      }
      if (!agentRegistry.delete) return Response.json({ error: `registry '${agentRegistry.name}' is not writable here` }, { status: 501 });
      const name = agentMatch[1]!;
      const decision = await authorizer.authorize(principal, "agent:delete", name);
      if (!decision.allow) return Response.json({ error: "forbidden", reason: decision.reason }, { status: 403 });
      const existing = await agentRegistry.get(name);
      if (!existing) return Response.json({ error: "agent not found" }, { status: 404 });
      if (existing.tenant && existing.tenant !== principal.tenant) {
        return Response.json({ error: "forbidden", reason: "agent is owned by another tenant" }, { status: 403 });
      }
      await agentRegistry.delete(name);
      return Response.json({ deleted: name });
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      if (!(await authenticated(req))) return unauthorized();
      const run = await store.get(runMatch[1]!);
      return run ? Response.json(redact(run)) : Response.json({ error: "run not found" }, { status: 404 });
    }

    const budgetMatch = url.pathname.match(/^\/tenants\/([^/]+)\/budget$/);
    if (req.method === "GET" && budgetMatch) {
      if (!(await authenticated(req))) return unauthorized();
      return Response.json(await gate.checkBudget(budgetMatch[1]!));
    }

    // Showback (ADR-0036): the two governed lanes in one view — metered dollar spend
    // (loop/Bedrock agents) AND run-quota consumption (claude-code/subscription runs).
    const usageMatch = url.pathname.match(/^\/tenants\/([^/]+)\/usage$/);
    if (req.method === "GET" && usageMatch) {
      if (!(await authenticated(req))) return unauthorized();
      const tenant = usageMatch[1]!;
      const [budget, quota] = await Promise.all([gate.checkBudget(tenant), gate.checkQuota(tenant)]);
      return Response.json({ tenant, period: currentPeriod(), budget, quota });
    }

    return new Response("not found", { status: 404 });
  });
}
