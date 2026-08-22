/**
 * agent-sandbox adapter for the SandboxProvider port (do) — a single stateful pod per
 * session via kubernetes-sigs/agent-sandbox's `Sandbox` CRD (agents.x-k8s.io/v1beta1).
 * Local k3s prototype closing the day-one gap in ADR-0003 ("Sandbox (do) -> K8s adapter
 * -> k3s"), same shape as E2BSandboxProvider; it slots behind the port unchanged.
 *
 *   SANDBOX_PROVIDER=agent-sandbox
 *   AGENT_SANDBOX_NAMESPACE=sandbox-dev (default)
 *   AGENT_SANDBOX_IMAGE=python:3.11-slim (default; needs a shell + python3)
 *   AGENT_SANDBOX_API_SERVER_URL=http://127.0.0.1:8001 (optional; a `kubectl proxy` URL —
 *     sidesteps Bun's client-cert mTLS gap (ADR-0012) for an off-cluster process talking to
 *     local k3s; in-cluster callers leave this unset and use the SA bearer token instead)
 *
 * The k8s wiring is loaded behind a tiny injected `AgentSandboxBox` shape, so the module +
 * unit tests don't need a cluster; tests inject a fake box. The real wiring lives in
 * `defaultCreate` — pod exec via `@kubernetes/client-node`'s `Exec` (WebSocket-based) is new
 * usage in this repo (other adapters here only do CR CRUD); validate it against a live
 * cluster on first real run.
 */
import * as k8s from "@kubernetes/client-node";
import { Writable } from "node:stream";
import type { SandboxProvider, SandboxSession, CmdResult, RunCmdOptions } from "../ports";

const GROUP = "agents.x-k8s.io";
const VERSION = "v1beta1";
const PLURAL = "sandboxes";
const CONTAINER = "sandbox";
const WORKDIR = "/workspace";

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The subset of a running Sandbox we use — lets tests inject a fake. */
export interface AgentSandboxBox {
  readonly name: string;
  exec(cmd: string, opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<CmdResult>;
  delete(): Promise<void>;
}

export interface AgentSandboxOptions {
  namespace?: string;
  image?: string;
  apiServerUrl?: string;
  startupTimeoutMs?: number;
  /** Injectable factory (tests pass a fake); defaults to the real cluster. */
  create?: () => Promise<AgentSandboxBox>;
}

export class AgentSandboxProvider implements SandboxProvider {
  readonly name = "agent-sandbox";
  constructor(private readonly opts: AgentSandboxOptions = {}) {}

