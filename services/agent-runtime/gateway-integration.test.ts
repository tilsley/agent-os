/**
 * Integration (Stage 2): the runtime's loop thinks THROUGH the inference gateway.
 *
 * This is the cross-boundary composition nothing else covers: the runtime is
 * wired as a gateway CLIENT (INFERENCE_GATEWAY_URL → GatewayInferenceProvider),
 * and its per-turn `generate` is forwarded — over the real wire code — to the
 * real createGatewayApp() handler. A `fetch` shim routes that one URL to the
 * in-process gateway app (no loopback HTTP, so it runs in the CI unit gate).
 *
 * Proven end to end: POST /runs → loop → GatewayInferenceProvider → fetch shim →
 * gateway handleGenerate → (scripted) think → back → sandbox tool exec → completed.
 * gwHits > 0 proves the think actually crossed the service boundary rather than
 * running in-process; the marker file proves the tool ran.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const marker = join(tmpdir(), `agent-os-gw-integ-${process.pid}.txt`);
const GW_URL = "http://gateway.internal"; // never dialed — intercepted by the shim below

// The gateway runs this script. Each /v1/generate call is one turn; the runtime
// forwards the growing message history, so step = number of tool results so far.
const TURNS: Array<{ tool: string; input: Record<string, unknown> } | { text: string }> = [
  { tool: "run_cmd", input: { cmd: `printf gw-routed > ${marker}` } },
  { text: "done — thought through the gateway" },
];
const scriptedGatewayInference = {
  name: "scripted",
  model: "scripted",
  async generate(messages: Array<{ role: string }>) {
    const step = messages.filter((m) => m.role === "tool").length;
    const t = TURNS[Math.min(step, TURNS.length - 1)]!;
    const usage = { inputTokens: 50, outputTokens: 20 };
    return "tool" in t
      ? { toolCalls: [{ id: `tc-${step}`, name: t.tool, input: t.input }], usage }
      : { text: t.text, toolCalls: [], usage };
  },
};

const ENV: Record<string, string> = {
  DISPATCH: "inprocess",
  INFERENCE_PROVIDER: "scripted", // base provider — only its model name is used; think is forwarded
  SCRIPTED_TURNS: "[]",
  SANDBOX_PROVIDER: "local",
  INFERENCE_GATEWAY_URL: GW_URL, // ⇒ the runtime becomes a gateway client (config.ts)
  TELEMETRY: "console",
};

const saved: Record<string, string | undefined> = {};
let runtimeApp: (req: Request) => Promise<Response>;
let realFetch: typeof fetch;
let gwHits = 0;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  // The real gateway handler, in-process.
  const { createGatewayApp } = await import("../inference-gateway/app");
  const gatewayApp = createGatewayApp({
    authenticator: { name: "fake", async authenticate() { return { tenant: "teama", subject: "svc", token: "tok" }; } },
    inferenceForTenant: async () => scriptedGatewayInference,
  } as any);

  // Route only the gateway URL to the in-process app; everything else passes through.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof u === "string" && u.startsWith(GW_URL)) {
      gwHits++;
      return gatewayApp(new Request(u, init));
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const { providersFromEnv } = await import("@agent-os/core");
  const { createApp } = await import("./app");
  runtimeApp = createApp(providersFromEnv());
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(marker)) rmSync(marker);
});

const post = (path: string, body: unknown) =>
  runtimeApp(new Request(`http://rt${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const get = (path: string) => runtimeApp(new Request(`http://rt${path}`));

const TERMINAL = new Set(["completed", "failed", "blocked", "max_steps", "stuck"]);
async function pollToTerminal(runId: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await get(`/runs/${runId}`).then((r) => r.json());
    if (run?.status && TERMINAL.has(run.status)) return run;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`run ${runId} did not reach a terminal status within ${timeoutMs}ms`);
}

test("the runtime's loop thinks through the inference gateway and completes", async () => {
  const res = await post("/runs", { task: "run the command via the gateway" });
  expect(res.status).toBe(202);
  const { runId } = await res.json();

  const run = await pollToTerminal(runId);

  // (1) the run completed
  expect(run.status).toBe("completed");
  expect(String(run.output)).toContain("gateway");

  // (2) the think actually crossed the service boundary — one /v1/generate call
  //     per turn (tool turn + final turn), not an in-process Bedrock call.
  expect(gwHits).toBeGreaterThanOrEqual(2);

  // (3) the tool executed in the sandbox after the gateway-routed think
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("gw-routed");
});
