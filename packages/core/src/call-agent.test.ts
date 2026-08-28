/**
 * Proves the A2A client (call_agent, ADR-0018): it discovers the target via its
 * Agent Card, invokes message/send + polls tasks/get over JSON-RPC, presents the
 * brokered OBO token in the standard Authorization header, returns the artifact text,
 * and is broker-gated (default-deny).
 */
import { test as baseTest, expect } from "bun:test";
// Integration: exercises a live loopback HTTP server (Bun.serve), unreliable on
// hermetic CI runners — this is really an integration test, not a unit test. Runs
// by default; the CI unit lane sets CI=1 so it skips there. Force with RUN_INTEGRATION=1.
const test = baseTest.skipIf(!!process.env.CI && !process.env.RUN_INTEGRATION);
import { callAgentTool } from "./tools";
import type { CredentialBroker, BrokeredCredential } from "./credentials";
import type { Principal } from "./gate";

const alice: Principal = { tenant: "support", subject: "alice@corp", token: "alice-jwt" };

// a mock A2A server: serves an Agent Card + JSON-RPC message/send / tasks/get
function mockA2A() {
  let authSeen: string | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/agent-card.json") {
        return Response.json({ name: "enrich-bot", protocolVersion: "0.3.0", url: `http://127.0.0.1:${server.port}/a2a`, securitySchemes: { bearer: { type: "http", scheme: "bearer" } } });
      }
      authSeen = req.headers.get("authorization") ?? undefined;
      const { id, method } = await req.json();
      if (method === "message/send") return Response.json({ jsonrpc: "2.0", id, result: { id: "task-1", contextId: "task-1", status: { state: "submitted" }, kind: "task" } });
      if (method === "tasks/get")
        return Response.json({ jsonrpc: "2.0", id, result: { id: "task-1", status: { state: "completed" }, artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: "filed OPS-1" }] }], kind: "task" } });
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, authSeen: () => authSeen, stop: () => server.stop(true) };
}

const broker = (grant: BrokeredCredential | null): CredentialBroker => ({
  name: "stub",
  async issue() {
    return grant;
  },
});

test("calls another agent over A2A and returns its artifact text", async () => {
  const a2a = mockA2A();
  try {
    const b = broker({ target: "enrich-bot", scheme: "bearer", token: "obo-token", baseUrl: a2a.base });
    const out = await callAgentTool(b, alice).run({ agent: "enrich-bot", task: "file the ticket" });
    expect(out).toContain("completed");
    expect(out).toContain("filed OPS-1");
    expect(a2a.authSeen()).toBe("Bearer obo-token"); // OBO token in the standard Authorization header
  } finally {
    a2a.stop();
  }
});

test("is broker-gated: no grant → default-deny, no call made", async () => {
  const out = await callAgentTool(broker(null), alice).run({ agent: "enrich-bot", task: "x" });
  expect(out).toContain("no access to agent 'enrich-bot'");
});
