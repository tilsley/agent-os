import { useEffect, useState } from "react";
import { Api, ApiError, type AgentSpec, type DispatchMode } from "../api";

type AgentKind = NonNullable<AgentSpec["kind"]>;

/** What the deployment advertises at GET /info — used to describe, per agent, where
 *  it runs and where it gets inference. */
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

/** Where the agent gets inference. claude-code runs its own headless session (subscription,
 *  not the gateway); every other kind calls the deployment's inference provider. */
function inferenceOf(a: AgentSpec, dep: Deployment): string {
  if (a.kind === "claude-code") return "Claude Code session";
  const model = a.model ?? dep.model;
  const provider = dep.inference ? ` · ${prettyProvider(dep.inference)}` : "";
  return model ? prettyModel(model) + provider : "runtime default";
}

/** Where the run's loop executes — the substrate actually chosen for this run.
 *  claude-code is welded to Fargate; everything else rides the picked substrate. */
function runsOnChosen(kind: AgentKind | undefined, mode: DispatchMode | undefined): string {
  if (kind === "claude-code") return "Fargate (fixed)";
  return (mode && DISPATCH_INFO[mode]?.short) || "Fargate";
}

/** The detail panel's labeled facts for the selected agent. */
function facetsFor(a: AgentSpec, dep: Deployment, mode: DispatchMode | undefined) {
  const facets: { k: string; v: string; run?: boolean; title?: string }[] = [
    { k: "inference", v: inferenceOf(a, dep), title: a.model },
    { k: "runs on", v: runsOnChosen(a.kind, mode), run: true },
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
  const [catalogFailed, setCatalogFailed] = useState(false);

  // repo targeting applies to coding runs (ADR-0034/0046): the agent is repo-agnostic,
  // the run names the repo, the gate authorizes it. claude-code is welded to Fargate
  // (no substrate choice); coder is substrate-orthogonal — it keeps the selector.
  const kind = agents.find((a) => a.name === agent)?.kind;
  const isCodingAgent = kind === "claude-code" || kind === "coder";
  const isSubstrateWelded = kind === "claude-code";
  const dispatch = dep.dispatch;
  // the substrate this run will actually use (welded agents ignore the picker)
  const chosenMode: DispatchMode | undefined = isSubstrateWelded ? "runtask" : substrate || dispatch?.default;

  useEffect(() => {
    api
      .listAgents()
      .then((a) => {
        setAgents(a);
        setCatalogFailed(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setCatalogFailed(true);
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
      if (e instanceof ApiError && e.status === 402)
        setError("Budget exceeded — the gate refused this run. Raise the tenant budget or wait for the next period.");
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // the default loop, then every registered agent — one row each
  const defaultOption: AgentSpec & { isDefault?: boolean } = { name: "", description: DEFAULT_PURPOSE, isDefault: true };
  const options: (AgentSpec & { isDefault?: boolean })[] = [defaultOption, ...agents];
  const selected = options.find((o) => o.name === agent) ?? defaultOption;
  const selInfo = selected.kind ? KIND_INFO[selected.kind] : undefined;
  const selName = selected.isDefault ? "default loop" : selected.name;

  return (
    <>
      <div className="page-head">
        <h1>New run</h1>
        <span className="sub">gated: identity → budget → dispatch</span>
      </div>
      <div className="form">
        <label>
          Task
          <textarea
            name="task"
            rows={4}
            value={task}
            placeholder="What should the agent do?"
            autoComplete="off"
            onChange={(e) => setTask(e.target.value)}
            autoFocus
          />
        </label>

        <fieldset className="picker">
          <legend>Agent</legend>
          {catalogFailed && (
            <p className="hint">Couldn't load the agent catalog — showing the default loop only. Retry by reloading.</p>
          )}
          <div className="two-pane">
            <div className="agent-list" role="radiogroup" aria-label="Agent">
              {options.map((a) => {
                const info = a.kind ? KIND_INFO[a.kind] : undefined;
                const isSel = agent === a.name;
                return (
                  <label key={a.name || "__default"} className={`arow${isSel ? " sel" : ""}`}>
                    <input
                      type="radio"
                      name="agent"
                      value={a.name}
                      checked={isSel}
                      onChange={() => setAgent(a.name)}
                    />
                    <span className="an">
                      <span className="aname">{a.isDefault ? "default loop" : a.name}</span>
                      {info && <span className={`badge ${a.kind}`}>{info.label}</span>}
                    </span>
                    <span className="ap">{purposeOf(a)}</span>
                  </label>
                );
              })}
            </div>

            <div className="agent-detail" aria-live="polite">
              <div className="dh">
                <span className="dname">{selName}</span>
                {selInfo && <span className={`badge ${selected.kind}`}>{selInfo.label}</span>}
              </div>
              <p className="dp">{purposeOf(selected)}</p>
              <div className="facets">
                {facetsFor(selected, dep, chosenMode).map((f) => (
                  <div className="facet" key={f.k}>
                    <span className="k">{f.k}</span>
                    <span className={`v${f.run ? " run" : ""}`} title={f.title}>
                      {f.v}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </fieldset>

        <div className="where">
          <div className="gh">Where it runs</div>
          <div className="cols">
            {isSubstrateWelded ? (
              <label>
                Substrate
                <div className="welded">Fargate — fixed</div>
                <span className="hint">claude-code always rides Fargate.</span>
              </label>
            ) : dispatch && dispatch.modes.length > 1 ? (
              <label>
                Substrate
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
              </label>
            ) : (
              <label>
                Substrate
                <div className="welded">{runsOnChosen(kind, chosenMode)}</div>
              </label>
            )}

            {isCodingAgent ? (
              <label>
                Repo <span className="hint">(optional — owner/name)</span>
                <input
                  type="text"
                  name="repo"
                  value={repo}
                  placeholder="tilsley/chart-val"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setRepo(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Repo
                <div className="welded off">— not used by this agent</div>
              </label>
            )}
          </div>
        </div>

        <div className="summary">
          <span className="dot" />
          <span className="s-agent">{selName}</span>
          <span className="s-arr">→</span>
          <span>{runsOnChosen(selected.kind, chosenMode)}</span>
          <span className="s-muted">· {inferenceOf(selected, dep)}</span>
          {isCodingAgent && <span className="s-muted">· {repo.trim() || "repo optional"}</span>}
        </div>

        {/* persistent SR live region (absolute → no layout gap) + the visible error */}
        <div className="sr-only" aria-live="polite">{error ?? ""}</div>
        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button className="button go" disabled={busy || !task.trim()} onClick={launch}>
            {busy ? "Launching…" : "Launch run"}
          </button>
          <span className="hint">Admission checks identity, then budget, then dispatch.</span>
        </div>
      </div>
    </>
  );
}
