/**
 * Proves the agentcore dispatch seam (ADR-0042): a loop run becomes ONE
 * InvokeAgentRuntime session (runtimeSessionId = run.id, over the 33-char floor);
 * kind="claude-code" routes to the Fargate fallback (the lane that can't lean in);
 * and a dispatch failure — including cc-without-fallback — marks the run failed
 * (terminal, visible to the poller) instead of rotting in `queued`.
 */
import { test, expect } from "bun:test";
import type { Run } from "@agent-os/core";
import { agentCoreDispatch, agentCoreConfigFromEnv, type AgentCoreDispatchConfig } from "./dispatch";

const config: AgentCoreDispatchConfig = { runtimeArn: "arn:aws:bedrock-agentcore:eu-west-2:1:runtime/x", region: "eu-west-2" };

const makeRun = (agent?: string): Run =>
  ({ id: crypto.randomUUID(), status: "queued", task: "t", agent, principal: { tenant: "teama" }, messages: [], createdAt: "", updatedAt: "" }) as unknown as Run;

function harness(opts: { kind?: string; sendError?: Error } = {}) {
  const sent: any[] = [];
  const updates: any[] = [];
  const client = {
    send: async (cmd: any) => {
      if (opts.sendError) throw opts.sendError;
      sent.push(cmd.input);
      return { statusCode: 202 };
    },
  } as any;
  const runStore = {
    name: "memory",
    get: async () => undefined, // still queued from the dispatcher's viewpoint
    update: async (id: string, patch: any) => void updates.push({ id, ...patch }),
  } as any;
  const registry = { get: async () => (opts.kind ? { name: "a", kind: opts.kind } : undefined) } as any;
  return { client, runStore, registry, sent, updates };
}

const settle = () => new Promise((r) => setTimeout(r, 10)); // dispatch is fire-and-forget

test("loop run → one InvokeAgentRuntime session keyed by the run id", async () => {
  const h = harness({ kind: "loop" });
  agentCoreDispatch(config, h.runStore, h.registry, undefined, h.client)(makeRun("scribe"));
  await settle();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].agentRuntimeArn).toBe(config.runtimeArn);
  expect(h.sent[0].runtimeSessionId).toHaveLength(36); // UUID ≥ Runtime's 33-char session floor
  expect(JSON.parse(new TextDecoder().decode(h.sent[0].payload)).runId).toBe(h.sent[0].runtimeSessionId);
  expect(h.updates).toHaveLength(0);
});

test("claude-code run routes to the Fargate fallback, never to AgentCore", async () => {
  const h = harness({ kind: "claude-code" });
  const fallbackRuns: string[] = [];
  agentCoreDispatch(config, h.runStore, h.registry, (r) => void fallbackRuns.push(r.id), h.client)(makeRun("coder"));
  await settle();
  expect(fallbackRuns).toHaveLength(1);
  expect(h.sent).toHaveLength(0);
});

test("claude-code without a fallback fails the run terminally", async () => {
  const h = harness({ kind: "claude-code" });
  agentCoreDispatch(config, h.runStore, h.registry, undefined, h.client)(makeRun("coder"));
  await settle();
  expect(h.sent).toHaveLength(0);
  expect(h.updates[0]?.status).toBe("failed");
  expect(h.updates[0]?.error).toContain("claude-code");
});

test("an InvokeAgentRuntime failure marks the run failed", async () => {
  const h = harness({ kind: "loop", sendError: new Error("boom") });
  agentCoreDispatch(config, h.runStore, h.registry, undefined, h.client)(makeRun("scribe"));
  await settle();
  expect(h.updates[0]?.status).toBe("failed");
  expect(h.updates[0]?.error).toContain("boom");
});

test("a lost invocation response does NOT fail a run that was already claimed", async () => {
  // the invocation now spans the whole run — a dropped client connection is normal
  const h = harness({ kind: "loop", sendError: new Error("socket hang up") });
  h.runStore.get = async () => ({ id: "r", status: "running" });
  agentCoreDispatch(config, h.runStore, h.registry, undefined, h.client)(makeRun("scribe"));
  await settle();
  expect(h.updates).toHaveLength(0);
});

test("config comes from AGENTCORE_RUNTIME_ARN and fails closed without it", () => {
  expect(() => agentCoreConfigFromEnv({})).toThrow("AGENTCORE_RUNTIME_ARN");
  const c = agentCoreConfigFromEnv({ AGENTCORE_RUNTIME_ARN: "arn:x", AGENTCORE_QUALIFIER: "prod", REGION: "eu-west-2" });
  expect(c).toEqual({ runtimeArn: "arn:x", qualifier: "prod", region: "eu-west-2" });
});
