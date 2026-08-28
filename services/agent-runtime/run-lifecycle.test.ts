/**
 * Integration (Stage 2): the full run lifecycle, in-process and hermetic.
 *
 * Drives the REAL provider wiring — providersFromEnv() (config.ts DI) → createApp()
 * — with the local test bundle (scripted inference + local sandbox + in-memory
 * store, dispatched inprocess), then POST /runs and polls to completion. This
 * exercises the whole composition end to end: gate → dispatch → in-process worker
 * → loop → scripted think → sandbox tool exec → run store → terminal status.
 *
 * No network, no cloud, no loopback HTTP — so it runs in the CI unit gate.
 * The scripted run writes a marker file via run_cmd; its presence on disk is
 * proof the loop actually executed the tool through the sandbox (not just that
 * the request was accepted).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A host path the sandbox writes to; its content proves the tool ran. pid keeps
// it unique without Date/Math.random. Cleaned up in afterAll.
const marker = join(tmpdir(), `agent-os-run-lifecycle-${process.pid}.txt`);

// The model calls run_cmd once (executed by the local sandbox), then finalizes.
// ScriptedInferenceProvider advances by the number of tool results seen so far.
const SCRIPTED_TURNS = JSON.stringify([
  { tool: "run_cmd", input: { cmd: `printf integration-ok > ${marker}` } },
  { text: "done — the command ran in the sandbox" },
]);

// Env bundle = the local `make run` shape + scripted inference. Set BEFORE
// providersFromEnv() reads it; restored afterward so other test files are unaffected.
const ENV: Record<string, string> = {
  DISPATCH: "inprocess",
  INFERENCE_PROVIDER: "scripted",
  SCRIPTED_TURNS,
  SANDBOX_PROVIDER: "local",
  TELEMETRY: "console",
};
const saved: Record<string, string | undefined> = {};
let app: (req: Request) => Promise<Response>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { providersFromEnv } = await import("@agent-os/core");
  const { createApp } = await import("./app");
  app = createApp(providersFromEnv());
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(marker)) rmSync(marker);
});

const post = (path: string, body: unknown) =>
  app(new Request(`http://rt${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const get = (path: string) => app(new Request(`http://rt${path}`));

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

test("POST /runs drives think → sandbox tool exec → completed, end to end", async () => {
  const res = await post("/runs", { task: "run the command and finish" });
  expect(res.status).toBe(202);
  const { runId, status } = await res.json();
  expect(typeof runId).toBe("string");
  expect(status).toBeDefined(); // accepted, not yet terminal

  const run = await pollToTerminal(runId);

  // (1) the loop reached the scripted final turn
  expect(run.status).toBe("completed");
  expect(String(run.output)).toContain("done");

  // (2) the sandbox actually executed the tool — the marker file exists with the
  //     exact stdout the run_cmd wrote. This is the end-to-end proof.
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("integration-ok");

  // (3) usage was metered across the turns (scripted emits 50 in / 20 out per turn)
  expect(run.usage?.inputTokens).toBeGreaterThan(0);
  expect(run.usage?.outputTokens).toBeGreaterThan(0);
});

test("GET /runs/{id} 404s for an unknown run", async () => {
  const res = await get("/runs/does-not-exist");
  expect(res.status).toBe(404);
});
