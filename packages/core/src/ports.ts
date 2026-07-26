/**
 * Ports — the provider-agnostic interfaces the agent loop depends on (ADR-0003).
 * No AWS / SDK types leak through here. Adapters (see adapters/) implement these;
 * the loop (loop.ts) imports ONLY this file.
 */

// --- neutral conversation types (no provider shapes) -------------------------
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AssistantTurn {
  text?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

// --- think: the Inference primitive port -------------------------------------
/** Per-call inference controls. `maxTokens` caps the output — the load-bearing
 *  lever for cost: it bounds the otherwise-open-ended completion cost, so a
 *  request's worst-case spend is knowable *before* the call (ADR-0013). Required,
 *  not optional: an uncapped agent turn is an unbounded bill, so the type system
 *  forces every caller to declare a ceiling. Adapters MUST honour it. */
export interface GenerateOptions {
  maxTokens: number;
}

export interface InferenceProvider {
  readonly name: string;
  readonly model: string;
  /** Given the conversation so far + available tools, produce the next turn. */
  generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn>;
}

// --- do: the Sandbox primitive port ------------------------------------------
// A session is a persistent *workspace* (mirrors janey-ops' WorkspacePort): run
// code, run shell commands, and read/write/list files. Files persist within the
// session, so an agent can clone a repo, edit it, run installs/builds, etc.
export interface CmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCmdOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxSession {
  readonly id: string;
  /** Run a Python snippet; returns combined stdout. */
  runCode(code: string): Promise<string>;
  /** Run a shell command in the workspace. */
  runCmd(cmd: string, opts?: RunCmdOptions): Promise<CmdResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Optional batch write — backends with per-call round-trip cost (AgentCore's
   *  Code Interpreter API) implement this so bulk materialization isn't N calls. */
  writeFiles?(files: { path: string; content: string }[]): Promise<void>;
  /** Relative file paths in the workspace (recursive; excludes node_modules/.git). */
  listFiles(): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  startSession(): Promise<SandboxSession>;
}

// --- guard: the content-safety Control port (ADR-0008) -----------------------
export type GuardDirection = "input" | "output";

export interface GuardVerdict {
  /** The guardrail acted (masked or blocked the content). */
  intervened: boolean;
  /** Content was blocked outright (vs. masked). */
  blocked: boolean;
  /** Text to use downstream (possibly masked / replaced). */
  text: string;
}

export interface ContentGuard {
  readonly name: string;
  /** Screen content crossing a trust boundary. `input` also covers untrusted ingress. */
  screen(text: string, direction: GuardDirection): Promise<GuardVerdict>;
}

// --- record: the Observability Control port (ADR-0003) -----------------------
// Modelled after OTel spans, but neutral: the loop never imports @opentelemetry.
// A handle lets callers attach attributes discovered *during* the operation
// (e.g. token usage known only after the call returns).
export interface TelemetrySpan {
  setAttrs(attrs: Record<string, unknown>): void;
}

export interface TelemetrySink {
  readonly name: string;
  /** Root span for one agent run. */
  run<T>(attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T>;
  /** Child span for one step (think / do / guard). Nests under the active run. */
  step<T>(name: string, attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T>;
  /** Flush any buffered/in-flight exports before process exit (ADR-0035). Optional:
   *  only sinks that hold in-flight I/O need it; short-lived executors MUST call it
   *  (bounded) or the last spans race process.exit and are lost. */
  shutdown?(): Promise<void>;
}
