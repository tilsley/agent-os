import { useEffect, useState } from "react";
import { Api, ApiError, type AgentSpec, type DispatchMode } from "../api";

type AgentKind = NonNullable<AgentSpec["kind"]>;

/** What the deployment advertises at GET /info — the picker uses it to describe,
 *  per agent, where it runs and where it gets inference. */
interface Deployment {
  inference?: string;
  model?: string;
  sandbox?: string;
  dispatch?: { default: DispatchMode; modes: DispatchMode[] };
}

/** Per-kind: the badge label + a SHORT purpose gloss (last-resort only — used when an
 *  agent has neither an authored description nor a systemPrompt to speak for it). */
const KIND_INFO: Record<AgentKind, { label: string; gloss: string }> = {
  loop: { label: "loop", gloss: "General-purpose reasoning agent." },
  coder: { label: "coder", gloss: "Writes code in a real repo workspace." },
  "claude-code": { label: "claude-code", gloss: "A headless Claude Code session." },
  sandboxed: { label: "sandboxed", gloss: "A delegated agent that runs in the sandbox." },
};

const DEFAULT_PURPOSE = "The built-in default loop — general reasoning with the standard toolset. A good first run.";

/** Human names for the substrates behind the dispatch seam (ADR-0031/0042). */
const DISPATCH_INFO: Record<DispatchMode, { label: string; short: string; blurb: string }> = {
  inprocess: { label: "In-process (dev)", short: "in-process", blurb: "Runs inside the API process — fastest, for local/dev." },
  runtask: { label: "Fargate task", short: "Fargate", blurb: "Each run gets its own AWS Fargate task — isolated, pay-per-run." },
  agentcore: { label: "AgentCore microVM", short: "AgentCore", blurb: "Bedrock AgentCore — a fresh microVM per run for strong isolation." },
  agentengine: { label: "Vertex Agent Runtime (GCP)", short: "Vertex (GCP)", blurb: "Runs on Google Vertex Agent Runtime." },
};

/** Strip the region/provider prefix and the date/version suffix off a model id so the
 *  picker shows "claude-haiku-4-5", not "eu.anthropic.claude-haiku-4-5-20251001-v1:0". */
function prettyModel(m: string): string {
  return m
    .replace(/^(us|eu|apac|ap)\./, "")
    .replace(/^(anthropic|amazon|meta|mistral|cohere|google|deepseek)\./, "")
    .replace(/-\d{8}(-v\d+(:\d+)?)?$/, "")
    .replace(/-v\d+:\d+$/, "");
}

