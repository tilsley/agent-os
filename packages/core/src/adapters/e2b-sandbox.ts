/**
 * E2B adapter for the SandboxProvider port (do) — a remote Firecracker microVM per
 * session (E2B's sandbox-as-a-service). Same shape as AgentCoreSandboxProvider; it
 * slots behind the port unchanged (ADR-0019). This is the `do` execution surface — it
 * holds NO model creds; inference still goes to the gateway.
 *
 *   SANDBOX_PROVIDER=e2b   E2B_API_KEY=...   E2B_TEMPLATE=base (optional)
 *
 * The E2B SDK is loaded lazily (dynamic import) and behind a tiny injected `E2BBox`
 * shape, so the module + unit tests don't need the SDK or an API key; tests inject a
 * fake box. The real wiring lives in `defaultCreate` — validate it against the
 * installed @e2b/code-interpreter version on first live run.
 */
import type { SandboxProvider, SandboxSession, CmdResult, RunCmdOptions } from "../ports";

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The subset of the E2B Sandbox we use — lets tests inject a fake. */
export interface E2BBox {
  readonly sandboxId: string;
  runCode(code: string): Promise<{ logs?: { stdout?: string[]; stderr?: string[] }; text?: string }>;
  commands: { run(cmd: string, opts?: { envs?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> };
  files: { read(path: string): Promise<string>; write(path: string, data: string): Promise<unknown> };
  kill(): Promise<unknown>;
}

export interface E2BOptions {
  apiKey?: string;
  template?: string;
  timeoutMs?: number;
  /** Injectable factory (tests pass a fake); defaults to the real E2B SDK. */
  create?: () => Promise<E2BBox>;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";
  constructor(private readonly opts: E2BOptions = {}) {}

  async startSession(): Promise<SandboxSession> {
    const box = await (this.opts.create ? this.opts.create() : defaultCreate(this.opts));
    return new E2BSession(box);
  }
}

async function defaultCreate(opts: E2BOptions): Promise<E2BBox> {
  const { Sandbox } = (await import("@e2b/code-interpreter")) as any;
  return createWith(Sandbox, opts);
}

/** The E2B `Sandbox` surface we call — just the `create` factory. */
type E2BSandboxCtor = { create: (...args: any[]) => Promise<E2BBox> };

/**
 * Build a sandbox from the injected E2B `Sandbox` factory. Exported as the test seam that
 * pins E2B's calling convention: `create` takes the template as the FIRST POSITIONAL
 * argument — `create(template, opts)`. `template` is NOT a field of SandboxOpts, so passing
 * it inside the options object is silently dropped and the account-DEFAULT image is used
 * (verified live: our agent-os-coder toolchain went missing — no Gradle, wrong Go — until
 * this was made positional). Only the remaining knobs go in the opts object.
 */
export function createWith(Sandbox: E2BSandboxCtor, opts: E2BOptions): Promise<E2BBox> {
  const sandboxOpts = {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return opts.template ? Sandbox.create(opts.template, sandboxOpts) : Sandbox.create(sandboxOpts);
}

class E2BSession implements SandboxSession {
  readonly id: string;
  constructor(private readonly box: E2BBox) {
    this.id = box.sandboxId;
  }

  async runCode(code: string): Promise<string> {
    const exec = await this.box.runCode(code);
    const out = [...(exec.logs?.stdout ?? []), exec.text ?? ""].filter(Boolean).join("\n");
    return out || "(no output)";
  }

  async runCmd(cmd: string, opts?: RunCmdOptions): Promise<CmdResult> {
    const r = await this.box.commands.run(cmd, { ...(opts?.env ? { envs: opts.env } : {}), ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  readFile(path: string): Promise<string> {
    return this.box.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.box.files.write(path, content);
  }

  async listFiles(): Promise<string[]> {
    // uniform with AgentCore: list via find so node_modules/.git are excluded recursively
    const { stdout } = await this.runCmd(`find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`);
    return stdout.split("\n").map((s) => s.replace(/^\.\//, "").trim()).filter(Boolean);
  }

  async fileExists(path: string): Promise<boolean> {
    const { stdout } = await this.runCmd(`[ -e ${shellQuote(path)} ] && echo __E__ || true`);
    return stdout.includes("__E__");
  }

  async close(): Promise<void> {
    await this.box.kill().catch(() => {});
  }
}