  async startSession(): Promise<SandboxSession> {
    const box = await (this.opts.create ? this.opts.create() : defaultCreate(this.opts));
    return new AgentSandboxSession(box);
  }
}

function is404(e: any): boolean {
  return e?.code === 404 || e?.statusCode === 404 || e?.response?.statusCode === 404;
}

async function defaultCreate(opts: AgentSandboxOptions): Promise<AgentSandboxBox> {
  const kc = new k8s.KubeConfig();
  if (opts.apiServerUrl) {
    // Plain-HTTP `kubectl proxy` path — sidesteps client-cert mTLS (Bun's fetch can't do
    // it, ADR-0012). Only for off-cluster/local prototyping; in-cluster keeps loadFromDefault().
    kc.loadFromOptions({
      clusters: [{ name: "proxy", server: opts.apiServerUrl, skipTLSVerify: true }],
      users: [{ name: "anon" }],
      contexts: [{ name: "proxy", cluster: "proxy", user: "anon" }],
      currentContext: "proxy",
    });
  } else {
    kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
  }

  const namespace = opts.namespace ?? "sandbox-dev";
  const image = opts.image ?? "python:3.11-slim";
  const name = `sbx-${crypto.randomUUID().slice(0, 8)}`;

  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const execClient = new k8s.Exec(kc);

  await custom.createNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace,
    plural: PLURAL,
    body: {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "Sandbox",
      metadata: { name, namespace },
      spec: {
        podTemplate: {
          // app: sandbox — inherits charts/sandbox's default-deny-egress + DNS/proxy doors
          // once that chart is deployed alongside this (not part of this prototype).
          metadata: { labels: { app: "sandbox" } },
          spec: {
            containers: [
              {
                name: CONTAINER,
                image,
                // A dedicated workspace dir, not the container root — listFiles()/readFile()/
                // writeFile() are relative to this (ports.ts: "Relative file paths in the
                // workspace"), matching E2B/AgentCore's per-session home directory.
                command: ["sh", "-c", `mkdir -p ${WORKDIR} && exec sleep infinity`],
                workingDir: WORKDIR,
              },
            ],
          },
        },
      },
    },
  });

  await waitForPodRunning(core, namespace, name, opts.startupTimeoutMs ?? 60_000);

  const exec = async (cmd: string, o?: { env?: Record<string, string>; timeoutMs?: number }): Promise<CmdResult> => {
    const prefix = o?.env
      ? Object.entries(o.env)
          .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
          .join("; ") + "; "
      : "";
    const stdout = new BufferWritable();
    const stderr = new BufferWritable();
    let exitCode = 0;
    const ws = await execClient.exec(
      namespace,
      name,
      CONTAINER,
      ["sh", "-c", prefix + cmd],
      stdout,
      stderr,
      null,
      false,
      (status) => {
        if (status.status === "Failure") {
          const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
          exitCode = cause ? Number(cause.message) : 1;
        }
      },
    );
    await new Promise<void>((resolve, reject) => {
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });
    return { stdout: stdout.text(), stderr: stderr.text(), exitCode };
  };

  return {
    name,
    exec,
    async delete() {
      await custom.deleteNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name });
    },
  };
}

/** Buffers exec output chunks into a string — the minimal Writable the Exec API needs. */
class BufferWritable extends Writable {
  private chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.chunks.push(chunk);
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Polls the pod's phase (NOT the Sandbox CR's own condition, which upstream docs suggest
 *  tracks dependency-readiness rather than "container running" — verify on first live run).
 *  Assumes the pod shares the Sandbox's name (stable identity, per upstream docs) — verify
 *  live; fall back to a label-selector list if that assumption doesn't hold. */
async function waitForPodRunning(core: k8s.CoreV1Api, namespace: string, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pod = await core.readNamespacedPod({ name, namespace });
      if (pod.status?.phase === "Running") return;
    } catch (e) {
      if (!is404(e)) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Sandbox pod ${namespace}/${name} did not become Running within ${timeoutMs}ms`);
}

class AgentSandboxSession implements SandboxSession {
  readonly id: string;
  constructor(private readonly box: AgentSandboxBox) {
    this.id = box.name;
  }

  async runCode(code: string): Promise<string> {
    const r = await this.box.exec(`python3 -c ${shellQuote(code)}`);
    return (r.stdout + r.stderr).trim() || "(no output)";
  }

  runCmd(cmd: string, opts?: RunCmdOptions): Promise<CmdResult> {
    return this.box.exec(cmd, opts);
  }

  async readFile(path: string): Promise<string> {
    const { stdout, stderr, exitCode } = await this.box.exec(`cat -- ${shellQuote(path)}`);
    if (exitCode !== 0) throw new Error(`readFile failed: ${path}: ${stderr || stdout}`);
    return stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const { exitCode, stderr } = await this.box.exec(
      `mkdir -p ${shellQuote(dir)} && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`,
    );
    if (exitCode !== 0) throw new Error(`writeFile failed: ${path}: ${stderr}`);
  }

  async listFiles(): Promise<string[]> {
    // uniform with e2b/agentcore: list via find so node_modules/.git are excluded recursively
    const { stdout } = await this.box.exec(`find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`);
    return stdout
      .split("\n")
      .map((s) => s.replace(/^\.\//, "").trim())
      .filter(Boolean);
  }

  async fileExists(path: string): Promise<boolean> {
    const { stdout } = await this.box.exec(`[ -e ${shellQuote(path)} ] && echo __E__ || true`);
    return stdout.includes("__E__");
  }

  async close(): Promise<void> {
    await this.box.delete().catch(() => {});
  }
}
