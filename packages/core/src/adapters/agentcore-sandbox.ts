/**
 * AgentCore adapter for the SandboxProvider port (do) — a managed workspace
 * (Firecracker microVM per session). Confines the Code Interpreter tool calls
 * (executeCode / executeCommand / readFiles / writeFiles) + event-stream parsing.
 *
 * Note: the session's network mode governs egress — SANDBOX = S3-only, so
 * `git clone` from GitHub needs PUBLIC/VPC mode (and git present in the image).
 */
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  SandboxProvider,
  SandboxSession,
  CmdResult,
  RunCmdOptions,
} from "../ports";

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export class AgentCoreSandboxProvider implements SandboxProvider {
  readonly name = "agentcore";
  private client: BedrockAgentCoreClient;

  constructor(
    private interpreterId: string,
    region: string,
    endpoint?: string,
  ) {
    this.client = new BedrockAgentCoreClient({ region, endpoint });
  }

  async startSession(): Promise<SandboxSession> {
    const res = await this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.interpreterId,
        name: "agent-os",
        sessionTimeoutSeconds: 900,
      }),
    );
    const sessionId = res.sessionId!;
    const client = this.client;
    const interpreterId = this.interpreterId;

    // Invoke one Code Interpreter tool; collect text + structured result + error.
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const r = await client.send(
        new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: interpreterId,
          sessionId,
          name,
          arguments: args,
        }),
      );
      let text = "";
      let structured: any;
      let isError = false;
      for await (const event of r.stream ?? []) {
        const result = (event as any).result;
        if (!result) continue;
        if (result.isError) isError = true;
        if (result.structuredContent) structured = result.structuredContent;
        for (const item of result.content ?? []) {
          if (typeof item?.text === "string") text += item.text;
        }
      }
      return { text: text.trim(), structured, isError };
    };

    const runCmd = async (cmd: string, opts?: RunCmdOptions): Promise<CmdResult> => {
      // executeCommand only takes `command`; inline env (no timeout arg available).
      const prefix = opts?.env
        ? Object.entries(opts.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("; ") + "; "
        : "";
      const { text, structured, isError } = await invoke("executeCommand", { command: prefix + cmd });
      return {
        stdout: structured?.stdout ?? text,
        stderr: structured?.stderr ?? "",
        exitCode: typeof structured?.exitCode === "number" ? structured.exitCode : isError ? 1 : 0,
      };
    };

    return {
      id: sessionId,

      async runCode(code: string): Promise<string> {
        const { text } = await invoke("executeCode", { language: "python", code });
        return text || "(no output)";
      },

      runCmd,

      async readFile(path: string): Promise<string> {
        // The command channel is PTY-like: raw `cat` comes back with LF→CRLF and a
        // trimmed trailing newline (field-tested: it made every cloned file look
        // modified). base64 survives the terminal untouched; decode executor-side.
        const { stdout, stderr, exitCode } = await runCmd(`base64 < ${shellQuote(path)}`);
        if (exitCode !== 0) throw new Error(`readFile failed: ${path}: ${stderr || stdout}`);
        return Buffer.from(stdout.replace(/\s+/g, ""), "base64").toString("utf8");
      },

      async writeFile(path: string, content: string): Promise<void> {
        const { isError, text } = await invoke("writeFiles", { content: [{ path, text: content }] });
        if (isError) throw new Error(`writeFile failed: ${path}: ${text}`);
      },

      async writeFiles(files: { path: string; content: string }[]): Promise<void> {
        // writeFiles is natively batched — chunk to keep each invoke payload modest.
        const MAX_CHUNK_BYTES = 800_000;
        let chunk: { path: string; text: string }[] = [];
        let bytes = 0;
        const flush = async () => {
          if (!chunk.length) return;
          const { isError, text } = await invoke("writeFiles", { content: chunk });
          if (isError) throw new Error(`writeFiles failed (${chunk.length} files): ${text}`);
          chunk = [];
          bytes = 0;
        };
        for (const f of files) {
          if (bytes + f.content.length > MAX_CHUNK_BYTES) await flush();
          chunk.push({ path: f.path, text: f.content });
          bytes += f.content.length;
        }
        await flush();
      },

      async listFiles(): Promise<string[]> {
        const { stdout } = await runCmd(
          `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`,
        );
        return stdout
          .split("\n")
          .map((s) => s.replace(/^\.\//, "").trim())
          .filter(Boolean);
      },

      async fileExists(path: string): Promise<boolean> {
        const { stdout } = await runCmd(`[ -e ${shellQuote(path)} ] && echo __E__ || true`);
        return stdout.includes("__E__");
      },

      async close(): Promise<void> {
        await client
          .send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: interpreterId, sessionId }))
          .catch(() => {});
      },
    };
  }
}