/** The inference gateway's provider, title-cased for display ("bedrock" → "Bedrock"). */
function prettyProvider(name: string): string {
  const base = name.split(/[-(]/)[0] ?? name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** What the agent is FOR: authored blurb → its own instructions → a short kind gloss. */
function purposeOf(a: AgentSpec): string {
  if (a.description) return a.description;
  if (a.systemPrompt) {
    const firstLine = (a.systemPrompt.trim().split("\n")[0] ?? "").trim();
    return firstLine.length > 160 ? firstLine.slice(0, 157) + "…" : firstLine;
  }
  return a.kind ? KIND_INFO[a.kind].gloss : "";
}

/** Where the run's loop executes. claude-code is welded to Fargate; every other kind
 *  rides whichever substrates the deployment offers (the run's Substrate picker). */
function runsOn(kind: AgentKind | undefined, dep: Deployment): string {
  if (kind === "claude-code") return "Fargate (fixed)";
  const modes = dep.dispatch?.modes ?? [];
  const labels = modes.map((m) => DISPATCH_INFO[m]?.short ?? m);
  if (labels.length === 0) return dep.dispatch ? DISPATCH_INFO[dep.dispatch.default]?.short ?? dep.dispatch.default : "—";
  return labels.join(" or ");
}

/** Where the agent gets inference. claude-code runs its own headless session (subscription,
 *  not the gateway); every other kind calls the deployment's inference provider. */
function inferenceOf(a: AgentSpec, dep: Deployment): string {
  if (a.kind === "claude-code") return "Claude Code session";
  const model = a.model ?? dep.model;
  const provider = dep.inference ? ` · ${prettyProvider(dep.inference)}` : "";
  return model ? prettyModel(model) + provider : "runtime default";
}

/** The separate, labeled metadata facets shown under each agent's purpose. */
function facetsFor(a: AgentSpec, dep: Deployment): { k: string; v: string; title?: string }[] {
  const facets: { k: string; v: string; title?: string }[] = [
    { k: "inference", v: inferenceOf(a, dep), title: a.model },
    { k: "runs on", v: runsOn(a.kind, dep) },
  ];
  if (dep.sandbox && a.kind !== "claude-code") facets.push({ k: "tools run in", v: prettyProvider(dep.sandbox) + " sandbox" });
  if (a.maxSteps) facets.push({ k: "max steps", v: String(a.maxSteps) });
  facets.push({ k: "tools", v: a.tools?.length ? String(a.tools.length) : "default set" });
  return facets;
}

export function NewRunView({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [dep, setDep] = useState<Deployment>({});
  const [substrate, setSubstrate] = useState<DispatchMode | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // repo targeting applies to coding runs (ADR-0034/0046): the agent is repo-agnostic,
  // the run names the repo, the gate authorizes it. claude-code is welded to Fargate
  // (no substrate choice); coder is substrate-orthogonal — it keeps the selector.
  const kind = agents.find((a) => a.name === agent)?.kind;
  const isCodingAgent = kind === "claude-code" || kind === "coder";
  const isSubstrateWelded = kind === "claude-code";
  const dispatch = dep.dispatch;

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
      });
    // the deployment's substrates + inference — described per agent, and read by the selector
    api
      .info()
      .then(setDep)
      .catch(() => setDep({}));
  }, [api, onUnauthorized]);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRun(
        task.trim(),
        agent || undefined,
        (isCodingAgent && repo.trim()) || undefined,
        (!isSubstrateWelded && substrate) || undefined,
      );
      window.location.hash = `#/runs/${r.runId}`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      if (e instanceof ApiError && e.status === 402) setError("Budget exceeded — the gate refused this run.");
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // the default loop, then every registered agent — one card each
  const options: (AgentSpec & { isDefault?: boolean })[] = [
    { name: "", description: DEFAULT_PURPOSE, isDefault: true },
    ...agents,
  ];
  const substrateBlurb = DISPATCH_INFO[substrate || (dispatch?.default ?? "runtask")]?.blurb;

  return (
    <>
      <div className="page-head">
        <h1>New run</h1>
      </div>
      <div className="form">
        <label>
          Task
          <textarea
            rows={5}
            value={task}
            placeholder="What should the agent do?"
            onChange={(e) => setTask(e.target.value)}
            autoFocus
          />
        </label>

        <fieldset className="picker">
          <legend>Agent</legend>
          <div className="cards" role="radiogroup" aria-label="Agent">
            {options.map((a) => {
              const info = a.kind ? KIND_INFO[a.kind] : undefined;
              const purpose = purposeOf(a);
              const facets = facetsFor(a, dep);
              const selected = agent === a.name;
              return (
                <label key={a.name || "__default"} className={`card${selected ? " sel" : ""}`}>
                  <input
                    type="radio"
                    name="agent"
                    value={a.name}
                    checked={selected}
                    onChange={() => setAgent(a.name)}
                  />
                  <span className="card-head">
                    <span className="card-name">{a.isDefault ? "default loop" : a.name}</span>
                    {info && (
                      <span className={`badge ${a.kind}`} title={info.gloss}>
                        {info.label}
                      </span>
                    )}
                  </span>
                  {purpose && <span className="card-purpose">{purpose}</span>}
                  <span className="card-meta">
                    {facets.map((f) => (
                      <span className="facet" key={f.k}>
                        <span className="k">{f.k}</span>
                        <span className="v" title={f.title}>
                          {f.v}
                        </span>
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {dispatch && dispatch.modes.length > 1 && !isSubstrateWelded && (
          <label>
            Substrate{" "}
            <span className="hint">(where the run executes — claude-code agents always ride Fargate)</span>
            <select value={substrate} onChange={(e) => setSubstrate(e.target.value as DispatchMode | "")}>
              <option value="">{DISPATCH_INFO[dispatch.default]?.label ?? dispatch.default} (default)</option>
              {dispatch.modes
                .filter((m) => m !== dispatch.default)
                .map((m) => (
                  <option key={m} value={m}>
                    {DISPATCH_INFO[m]?.label ?? m}
                  </option>
                ))}
            </select>
            {substrateBlurb && <span className="hint">{substrateBlurb}</span>}
          </label>
        )}
        {isCodingAgent && (
          <label>
            Repo <span className="hint">(optional — owner/name; the run clones it and pushes a run/&lt;id&gt; branch)</span>
            <input
              type="text"
              value={repo}
              placeholder="tilsley/chart-val"
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="button" disabled={busy || !task.trim()} onClick={launch}>
            {busy ? "Launching…" : "Launch run"}
          </button>
          <span className="hint">Admission is gated: identity, then budget, then dispatch.</span>
        </div>
      </div>
    </>
  );
}
