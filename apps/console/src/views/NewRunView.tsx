import { useEffect, useState } from "react";
import { Api, ApiError, type AgentSpec, type DispatchMode } from "../api";

type AgentKind = NonNullable<AgentSpec["kind"]>;

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
const DISPATCH_INFO: Record<DispatchMode, { label: string; blurb: string }> = {
  inprocess: { label: "In-process (dev)", blurb: "Runs inside the API process — fastest, for local/dev." },
  runtask: { label: "Fargate task", blurb: "Each run gets its own AWS Fargate task — isolated, pay-per-run." },
  agentcore: { label: "AgentCore microVM", blurb: "Bedrock AgentCore — a fresh microVM per run for strong isolation." },
  agentengine: { label: "Vertex Agent Runtime (GCP)", blurb: "Runs on Google Vertex Agent Runtime." },
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

/** What the agent is FOR: authored blurb → its own instructions → a short kind gloss. */
function purposeOf(a: AgentSpec): string {
  if (a.description) return a.description;
  if (a.systemPrompt) {
    const firstLine = (a.systemPrompt.trim().split("\n")[0] ?? "").trim();
    return firstLine.length > 160 ? firstLine.slice(0, 157) + "…" : firstLine;
  }
  return a.kind ? KIND_INFO[a.kind].gloss : "";
}

/** The separate, labeled metadata facets: where it gets inference + where it runs. */
function metaFacets(a: AgentSpec, defaultSubstrate: string): { k: string; v: string; title?: string }[] {
  const facets: { k: string; v: string; title?: string }[] = [];
  if (a.model) facets.push({ k: "inference", v: prettyModel(a.model), title: a.model });
  // claude-code is welded to Fargate; everything else rides the deployment's default substrate.
  facets.push({ k: "runs on", v: a.kind === "claude-code" ? "Fargate (fixed)" : defaultSubstrate });
  if (a.maxSteps) facets.push({ k: "max steps", v: String(a.maxSteps) });
  if (a.tools?.length) facets.push({ k: "tools", v: String(a.tools.length) });
  return facets;
}

export function NewRunView({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [dispatch, setDispatch] = useState<{ default: DispatchMode; modes: DispatchMode[] } | null>(null);
  const [substrate, setSubstrate] = useState<DispatchMode | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // repo targeting applies to coding runs (ADR-0034/0046): the agent is repo-agnostic,
  // the run names the repo, the gate authorizes it. claude-code is welded to Fargate
  // (no substrate choice); coder is substrate-orthogonal — it keeps the selector.
  const kind = agents.find((a) => a.name === agent)?.kind;
  const isCodingAgent = kind === "claude-code" || kind === "coder";
  const isSubstrateWelded = kind === "claude-code";

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
      });
    // which substrates the deployment offers — hide the selector when there's no choice
    api
      .info()
      .then((i) => setDispatch(i.dispatch ?? null))
      .catch(() => setDispatch(null));
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

  // "runs on" for non-welded agents = the deployment's default substrate (per-run overridable)
  const defaultSubstrate = dispatch ? DISPATCH_INFO[dispatch.default]?.label ?? dispatch.default : "the default substrate";
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
              const facets = a.isDefault ? [{ k: "runs on", v: defaultSubstrate }] : metaFacets(a, defaultSubstrate);
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
