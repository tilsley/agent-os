import { useEffect, useState } from "react";
import { Api, ApiError, type AgentSpec, type DispatchMode } from "../api";

type AgentKind = NonNullable<AgentSpec["kind"]>;

/** What each execution kind actually does — the fallback blurb when an agent
 *  carries no authored `description`. Keep in sync with core's AgentSpec.kind docs. */
const KIND_INFO: Record<AgentKind, { label: string; blurb: string }> = {
  loop: {
    label: "loop",
    blurb: "The platform drives the think → do → gate loop with this agent's prompt and tools.",
  },
  coder: {
    label: "coder",
    blurb:
      "A coding loop: clones the target repo into a workspace, edits it, and pushes a run/<id> branch when it finishes.",
  },
  "claude-code": {
    label: "claude-code",
    blurb:
      "One headless Claude Code session in its own Fargate task — the harness owns the whole run. Always rides Fargate.",
  },
  sandboxed: {
    label: "sandboxed",
    blurb: "A self-contained delegated agent runs inside the sandbox; its inference routes through the gateway.",
  },
};

const DEFAULT_BLURB = "No named agent — the runtime's built-in default loop with the standard toolset. A good first run.";

/** Human names + blurbs for the substrates behind the dispatch seam (ADR-0031/0042). */
const DISPATCH_INFO: Record<DispatchMode, { label: string; blurb: string }> = {
  inprocess: { label: "In-process (dev)", blurb: "Runs inside the API process — fastest, for local/dev." },
  runtask: { label: "Fargate task", blurb: "Each run gets its own AWS Fargate task — isolated, pay-per-run." },
  agentcore: { label: "AgentCore microVM", blurb: "Bedrock AgentCore — a fresh microVM per run for strong isolation." },
  agentengine: { label: "Vertex Agent Runtime (GCP)", blurb: "Runs on Google Vertex Agent Runtime." },
};

/** The picker's secondary line: the concrete, populated facts the registry returns. */
function agentMeta(a: AgentSpec): string {
  const parts: string[] = [];
  if (a.model) parts.push(a.model);
  if (a.maxSteps) parts.push(`${a.maxSteps} steps`);
  if (a.tools?.length) parts.push(`${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
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

  // the default loop, then every registered agent — one card each
  const options: (AgentSpec & { isDefault?: boolean })[] = [
    { name: "", description: DEFAULT_BLURB, isDefault: true },
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
              const blurb = a.description ?? info?.blurb ?? "";
              const meta = a.isDefault ? "" : agentMeta(a);
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
                    {info && <span className={`badge ${a.kind}`}>{info.label}</span>}
                  </span>
                  {blurb && <span className="card-blurb">{blurb}</span>}
                  {meta && <span className="card-meta">{meta}</span>}
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
