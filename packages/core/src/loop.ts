/**
 * The L1 agent loop — depends ONLY on the ports + tools (ADR-0003). Multi-tool:
 * the model gets a set of tools (default run_code; or the full workspace via
 * `workspaceTools`) and the loop dispatches calls until it's done.
 *
 * - runOnSession: the loop over a session the CALLER owns (so it can set the
 *   workspace up first — clone/bump — and inspect it after — diff).
 * - runAgent: convenience wrapper that owns the session (start + close).
 */
import type {
  InferenceProvider,
  SandboxProvider,
  SandboxSession,
  ContentGuard,
  TelemetrySink,
  Message,
  ToolResult,
  TokenUsage,
} from "./ports";
import { runCodeTool, type AgentTool } from "./tools";

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

/** Default per-turn output cap. Every turn is bounded so completion cost can't run
 *  away (ADR-0013); callers override per-agent/per-run via `maxOutputTokens`. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface RunResult {
  runId: string;
  status: "completed" | "blocked" | "max_steps" | "stuck";
  output?: string;
  /** Token usage accumulated across the run — gate budget accounting (ADR-0009). */
  usage?: TokenUsage;
}

export interface RunOnSessionOpts {
  inference: InferenceProvider;
  guard: ContentGuard;
  telemetry: TelemetrySink;
  session: SandboxSession;
  task: string;
  systemPrompt?: string;
  tools?: (session: SandboxSession) => AgentTool[];
  maxSteps?: number;
  /** Output-token cap per turn (ADR-0013). Defaults to DEFAULT_MAX_OUTPUT_TOKENS;
   *  the admission decorator (step 2) reads this to price a request's worst case. */
  maxOutputTokens?: number;
  /** Called after each turn with the conversation so far — the runtime persists
   *  it to the RunStore, making run state durable + inspectable mid-flight. */
  onProgress?: (messages: Message[]) => void | Promise<void>;
}

export interface RunOpts extends Omit<RunOnSessionOpts, "session"> {
  sandbox: SandboxProvider;
}

/** Run the agent loop over a session the caller manages. */
export async function runOnSession(opts: RunOnSessionOpts): Promise<RunResult> {
  const { inference, guard, telemetry, session, task, systemPrompt, maxSteps = 20 } = opts;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const tools = (opts.tools ?? ((s) => [runCodeTool(s)]))(session);
  const toolDefs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const runId = crypto.randomUUID();
  console.log(`▶ inference=${inference.name}  guard=${guard.name}  record=${telemetry.name}  session=${session.id}`);
  console.log(`▶ task: ${truncate(task, 200)}\n`);

  return telemetry.run({ "run.id": runId, "agent.task": truncate(task, 500) }, async (): Promise<RunResult> => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const inputCheck = await telemetry.step("guard.screen", { "guard.direction": "input" }, async (span) => {
      const v = await guard.screen(task, "input");
      span.setAttrs({ "guard.intervened": v.intervened, "guard.blocked": v.blocked });
      return v;
    });
    if (inputCheck.blocked) {
      console.log("🛡 guard blocked the input — aborting");
      return { runId, status: "blocked", usage };
    }

    const opening = systemPrompt ? `${systemPrompt}\n\n${inputCheck.text}` : inputCheck.text;
    const messages: Message[] = [{ role: "user", text: opening }];
    let lastSig = ""; // no-progress guard: identical tool calls two turns running = stuck

    for (let step = 1; step <= maxSteps; step++) {
      const turn = await telemetry.step(
        "inference.generate",
        { "gen_ai.system": inference.name, "gen_ai.request.model": inference.model, "gen_ai.request.max_tokens": maxOutputTokens },
        async (span) => {
          const t = await inference.generate(messages, toolDefs, { maxTokens: maxOutputTokens }); // think
          span.setAttrs({
            "gen_ai.usage.input_tokens": t.usage?.inputTokens,
            "gen_ai.usage.output_tokens": t.usage?.outputTokens,
            "gen_ai.tool_calls": t.toolCalls.length,
          });
          return t;
        },
      );
      usage.inputTokens! += turn.usage?.inputTokens ?? 0;
      usage.outputTokens! += turn.usage?.outputTokens ?? 0;
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
      await opts.onProgress?.(messages);
      if (turn.text) console.log(`🧠 ${turn.text}`);

      if (turn.toolCalls.length === 0) {
        console.log("\n✅ done");
        return { runId, status: "completed", output: turn.text, usage };
      }

      // no-progress guard: if the model proposes the exact same tool calls as the
      // previous turn, it's looping — stop rather than burn the whole step budget.
      const sig = JSON.stringify(turn.toolCalls.map((c) => [c.name, c.input]));
      if (sig === lastSig) {
        console.log("\n⚠ no progress — identical tool calls repeated; stopping (stuck)");
        return { runId, status: "stuck", output: turn.text, usage };
      }
      lastSig = sig;

      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        const tool = byName.get(call.name);
        console.log(`\n🛠  ${call.name} ${truncate(JSON.stringify(call.input), 300)}`);

        // A failing tool is feedback for the model, not a run-fatal crash — return
        // the error as the tool result so it can correct course (field-tested: an
        // absolute-path read_file guess used to kill the whole run).
        let output = tool
          ? await telemetry
              .step(`tool.${call.name}`, { "tool.name": call.name }, () => tool.run(call.input)) // do
              .catch((e: any) => `error: ${e?.message ?? String(e)}`)
          : `error: unknown tool "${call.name}"`;

        const verdict = await telemetry.step("guard.screen", { "guard.direction": "output" }, async (span) => {
          const v = await guard.screen(output, "input"); // untrusted ingress
          span.setAttrs({ "guard.intervened": v.intervened });
          return v;
        });
        if (verdict.intervened) {
          console.log("🛡 guard intervened on tool output");
          output = verdict.text;
        }

        console.log(`📤 ${truncate(output, 1000)}\n`);
        results.push({ toolCallId: call.id, output });
      }
      messages.push({ role: "tool", results });
    }
    console.log("\n⚠ hit step limit");
    return { runId, status: "max_steps", usage };
  });
}

/** Convenience: start a session, run the loop, close it. */
export async function runAgent(opts: RunOpts): Promise<RunResult> {
  const { sandbox, telemetry } = opts;
  const session = await telemetry.step("sandbox.start", {}, () => sandbox.startSession());
  console.log(`✓ sandbox session: ${session.id}`);
  try {
    return await runOnSession({ ...opts, session });
  } finally {
    await telemetry.step("sandbox.stop", {}, () => session.close());
    console.log(`✓ session stopped: ${session.id}`);
  }
}
